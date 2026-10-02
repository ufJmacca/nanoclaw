import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
vi.mock('../store/preflight.js', () => ({ connectChecked: vi.fn() }));
vi.mock('../store/config.js', () => ({ parseDatabaseConfig: vi.fn(() => ({})) }));
vi.mock('./target-identity.js', () => ({ databaseFingerprint: vi.fn(async () => 'f'.repeat(64)) }));
vi.mock('../store/migrations.js', () => ({ SCHEMA_VERSION: 9, migrationStatus: vi.fn(async () => 9) }));
vi.mock('../missions/template-admin.js', () => ({
  installReviewedMissionTemplate: vi.fn(async () => {}),
  installReviewedTeamTemplates: vi.fn(async () => {}),
}));
import { connectChecked } from '../store/preflight.js';
import { databaseFingerprint } from './target-identity.js';
import { installReviewedMissionTemplate, installReviewedTeamTemplates } from '../missions/template-admin.js';
import { runMissionAdmin, parseMissionArguments } from './mission-admin.js';
import { digest } from '../domain/contracts.js';
import { RESEARCH_TEMPLATE } from '../missions/work-order.js';
import { readDelegation } from '../missions/delegation.js';
import { readTeamAdmission, TEAM_ADMISSION_POLICY } from '../missions/team-admission.js';
import { TEAM_TEMPLATES } from '../contracts/team-templates.js';
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mission-admin-'));
  roots.push(root);
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    agentGroupId: 'main',
    sessionId: 'main',
    messagingGroupId: 'mg',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
  };
  const manifestFile = path.join(root, 'input.json');
  fs.writeFileSync(
    manifestFile,
    JSON.stringify({
      expectedRevision: 0,
      enabled: true,
      templateDigest: digest(RESEARCH_TEMPLATE),
      reviewRef: 'fixture-reviewed-template',
    }),
    { mode: 0o600 },
  );
  const args = { command: 'mission-configure' as const, scopeId: 'scope', requestId: randomUUID(), manifestFile };
  const options = {
    args,
    env: {},
    root,
    binding,
    databaseFingerprint: 'f'.repeat(64),
    check: vi.fn(async () => {}),
    assertAuthority: vi.fn(),
  };
  const client = { query: vi.fn(async (_sql: string) => ({ rows: [{ locked: true }] })), end: vi.fn(async () => {}) };
  vi.mocked(connectChecked).mockResolvedValue(client as never);
  return { ...options, options, client };
}
it('S05-T03 only exact owner CLI arguments can select mission configuration', () => {
  const id = randomUUID(),
    args = ['mission-configure', '--scope', 'scope', '--request-id', id, '--manifest', '/private/config.json'];
  expect(parseMissionArguments(args)).toEqual({
    command: 'mission-configure',
    scopeId: 'scope',
    requestId: id,
    manifestFile: '/private/config.json',
  });
  for (const bad of [
    args.slice(0, -2),
    [...args, '--enable', 'true'],
    [...args, '--scope', 'other'],
    [...args.slice(0, -1), '../config'],
    ['mission-configure', '--scope', '../other'],
  ])
    expect(() => parseMissionArguments(bad)).toThrow('invalid_admin_arguments');
});
it('S05-T03 installs reviewed template before saving one replayable paused configuration', async () => {
  const f = fixture();
  const result = await runMissionAdmin(f.options);
  expect(result).toMatchObject({ status: 'configured_paused', revision: 1, enabled: true, live_model: 'not_invoked' });
  expect(connectChecked).toHaveBeenCalledWith(f.env, 'runtime', 'migration');
  expect(installReviewedMissionTemplate).toHaveBeenCalledTimes(1);
  expect(f.client.query.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
  expect(readDelegation(f.root, f.binding)?.revision).toBe(1);
  expect(await runMissionAdmin(f.options)).toEqual(result);
  expect(fs.existsSync(path.join(f.root, 'model-activation.json'))).toBe(false);
  expect(f.client.end).toHaveBeenCalledTimes(2);
});
it('S05-T03 wrong database identity cannot install or enable missions', async () => {
  const f = fixture();
  vi.mocked(databaseFingerprint).mockResolvedValueOnce('e'.repeat(64));
  await expect(runMissionAdmin(f.options)).rejects.toThrow('mission_database_mismatch');
  expect(installReviewedMissionTemplate).not.toHaveBeenCalled();
  expect(readDelegation(f.root, f.binding)).toBeNull();
  expect(f.client.end).toHaveBeenCalled();
});
it('S05-T03 lost commit acknowledgement cannot publish a delegation grant', async () => {
  const f = fixture();
  f.client.query.mockImplementation(async (sql: string) => {
    if (sql === 'COMMIT') throw Error('fixture_lost_ack');
    return { rows: [{ locked: true }] };
  });
  await expect(runMissionAdmin(f.options)).rejects.toThrow('fixture_lost_ack');
  expect(readDelegation(f.root, f.binding)).toBeNull();
  expect(f.client.end).toHaveBeenCalled();
  f.client.query.mockResolvedValue({ rows: [{ locked: true }] });
  expect(await runMissionAdmin(f.options)).toMatchObject({ revision: 1 });
});
it('S05-T03 lost host authority after template installation leaves configuration closed', async () => {
  const f = fixture();
  vi.mocked(installReviewedMissionTemplate).mockImplementationOnce(async () => {
    f.options.check.mockRejectedValue(Error('host_execution_authority_lost'));
  });
  await expect(runMissionAdmin(f.options)).rejects.toThrow('host_execution_authority_lost');
  expect(readDelegation(f.root, f.binding)).toBeNull();
  expect(f.client.end).toHaveBeenCalled();
});
function teamFixture() {
  const t = fixture();
  const change = {
    expectedRevision: 0,
    enabled: true,
    templateBundleDigest: digest(TEAM_TEMPLATES),
    policyDigest: digest(TEAM_ADMISSION_POLICY),
    reviewRef: 'fixture-reviewed-team',
  };
  fs.writeFileSync(t.args.manifestFile, JSON.stringify(change));
  const options = { ...t.options, args: { ...t.args, command: 'team-configure' as const } };
  return { ...t, options, change };
}
it('S06-T01 exact team owner arguments do not expand the original operator command', () => {
  const requestId = randomUUID();
  const args = ['team-configure', '--scope', 'scope', '--request-id', requestId, '--manifest', '/private/team.json'];
  expect(parseMissionArguments(args)).toEqual({
    command: 'team-configure',
    scopeId: 'scope',
    requestId,
    manifestFile: '/private/team.json',
  });
  for (const bad of [
    args.slice(0, -2),
    [...args, '--enable', 'true'],
    [...args, '--scope', 'other'],
    [...args.slice(0, -1), 'relative.json'],
    ['team-configure', '--scope', '../other'],
  ])
    expect(() => parseMissionArguments(bad)).toThrow('invalid_admin_arguments');
});
it('S06-T01/T05 installs the full reviewed bundle before recording separate paused team permission', async () => {
  const t = teamFixture();
  const result = await runMissionAdmin(t.options);
  expect(result).toEqual({
    status: 'configured_paused',
    scope_id: t.binding.scopeId,
    revision: 1,
    enabled: true,
    template_bundle_digest: digest(TEAM_TEMPLATES),
    policy_digest: digest(TEAM_ADMISSION_POLICY),
    live_model: 'not_invoked',
  });
  expect(installReviewedTeamTemplates).toHaveBeenCalledWith(t.client, t.binding, t.args.requestId, t.change);
  expect(installReviewedMissionTemplate).not.toHaveBeenCalled();
  expect(readTeamAdmission(t.root, t.binding)?.revision).toBe(1);
  expect(readDelegation(t.root, t.binding)).toBeNull();
  expect(await runMissionAdmin(t.options)).toEqual(result);
  expect(fs.existsSync(path.join(t.root, 'model-activation.json'))).toBe(false);
  expect(t.client.end).toHaveBeenCalledTimes(2);
});
it.each(['database', 'install', 'commit', 'host'])(
  'S06-T01/T05 %s failure cannot publish team permission',
  async (kind) => {
    const t = teamFixture();
    if (kind === 'database') vi.mocked(databaseFingerprint).mockResolvedValueOnce('e'.repeat(64));
    if (kind === 'install')
      vi.mocked(installReviewedTeamTemplates).mockRejectedValueOnce(Error('team_template_conflict'));
    if (kind === 'commit')
      t.client.query.mockImplementation(async (sql) => {
        if (sql === 'COMMIT') throw Error('fixture_lost_ack');
        return { rows: [{ locked: true }] };
      });
    if (kind === 'host')
      vi.mocked(installReviewedTeamTemplates).mockImplementationOnce(async () => {
        t.options.check.mockRejectedValue(Error('host_execution_authority_lost'));
      });
    await expect(runMissionAdmin(t.options)).rejects.toThrow();
    expect(readTeamAdmission(t.root, t.binding)).toBeNull();
    expect(t.client.end).toHaveBeenCalled();
  },
);
