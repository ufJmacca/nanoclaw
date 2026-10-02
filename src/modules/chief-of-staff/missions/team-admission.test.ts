import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { TEAM_TEMPLATES } from '../contracts/team-templates.js';
import { RESEARCH_TEMPLATE } from './work-order.js';
import { configureDelegation, readDelegation } from './delegation.js';
import {
  TEAM_ADMISSION_POLICY,
  configureTeamAdmission,
  readTeamAdmission,
  parseTeamAdmissionChange,
} from './team-admission.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-team-admission-'));
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
  const change = {
    expectedRevision: 0,
    enabled: true,
    templateBundleDigest: digest(TEAM_TEMPLATES),
    policyDigest: digest(TEAM_ADMISSION_POLICY),
    reviewRef: 'fixture-reviewed-bounded-team',
  };
  return { root, binding, change, file: path.join(root, 'team-admission-' + digest(binding.scopeId) + '.json') };
}
it('S06-T01/T10 single-worker admission never enables teams and exact team configuration replays one owner revision', () => {
  const f = fixture();
  configureDelegation(f.root, f.binding, randomUUID(), {
    expectedRevision: 0,
    enabled: true,
    templateDigest: digest(RESEARCH_TEMPLATE),
    reviewRef: 'fixture-reviewed-single',
  });
  expect(readTeamAdmission(f.root, f.binding)).toBeNull();
  const requestId = randomUUID(),
    record = configureTeamAdmission(f.root, f.binding, requestId, f.change);
  expect(record).toMatchObject({
    contract: 'cos-team-admission/v1',
    revision: 1,
    enabled: true,
    ownerId: 'owner',
    bindingDigest: digest(f.binding),
    templateBundleDigest: digest(TEAM_TEMPLATES),
    policyDigest: digest(TEAM_ADMISSION_POLICY),
  });
  expect(configureTeamAdmission(f.root, f.binding, requestId, f.change)).toEqual(record);
  expect(readTeamAdmission(f.root, f.binding)).toEqual(record);
  expect(readTeamAdmission(f.root, { ...f.binding, channelId: 'foreign' })).toBeNull();
  expect(() => configureTeamAdmission(f.root, f.binding, requestId, { ...f.change, enabled: false })).toThrow(
    'team_configuration_conflict',
  );
  expect(() => configureTeamAdmission(f.root, f.binding, randomUUID(), f.change)).toThrow(
    'team_configuration_conflict',
  );
  expect(
    configureTeamAdmission(f.root, f.binding, randomUUID(), { ...f.change, expectedRevision: 1, enabled: false }),
  ).toMatchObject({ revision: 2, enabled: false });
  expect(readDelegation(f.root, f.binding)?.enabled).toBe(true);
});
it.each([
  { templateBundleDigest: 'a'.repeat(64) },
  { policyDigest: 'b'.repeat(64) },
  { publicRetrieval: true },
  { maxSteps: 20 },
  { specialistHistory: 'unrelated' },
  { enabled: 'yes' },
  { expectedRevision: -1 },
])('S06-T01/T05 rejects unreviewed templates or expanded team configuration %j', (patch) => {
  expect(() => parseTeamAdmissionChange({ ...fixture().change, ...patch })).toThrow('invalid_team_configuration');
});
it('S06-T01/T09 pins disabled public retrieval and original-budget rework in the reviewed policy', () => {
  expect(TEAM_ADMISSION_POLICY).toMatchObject({
    maxSteps: 6,
    maxWorkers: 2,
    publicRetrieval: false,
    mainContext: 'retained',
    rework: 'approved_original_limits',
  });
  expect(Object.isFrozen(TEAM_ADMISSION_POLICY)).toBe(true);
});
it.each(['symlink', 'hardlink', 'directory', 'pipe', 'permissions', 'oversized', 'changed'])(
  'S06-T05 unsafe %s state cannot grant or replace team admission',
  (kind) => {
    const f = fixture();
    if (['hardlink', 'permissions', 'changed'].includes(kind))
      configureTeamAdmission(f.root, f.binding, randomUUID(), f.change);
    if (kind === 'symlink') fs.symlinkSync('missing.json', f.file);
    if (kind === 'hardlink') fs.linkSync(f.file, path.join(f.root, 'alias.json'));
    if (kind === 'directory') fs.mkdirSync(f.file, { mode: 0o700 });
    if (kind === 'pipe') execFileSync('mkfifo', ['-m', '600', f.file]);
    if (kind === 'permissions') fs.chmodSync(f.file, 0o644);
    if (kind === 'oversized') fs.writeFileSync(f.file, 'x'.repeat(4097), { mode: 0o600 });
    if (kind === 'changed') {
      const record = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      fs.writeFileSync(f.file, JSON.stringify({ ...record, enabled: false }));
    }
    expect(readTeamAdmission(f.root, f.binding)).toBeNull();
    expect(() =>
      configureTeamAdmission(f.root, f.binding, randomUUID(), { ...f.change, expectedRevision: 1 }),
    ).toThrow();
    expect(fs.lstatSync(f.file)).toBeTruthy();
  },
);
