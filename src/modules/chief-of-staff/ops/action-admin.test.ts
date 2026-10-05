import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type pg from 'pg';
const f = vi.hoisted(() => ({
  connect: vi.fn(),
  fingerprint: vi.fn(),
  schema: vi.fn(),
  recovery: vi.fn(),
  pin: vi.fn(),
  consent: vi.fn(),
  credentials: vi.fn(),
}));
vi.mock('./host-fingerprint.js', () => ({ machineFingerprint: () => 'a'.repeat(64) }));
vi.mock('../store/preflight.js', async (original) => ({
  ...(await original<typeof import('../store/preflight.js')>()),
  connectChecked: f.connect,
}));
vi.mock('./target-identity.js', async (original) => ({
  ...(await original<typeof import('./target-identity.js')>()),
  databaseFingerprint: f.fingerprint,
}));
vi.mock('../store/config.js', async (original) => ({
  ...(await original<typeof import('../store/config.js')>()),
  parseDatabaseConfig: () => ({}),
}));
vi.mock('../store/migrations.js', async (original) => ({
  ...(await original<typeof import('../store/migrations.js')>()),
  migrationStatus: f.schema,
}));
vi.mock('../actions/profile.js', async (original) => ({
  ...(await original<typeof import('../actions/profile.js')>()),
  verifyActionGrantRecovery: f.recovery,
  actionRecoveryPinCurrent: f.pin,
}));
vi.mock('./action-account-admin.js', async (original) => ({
  ...(await original<typeof import('./action-account-admin.js')>()),
  readActionAccountConsent: f.consent,
}));
vi.mock('../actions/config.js', async (original) => ({
  ...(await original<typeof import('../actions/config.js')>()),
  openWriterCredentials: f.credentials,
}));
import { runActionAdmin } from './action-admin.js';
import { SCHEMA_VERSION } from '../store/migrations.js';
import { parseAdminArguments } from './admin.js';
import { initializeTarget, writeAtomic } from './target-state.js';
import { machineFingerprint } from './target-identity.js';
import { initializeTargetActionWitness } from '../actions/host-ownership.js';
import { digest } from '../domain/contracts.js';
import { readActionHostProfile, type ActionHostGrant } from '../actions/profile.js';
import { writerAccountFingerprint } from '../actions/google-writer.js';
import { GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE } from '../actions/writer.js';
const directories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-action-admin-'));
  directories.push(root);
  const roots = { targetRoot: root + '/state', installationRoot: root + '/app', dataRoot: root + '/data' },
    targetBinding = {
      hostFingerprint: machineFingerprint(),
      databaseFingerprint: digest('runtime DB'),
      service: 'nano.service',
      installationRoot: roots.installationRoot,
      dataRoot: roots.dataRoot,
    };
  initializeTarget(roots.targetRoot, targetBinding);
  const witness = initializeTargetActionWitness(roots.targetRoot, digest(targetBinding)),
    binding = {
      scopeId: 'scope',
      ownerId: 'owner',
      botId: 'bot',
      agentGroupId: 'main',
      sessionId: 'main',
      messagingGroupId: 'chat',
      instanceId: 'fixture',
      channelId: 'private',
      provider: 'codex' as const,
    },
    reference = randomUUID(),
    grant: ActionHostGrant = {
      scopeId: binding.scopeId,
      ownerId: binding.ownerId,
      sessionId: binding.sessionId,
      agentGroupId: binding.agentGroupId,
      id: reference,
      credentialReference: reference,
      backupOperationId: 'release-fixture-actions',
      targetBackupDigest: digest('backup'),
      writeEnabled: true,
      binding: {
        format: 'cos-calendar-writer/v1',
        provider: 'google',
        calendarId: 'operator@example.test',
        accountFingerprint: writerAccountFingerprint('operator@example.test'),
        credentialGeneration: reference,
        instanceId: 'fixture',
        channelId: 'private',
        bindingDigest: digest(binding),
        processingProvider: 'codex',
        restoreProofDigest: digest('proof'),
        scopes: [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE],
      },
    },
    manifestFile = roots.targetRoot + '/grant.json';
  writeAtomic(roots.targetRoot, 'grant.json', grant);
  const args = {
      command: 'action-configure' as const,
      scopeId: binding.scopeId,
      requestId: randomUUID(),
      manifestFile,
    },
    options = {
      args,
      env: {},
      roots,
      binding,
      databaseFingerprint: targetBinding.databaseFingerprint,
      check: vi.fn(async () => {}),
      assertAuthority: vi.fn(),
    },
    rows = new Map<string, unknown>(),
    order: string[] = [],
    client = {
      query: vi.fn(
        async (sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
          order.push(sql);
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
          if (sql.includes('FROM cos.scopes')) return { rows: [{ id: binding.scopeId }], rowCount: 1 };
          if (sql.includes('FROM cos.action_writer_bindings'))
            return {
              rows: rows.has('binding') ? [rows.get('binding') as Record<string, unknown>] : [],
              rowCount: rows.has('binding') ? 1 : 0,
            };
          if (sql.startsWith('INSERT INTO cos.action_writer_bindings'))
            rows.set('binding', {
              version: 1,
              state: 'enabled',
              owner_id: binding.ownerId,
              session_id: binding.sessionId,
              body: grant.binding,
              digest: digest(grant.binding),
              consent_ref: digest(consent),
            });
          return { rows: [], rowCount: 1 };
        },
      ),
      end: vi.fn(async () => {}),
    },
    consent = {
      selection: {
        calendarId: grant.binding.calendarId,
        primaryCalendarId: grant.binding.calendarId,
        processingProvider: 'codex',
      },
      bindingId: reference,
      credentialReference: reference,
      nativeBindingDigest: digest(binding),
      format: 'cos-action-account-consent/v1',
      setupDigest: digest('ready setup'),
    },
    owner = {
      verify: vi.fn(),
      credentials: { inspect: vi.fn(async () => ({ auth: 'ready', scopes: grant.binding.scopes, generation: 1 })) },
    };
  f.connect.mockResolvedValue(client as unknown as pg.Client);
  f.fingerprint.mockResolvedValue(targetBinding.databaseFingerprint);
  f.schema.mockResolvedValue(SCHEMA_VERSION);
  f.recovery.mockResolvedValue({});
  f.pin.mockReturnValue(true);
  f.consent.mockReturnValue(consent);
  f.credentials.mockReturnValue(owner);
  return { root, roots, witness, binding, grant, args, options, client, order, rows, owner, consent };
}
it('S09 grants a checked writer only after consent, separate recovery and a confirmed admin commit', async () => {
  const s = fixture();
  expect(
    parseAdminArguments([
      'action-configure',
      '--scope',
      'scope',
      '--request-id',
      s.args.requestId,
      '--manifest',
      s.args.manifestFile,
    ]),
  ).toEqual(s.args);
  const result = await runActionAdmin(s.options);
  expect(result).toMatchObject({
    status: 'configured_paused',
    writer_enabled: true,
    paused: true,
    live_model: 'not_invoked',
  });
  expect(f.connect).toHaveBeenCalledWith(s.options.env, 'runtime', 'migration');
  expect(f.recovery).toHaveBeenCalledOnce();
  expect(s.order).toContain('COMMIT');
  expect(readActionHostProfile(s.roots.targetRoot, s.witness.installationDigest, s.witness.generation).grants).toEqual([
    s.grant,
  ]);
  await runActionAdmin(s.options);
  expect(s.order.filter((sql) => sql.startsWith('INSERT INTO cos.action_writer_bindings'))).toHaveLength(1);
});
it.each(['identity', 'consent', 'recovery', 'database', 'schema', 'commit', 'late-proof', 'late-authority'])(
  'S09 %s failure cannot publish runtime writer permission',
  async (kind) => {
    const s = fixture();
    if (kind === 'identity') writeAtomic(s.roots.targetRoot, 'grant.json', { ...s.grant, ownerId: 'foreign' });
    if (kind === 'consent')
      f.consent.mockReturnValue({
        ...s.consent,
        selection: { ...s.consent.selection, calendarId: 'foreign@example.test' },
      });
    if (kind === 'recovery') f.recovery.mockRejectedValueOnce(Error('action_recovery_proof_unavailable'));
    if (kind === 'database') f.fingerprint.mockResolvedValueOnce(digest('foreign DB'));
    if (kind === 'schema') f.schema.mockResolvedValueOnce(15);
    if (['commit', 'late-proof', 'late-authority'].includes(kind)) {
      const original = s.client.query.getMockImplementation()!;
      s.client.query.mockImplementation(async (sql, values) => {
        if (sql === 'COMMIT') {
          if (kind === 'commit') throw Error('PRIVATE_COMMIT_CANARY');
          if (kind === 'late-proof') f.pin.mockReturnValue(false);
          if (kind === 'late-authority') s.options.check.mockRejectedValue(Error('host_execution_authority_lost'));
        }
        return original(sql, values);
      });
    }
    await expect(runActionAdmin(s.options)).rejects.toThrow();
    expect(fs.existsSync(s.roots.targetRoot + '/actions/writer-profile.json')).toBe(false);
    if (['identity', 'consent', 'recovery'].includes(kind)) expect(f.connect).not.toHaveBeenCalled();
  },
);
it('S09 disabling a writer closes new writes locally even when PostgreSQL/recovery is unavailable, preserving its readback identity', async () => {
  const s = fixture();
  await runActionAdmin(s.options);
  const args = { command: 'action-disable' as const, scopeId: 'scope', requestId: randomUUID(), bindingId: s.grant.id };
  f.connect.mockClear();
  f.connect.mockRejectedValue(Error('PRIVATE_DB_CANARY'));
  f.recovery.mockRejectedValue(Error('action_recovery_proof_unavailable'));
  expect(
    parseAdminArguments([
      'action-disable',
      '--scope',
      'scope',
      '--request-id',
      args.requestId,
      '--binding',
      args.bindingId,
    ]),
  ).toEqual(args);
  expect(await runActionAdmin({ ...s.options, args })).toMatchObject({
    status: 'disabled_paused',
    writer_enabled: false,
  });
  expect(f.connect).not.toHaveBeenCalled();
  const disabled = readActionHostProfile(s.roots.targetRoot, s.witness.installationDigest, s.witness.generation)
    .grants[0];
  expect(disabled).toEqual({ ...s.grant, writeEnabled: false });
  expect(s.rows.get('binding')).toMatchObject({ version: 1, state: 'enabled' });
});
