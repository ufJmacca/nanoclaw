import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import {
  backupCoordinatedState,
  restoreCoordinatedSandbox,
  verifyCoordinatedBackup,
  type CoordinatedBackupOptions,
  type QuiescentCheckpoint,
} from './coordinated-backup.js';
import { KnowledgeArtifacts } from '../knowledge/artifacts.js';
import { ActionWitness, initializeActionWitness } from '../actions/witness.js';
import { MIGRATIONS } from '../store/migrations.js';
import { digest } from '../domain/contracts.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-guard-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  for (const name of ['receipt', 'artifacts', 'staging']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const source = path.join(root, 'native.sqlite'),
    db = new Database(source);
  db.exec("CREATE TABLE messages(id,body);INSERT INTO messages VALUES(1,'preserved')");
  db.close();
  fs.chmodSync(source, 0o600);
  const artifacts = new KnowledgeArtifacts(path.join(root, 'artifacts'), path.join(root, 'staging'));
  const installation = digest('fixture installation'),
    journalRoot = path.join(root, 'effects'),
    owner = initializeActionWitness(journalRoot, installation);
  const witness = new ActionWitness(journalRoot, installation, owner.generation),
    restriction = path.join(root, 'binding.json');
  fs.writeFileSync(restriction, JSON.stringify({ scopeId: 'scope', paused: true }), { mode: 0o600 });
  const query = vi.fn(async (sql: string, parameters?: string[]) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('to_regclass')) return { rows: [{ ledger: 'cos.schema_migrations' }] };
    if (sql.includes('FROM cos.schema_migrations'))
      return { rows: MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })) };
    if (sql.includes('SELECT owner_id,agent_group_id'))
      return { rows: [{ owner_id: 'owner', agent_group_id: 'group' }] };
    if (sql.includes('FROM pg_attribute'))
      return {
        rows: (parameters?.[0] === 'cos.scopes' ? ['id', 'owner_id', 'agent_group_id'] : ['scope_id']).map(
          (attname) => ({ attname }),
        ),
      };
    if (sql.includes('to_jsonb(t)'))
      return {
        rows: sql.includes('cos."scopes"')
          ? [{ body: { id: 'scope', owner_id: 'owner', agent_group_id: 'group' } }]
          : [],
      };
    if (sql.includes('clock_timestamp')) return { rows: [{ now: new Date() }] };
    return { rows: [] };
  });
  const quiescent = vi.fn(async () => ({
    generation: 1,
    activeWorkers: 0 as const,
    activeOperations: 0 as const,
    nativeWriters: 0 as const,
    effectsEnabled: false as const,
  }));
  const options: CoordinatedBackupOptions = {
    client: { query } as unknown as pg.Client,
    context: { scopeId: 'scope', ownerId: 'owner', sessionId: 'session', agentGroupId: 'group', ingressId: 'ingress' },
    databaseFingerprint: digest('fixture database'),
    operationId: randomUUID(),
    receiptRoot: path.join(root, 'receipt'),
    nativeDatabases: [source],
    artifacts,
    restrictionFiles: [restriction],
    witness,
    quiescent,
  };
  return { root, source, restriction, query, options, quiescent, archive: path.join(root, 'receipt', 'coordinated') };
}
it('S09 first-write backup verification rejects a replaced independent target journal generation', async () => {
  const f = fixture();
  await backupCoordinatedState(f.options);
  fs.writeFileSync(
    path.join(f.options.witness.root, 'owner.json'),
    JSON.stringify({
      format: 'cos-action-witness-owner/v1',
      installationDigest: f.options.witness.installationDigest,
      generation: randomUUID(),
    }),
    { mode: 0o600 },
  );
  await expect(verifyCoordinatedBackup(f.options)).rejects.toThrow('coordinated_backup_unavailable');
});
it('keeps the paired baseline on retry and refuses a different local input set', async () => {
  const f = fixture(),
    first = await backupCoordinatedState(f.options);
  await expect(backupCoordinatedState(f.options)).resolves.toEqual(first);
  await expect(
    verifyCoordinatedBackup({ ...f.options, restrictionFiles: [path.join(f.root, 'different.json')] }),
  ).rejects.toThrow('coordinated_backup_unavailable');
});
it.each(['workers', 'operations', 'native', 'effects', 'generation', 'callback'])(
  'does not publish a checkpoint after %s barrier failure',
  async (kind) => {
    const f = fixture();
    let calls = 0;
    f.quiescent.mockImplementation(async () => {
      if (kind === 'callback') throw new Error('PRIVATE_ACCOUNT_ENDPOINT');
      const value = {
        generation: 1,
        activeWorkers: 0,
        activeOperations: 0,
        nativeWriters: 0,
        effectsEnabled: false,
      };
      if (kind === 'generation' && ++calls > 2) value.generation = 2;
      if (kind === 'workers') value.activeWorkers = 1;
      if (kind === 'operations') value.activeOperations = 1;
      if (kind === 'native') value.nativeWriters = 1;
      if (kind === 'effects') value.effectsEnabled = true;
      return value as QuiescentCheckpoint;
    });
    await expect(backupCoordinatedState(f.options)).rejects.toThrow('coordinated_backup_unavailable');
    expect(fs.existsSync(f.archive)).toBe(false);
  },
);
it('never includes separately configured account secrets in restriction exports', async () => {
  const f = fixture();
  fs.writeFileSync(f.restriction, JSON.stringify({ client_secret: 'FIXTURE_SECRET' }));
  await expect(backupCoordinatedState(f.options)).rejects.toThrow('coordinated_backup_unavailable');
  expect(fs.existsSync(f.archive)).toBe(false);
});
it.each(['corruption', 'extra-file', 'symlink', 'hardlink', 'permissions'])(
  'refuses %s in a checkpoint before restoring any local bytes',
  async (kind) => {
    const f = fixture();
    await backupCoordinatedState(f.options);
    const file = path.join(f.archive, 'remote.json');
    if (kind === 'corruption') fs.appendFileSync(file, 'corrupt');
    if (kind === 'extra-file') fs.writeFileSync(path.join(f.archive, 'unexpected.json'), '{}', { mode: 0o600 });
    if (kind === 'symlink') {
      fs.unlinkSync(file);
      fs.symlinkSync(f.restriction, file);
    }
    if (kind === 'hardlink') fs.linkSync(file, path.join(f.root, 'alias'));
    if (kind === 'permissions') fs.chmodSync(file, 0o644);
    const destination = path.join(f.root, 'sandbox');
    await expect(restoreCoordinatedSandbox(f.options, destination)).rejects.toThrow('coordinated_restore_unavailable');
    expect(fs.existsSync(destination)).toBe(false);
  },
);
it('restores only into a new isolated root and refuses the original data or journal paths', async () => {
  const f = fixture();
  const receipt = await backupCoordinatedState(f.options);
  for (const destination of [f.root, f.source, f.options.witness.root, f.options.artifacts.root])
    await expect(restoreCoordinatedSandbox(f.options, destination)).rejects.toThrow('coordinated_restore_unavailable');
  const destination = path.join(f.root, 'sandbox');
  await expect(restoreCoordinatedSandbox(f.options, destination)).resolves.toMatchObject({
    manifestDigest: digest(receipt),
    admissionRestored: false,
    eventJournalRestored: false,
  });
  await expect(restoreCoordinatedSandbox(f.options, destination)).rejects.toThrow('coordinated_restore_unavailable');
  expect(fs.existsSync(path.join(destination, 'effects'))).toBe(false);
});
