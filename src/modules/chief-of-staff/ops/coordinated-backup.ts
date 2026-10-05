import type pg from 'pg';
import type { PoolConfig } from 'pg';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { digest, type Context } from '../domain/contracts.js';
import type { KnowledgeArtifacts } from '../knowledge/artifacts.js';
import type { ActionWitness } from '../actions/witness.js';
import { MIGRATIONS, SCHEMA_VERSION, migrationStatus } from '../store/migrations.js';
import { backupNativeDatabase } from './native-installation.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { artifactHash } from './release-artifacts.js';
import { assertTestTarget } from '../store/preflight.js';
import { databaseFingerprint } from './target-identity.js';
export type QuiescentCheckpoint = {
  generation: number;
  activeWorkers: 0;
  activeOperations: 0;
  nativeWriters: 0;
  effectsEnabled: false;
};
export type CoordinatedBackupOptions = {
  client: pg.Client;
  context: Context;
  databaseFingerprint: string;
  operationId: string;
  receiptRoot: string;
  nativeDatabases: string[];
  artifacts: KnowledgeArtifacts;
  restrictionFiles: string[];
  witness: ActionWitness;
  quiescent(): Promise<QuiescentCheckpoint>;
};
/** Read-only verification needs no database login, writer callback or artifact initialization. */
export type CoordinatedBackupIdentity = Omit<CoordinatedBackupOptions, 'client' | 'quiescent' | 'artifacts'> & {
  artifacts: Pick<KnowledgeArtifacts, 'root'>;
};
export type ScopeCheckpoint = {
  format: 'cos-scoped-checkpoint/v1';
  scopeId: string;
  schemaVersion: number;
  schemaDigest: string;
  databaseFingerprint: string;
  at: string;
  columns: Record<string, string[]>;
  rows: Record<string, Record<string, unknown>[]>;
};
type FileReceipt = { file: string; sha256: string; bytes: number };
export type CoordinatedBackupReceipt = {
  format: 'cos-coordinated-backup/v1';
  operationId: string;
  contextDigest: string;
  inputsDigest: string;
  databaseFingerprint: string;
  schemaVersion: number;
  schemaDigest: string;
  barrierDigest: string;
  admissionRestored: false;
  journal: { installationDigest: string; generation: string };
  remote: FileReceipt;
  sqlite: FileReceipt[];
  artifacts: FileReceipt[];
  restrictions: FileReceipt[];
};
/** A verified restore is evidence only. It cannot restore approvals, admission or the effect journal. */
export type CoordinatedRestoreProof = {
  format: 'cos-coordinated-restore-proof/v1';
  checkpointDigest: string;
  scopeIdentityDigest: string;
  databaseFingerprint: string;
  sandboxDatabaseFingerprint: string;
  sandboxSeparated: boolean;
  testMarkerDigest: string;
  schemaVersion: number;
  schemaDigest: string;
  restoredStateDigest: string;
  sqliteCount: number;
  journal: CoordinatedBackupReceipt['journal'];
  admissionRestored: false;
  eventJournalRestored: false;
  verifiedAt: string;
};
const schemaDigest = digest(MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })));
/** Only application tables created by the reviewed migration history. No cos_admin or foreign schemas. */
export const CHECKPOINT_TABLES = [
  ...new Set(
    MIGRATIONS.flatMap((m) => [...m.sql.matchAll(/CREATE TABLE cos\.([a-z_]+)\s*\(/g)].map((match) => match[1])),
  ),
].sort();
const maximumRemoteBytes = 64 * 1024 * 1024;
const inputsDigest = (options: CoordinatedBackupIdentity) =>
  digest({
    nativeDatabases: options.nativeDatabases,
    artifactsRoot: options.artifacts.root,
    restrictionFiles: options.restrictionFiles,
  });
function directory(root: string) {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_coordinated_backup');
}
function privateBytes(file: string, maximum: number): Buffer {
  directory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > maximum
    )
      throw new Error('unsafe_coordinated_backup');
    const bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd);
    if (bytes.length !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
      throw new Error('coordinated_backup_changed');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function publishBytes(root: string, name: string, bytes: Buffer) {
  directory(root);
  const fd = fs.openSync(path.join(root, name), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function sync(root: string) {
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const fileReceipt = (file: string, bytes: Buffer): FileReceipt => ({
  file,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
});
function secretFree(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, item]) =>
      !['password', 'accesstoken', 'refreshtoken', 'clientsecret', 'apikey', 'authjson', 'authorization'].includes(
        key.toLowerCase().replace(/_/g, ''),
      ) && secretFree(item, depth + 1),
  );
}
async function barrier(options: CoordinatedBackupOptions, expected?: string) {
  const value = await options.quiescent();
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'activeOperations,activeWorkers,effectsEnabled,generation,nativeWriters' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    value.activeWorkers !== 0 ||
    value.activeOperations !== 0 ||
    value.nativeWriters !== 0 ||
    value.effectsEnabled !== false ||
    (expected && digest(value) !== expected)
  )
    throw new Error('coordinated_backup_not_quiescent');
  journalCurrent(options);
  return digest(value);
}
function journalCurrent(options: CoordinatedBackupIdentity) {
  // Validate the live independent journal. A backup never replaces or initializes it.
  directory(options.witness.root);
  const journal = readPrivate(path.join(options.witness.root, 'owner.json'));
  if (
    digest(journal) !==
    digest({
      format: 'cos-action-witness-owner/v1',
      installationDigest: options.witness.installationDigest,
      generation: options.witness.generation,
    })
  )
    throw new Error('coordinated_backup_journal_changed');
}
function parameters(options: CoordinatedBackupIdentity) {
  directory(options.receiptRoot);
  if (
    !/^[a-zA-Z0-9_-]{1,200}$/.test(options.context.scopeId) ||
    options.context.origin ||
    !/^[a-f0-9]{64}$/.test(options.databaseFingerprint) ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(options.operationId) ||
    !options.nativeDatabases.length ||
    options.nativeDatabases.length > 10000 ||
    new Set(options.nativeDatabases).size !== options.nativeDatabases.length ||
    options.restrictionFiles.length > 4096
  )
    throw new Error('invalid_coordinated_backup');
  const root = path.join(options.receiptRoot, 'coordinated');
  for (const source of [
    ...options.nativeDatabases,
    ...options.restrictionFiles,
    options.artifacts.root,
    options.witness.root,
  ]) {
    if (
      !path.isAbsolute(source) ||
      path.resolve(source) !== source ||
      source === root ||
      source.startsWith(root + '/') ||
      root.startsWith(source + '/')
    )
      throw new Error('unsafe_coordinated_backup');
  }
  if (
    [...options.nativeDatabases, ...options.restrictionFiles, options.artifacts.root].some(
      (source) => source === options.witness.root || source.startsWith(options.witness.root + '/'),
    )
  )
    throw new Error('unsafe_coordinated_backup');
  return root;
}
async function remoteSnapshot(
  options: Pick<CoordinatedBackupOptions, 'client' | 'context' | 'databaseFingerprint'>,
): Promise<ScopeCheckpoint> {
  const client = options.client;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    if ((await migrationStatus(client)) !== SCHEMA_VERSION) throw new Error('coordinated_backup_schema_incompatible');
    const scope = (
      await client.query('SELECT owner_id,agent_group_id FROM cos.scopes WHERE id=$1', [options.context.scopeId])
    ).rows[0];
    if (!scope || scope.owner_id !== options.context.ownerId || scope.agent_group_id !== options.context.agentGroupId)
      throw new Error('coordinated_backup_scope_denied');
    const columns: ScopeCheckpoint['columns'] = {},
      rows: ScopeCheckpoint['rows'] = {};
    let bytes = 0;
    for (const table of CHECKPOINT_TABLES) {
      const fields = (
        await client.query(
          `SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`,
          ['cos.' + table],
        )
      ).rows.map((row) => row.attname as string);
      if (
        !fields.length ||
        fields.some((field) => !/^\w{1,63}$/.test(field)) ||
        (table !== 'scopes' && !fields.includes('scope_id'))
      )
        throw new Error('coordinated_backup_schema_incompatible');
      columns[table] = fields;
      const selected = (
        await client.query(
          `SELECT to_jsonb(t) AS body FROM cos."${table}" t WHERE "${table === 'scopes' ? 'id' : 'scope_id'}"=$1 ORDER BY to_jsonb(t)::text LIMIT 10001`,
          [options.context.scopeId],
        )
      ).rows.map((row) => Object.fromEntries(fields.map((field) => [field, row.body[field]])));
      if (selected.length > 10000) throw new Error('coordinated_backup_bounds');
      bytes += Buffer.byteLength(JSON.stringify(selected));
      if (bytes > maximumRemoteBytes) throw new Error('coordinated_backup_bounds');
      rows[table] = selected;
    }
    const at = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
    await client.query('COMMIT');
    return {
      format: 'cos-scoped-checkpoint/v1',
      scopeId: options.context.scopeId,
      schemaVersion: SCHEMA_VERSION,
      schemaDigest,
      databaseFingerprint: options.databaseFingerprint,
      at,
      columns,
      rows,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
function copyArtifacts(options: CoordinatedBackupOptions, temporary: string) {
  directory(options.artifacts.root);
  const names = fs
    .readdirSync(options.artifacts.root)
    .filter((name) => name !== '.operation.lock')
    .sort();
  if (names.length > 10000 || !names.includes('.cos-artifacts'))
    throw new Error('coordinated_backup_artifacts_invalid');
  const result: FileReceipt[] = [];
  let bytes = 0;
  for (const name of names) {
    if (name !== '.cos-artifacts' && !/^[a-f0-9]{64}-[a-f0-9]{64}\.blob$/.test(name))
      throw new Error('coordinated_backup_artifacts_invalid');
    const content = privateBytes(path.join(options.artifacts.root, name), 1024 * 1024);
    bytes += content.length;
    if (bytes > maximumRemoteBytes) throw new Error('coordinated_backup_bounds');
    publishBytes(path.join(temporary, 'artifacts'), name, content);
    result.push(fileReceipt('artifacts/' + name, content));
  }
  sync(path.join(temporary, 'artifacts'));
  return result;
}
async function verify(options: CoordinatedBackupIdentity): Promise<CoordinatedBackupReceipt> {
  const root = parameters(options);
  journalCurrent(options);
  directory(root);
  const value = readPrivate<CoordinatedBackupReceipt>(path.join(root, 'manifest.json'), 1024 * 1024);
  if (
    value.format !== 'cos-coordinated-backup/v1' ||
    value.operationId !== options.operationId ||
    value.contextDigest !== digest(options.context) ||
    value.inputsDigest !== inputsDigest(options) ||
    value.databaseFingerprint !== options.databaseFingerprint ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.schemaDigest !== schemaDigest ||
    value.admissionRestored !== false ||
    digest(value.journal) !==
      digest({ installationDigest: options.witness.installationDigest, generation: options.witness.generation }) ||
    !Array.isArray(value.sqlite) ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.restrictions) ||
    value.sqlite.length !== options.nativeDatabases.length ||
    value.restrictions.length !== options.restrictionFiles.length
  )
    throw new Error('coordinated_backup_conflict');
  const files = [value.remote, ...value.sqlite, ...value.artifacts, ...value.restrictions];
  if (files.length > 24097 || new Set(files.map((f) => f.file)).size !== files.length)
    throw new Error('coordinated_backup_conflict');
  for (const item of files) {
    if (
      !item ||
      !/^\w[\w./-]{0,250}$/.test(item.file) ||
      item.file.split('/').some((part) => !part || part === '.' || part === '..') ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > 4 * 1024 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error('coordinated_backup_conflict');
    const file = path.join(root, item.file),
      stat = fs.lstatSync(file);
    directory(path.dirname(file));
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size !== item.bytes ||
      (await artifactHash(file, 4 * 1024 * 1024 * 1024)) !== item.sha256
    )
      throw new Error('coordinated_backup_conflict');
  }
  const expectedFiles = new Set(['manifest.json', ...files.map((item) => item.file)]),
    expectedDirectories = new Set(['sqlite', 'artifacts', 'restrictions']);
  for (const file of files) {
    const parts = file.file.split('/');
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'));
  }
  const visit = (relative: string, depth: number) => {
    if (depth > 4) throw new Error('coordinated_backup_conflict');
    directory(path.join(root, relative));
    for (const name of fs.readdirSync(path.join(root, relative))) {
      const child = relative ? relative + '/' + name : name,
        stat = fs.lstatSync(path.join(root, child));
      if (stat.isDirectory() && expectedDirectories.has(child)) visit(child, depth + 1);
      else if (
        !stat.isFile() ||
        !expectedFiles.has(child) ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600
      )
        throw new Error('coordinated_backup_conflict');
    }
  };
  visit('', 0);
  return value;
}
/** Read-only verification; no archived permission, context or deny journal is admitted. */
export async function verifyCoordinatedBackup(options: CoordinatedBackupIdentity): Promise<CoordinatedBackupReceipt> {
  try {
    return await verify(options);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private checkpoint content and filesystem diagnostics remain host-only.
    throw new Error('coordinated_backup_unavailable');
  }
}
/** Restore local bytes only into a new isolated root. PostgreSQL restore is separately guarded.
 * Historical restriction files are forensic evidence, never live admission authority.
 */
export async function restoreCoordinatedSandbox(options: CoordinatedBackupOptions, destination: string) {
  try {
    const root = parameters(options),
      epoch = await barrier(options),
      receipt = await verify(options);
    directory(path.dirname(destination));
    if (
      !path.isAbsolute(destination) ||
      path.resolve(destination) !== destination ||
      fs.lstatSync(destination, { throwIfNoEntry: false }) ||
      [
        root,
        options.artifacts.root,
        options.witness.root,
        ...options.nativeDatabases,
        ...options.restrictionFiles,
      ].some(
        (source) =>
          source === destination || destination.startsWith(source + '/') || source.startsWith(destination + '/'),
      )
    )
      throw new Error('unsafe_coordinated_restore');
    const temporary = path.join(path.dirname(destination), '.sandbox-' + randomUUID());
    fs.mkdirSync(temporary, { mode: 0o700 });
    for (const child of ['sqlite', 'artifacts', 'restrictions'])
      fs.mkdirSync(path.join(temporary, child), { mode: 0o700 });
    for (const item of [receipt.remote, ...receipt.sqlite, ...receipt.artifacts, ...receipt.restrictions]) {
      const target = path.join(temporary, item.file),
        parent = path.dirname(target);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
      directory(parent);
      fs.copyFileSync(path.join(root, item.file), target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      if ((await artifactHash(target, 4 * 1024 * 1024 * 1024)) !== item.sha256)
        throw new Error('coordinated_backup_conflict');
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      sync(parent);
    }
    const result = {
      format: 'cos-coordinated-sandbox/v1',
      manifestDigest: digest(receipt),
      schemaVersion: receipt.schemaVersion,
      admissionRestored: false,
      eventJournalRestored: false,
    };
    await barrier(options, epoch);
    writeAtomic(temporary, 'sandbox.json', result);
    sync(temporary);
    if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error('unsafe_coordinated_restore');
    fs.renameSync(temporary, destination);
    sync(path.dirname(destination));
    await barrier(options, epoch);
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Isolated restoration never exposes source content or private path diagnostics.
    throw new Error('coordinated_restore_unavailable');
  }
}
const checkpointState = (snapshot: ScopeCheckpoint) => ({
  columns: snapshot.columns,
  rows: Object.fromEntries(
    CHECKPOINT_TABLES.map((table) => [table, snapshot.rows[table].map((row) => digest(row)).sort()]),
  ),
});
function scopedCheckpoint(options: CoordinatedBackupIdentity, receipt: CoordinatedBackupReceipt): ScopeCheckpoint {
  if (receipt.remote.file !== 'remote.json') throw Error('coordinated_restore_conflict');
  const value = JSON.parse(
    privateBytes(path.join(parameters(options), 'remote.json'), maximumRemoteBytes).toString('utf8'),
  ) as ScopeCheckpoint;
  const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !==
      'at,columns,databaseFingerprint,format,rows,schemaDigest,schemaVersion,scopeId' ||
    value.format !== 'cos-scoped-checkpoint/v1' ||
    value.scopeId !== options.context.scopeId ||
    value.databaseFingerprint !== options.databaseFingerprint ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.schemaDigest !== schemaDigest ||
    !Number.isFinite(Date.parse(value.at)) ||
    !record(value.columns) ||
    !record(value.rows) ||
    Object.keys(value.columns).sort().join(',') !== CHECKPOINT_TABLES.join(',') ||
    Object.keys(value.rows).sort().join(',') !== CHECKPOINT_TABLES.join(',')
  )
    throw Error('coordinated_restore_conflict');
  for (const table of CHECKPOINT_TABLES) {
    const columns = value.columns[table],
      rows = value.rows[table],
      scopeColumn = table === 'scopes' ? 'id' : 'scope_id';
    if (
      !Array.isArray(columns) ||
      !columns.length ||
      columns.length > 200 ||
      new Set(columns).size !== columns.length ||
      !columns.includes(scopeColumn) ||
      columns.some((column) => typeof column !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(column)) ||
      !Array.isArray(rows) ||
      rows.length > 10000 ||
      rows.some(
        (row) =>
          !record(row) ||
          Object.keys(row).sort().join(',') !== [...columns].sort().join(',') ||
          row[scopeColumn] !== value.scopeId,
      )
    )
      throw Error('coordinated_restore_conflict');
  }
  if (
    value.rows.scopes.length !== 1 ||
    value.rows.scopes[0].owner_id !== options.context.ownerId ||
    value.rows.scopes[0].agent_group_id !== options.context.agentGroupId
  )
    throw Error('coordinated_restore_conflict');
  return value;
}
/** Import only a fresh owned scope into an independently admitted test database. Never update, clear or replace
 * an existing scope. A durable start reservation permits read-only reconciliation of an unknown commit.
 * This restores data for a drill; it grants no account, model, effect or notification admission.
 */
export async function restoreCoordinatedTestScope(
  options: CoordinatedBackupIdentity,
  operationRoot: string,
  sandbox: { client: pg.Client; config: PoolConfig; testTargetId: string },
  check: () => Promise<void>,
) {
  try {
    return await restoreTestScope(options, operationRoot, sandbox, check);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Restore and cleanup failures withhold acknowledgement without exposing rows, endpoints or paths.
    throw Error('coordinated_test_restore_unavailable');
  }
}
async function restoreTestScope(
  options: CoordinatedBackupIdentity,
  operationRoot: string,
  sandbox: { client: pg.Client; config: PoolConfig; testTargetId: string },
  check: () => Promise<void>,
) {
  let locked = false,
    transaction = false;
  const client = sandbox.client;
  try {
    directory(operationRoot);
    if (
      [
        parameters(options),
        options.witness.root,
        options.artifacts.root,
        ...options.nativeDatabases,
        ...options.restrictionFiles,
      ].some(
        (root) =>
          root === operationRoot || operationRoot.startsWith(root + '/') || root.startsWith(operationRoot + '/'),
      )
    )
      throw Error('unsafe_coordinated_restore');
    await check();
    const receipt = await verify(options),
      original = scopedCheckpoint(options, receipt);
    await assertTestTarget(client, sandbox.testTargetId);
    const fingerprint = await databaseFingerprint(client, sandbox.config);
    if (fingerprint === options.databaseFingerprint || (await migrationStatus(client)) !== SCHEMA_VERSION)
      throw Error('unsafe_coordinated_restore');
    if (!(await client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked)
      throw Error('coordinated_restore_busy');
    locked = true;
    for (const table of CHECKPOINT_TABLES) {
      const columns = (
        await client.query(
          "SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum",
          ['cos.' + table],
        )
      ).rows.map((row) => row.attname);
      if (digest(columns) !== digest(original.columns[table])) throw Error('coordinated_restore_conflict');
    }
    const reservation = {
        format: 'cos-sandbox-restore-start/v1',
        checkpointDigest: digest(receipt),
        sandboxDatabaseFingerprint: fingerprint,
        testMarkerDigest: digest(sandbox.testTargetId),
        scopeId: original.scopeId,
        journal: receipt.journal,
      },
      file = path.join(operationRoot, 'restore-start.json');
    const started = !!fs.lstatSync(file, { throwIfNoEntry: false });
    if (started && digest(JSON.parse(privateBytes(file, 16384).toString('utf8'))) !== digest(reservation))
      throw Error('coordinated_restore_conflict');
    await check();
    if (digest(await verify(options)) !== digest(receipt)) throw Error('coordinated_restore_conflict');
    await client.query('BEGIN');
    transaction = true;
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const exists =
      (await client.query('SELECT id FROM cos.scopes WHERE id=$1 FOR UPDATE', [original.scopeId])).rows.length > 0;
    if (exists && !started) throw Error('coordinated_restore_scope_exists');
    if (!exists) {
      await check();
      if (!started) writeAtomic(operationRoot, 'restore-start.json', reservation);
      let remaining = CHECKPOINT_TABLES.filter((table) => original.rows[table].length > 0);
      while (remaining.length) {
        const retry: string[] = [];
        for (const table of remaining) {
          await check();
          await client.query('SAVEPOINT cos_sandbox_restore');
          try {
            const columns = original.columns[table].map((name) => '"' + name + '"').join(',');
            await client.query(
              `INSERT INTO cos."${table}"(${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::cos."${table}",$1::jsonb)`,
              [JSON.stringify(original.rows[table])],
            );
            await client.query('RELEASE SAVEPOINT cos_sandbox_restore');
          } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT cos_sandbox_restore');
            await client.query('RELEASE SAVEPOINT cos_sandbox_restore');
            if ((error as { code?: string }).code !== '23503') throw error;
            retry.push(table);
          }
        }
        if (retry.length === remaining.length) throw Error('coordinated_restore_dependency_conflict');
        remaining = retry;
      }
    }
    await check();
    await client.query('COMMIT');
    transaction = false;
    await check();
    const restored = await remoteSnapshot({ context: options.context, databaseFingerprint: fingerprint, client });
    if (
      digest(checkpointState(restored)) !== digest(checkpointState(original)) ||
      digest(await verify(options)) !== digest(receipt) ||
      digest(JSON.parse(privateBytes(file, 16384).toString('utf8'))) !== digest(reservation)
    )
      throw Error('coordinated_restore_conflict');
    await check();
    journalCurrent(options);
    return {
      format: 'cos-sandbox-scope-restore/v1',
      checkpointDigest: digest(receipt),
      sandboxDatabaseFingerprint: fingerprint,
      restoredStateDigest: digest(checkpointState(restored)),
      inserted: !exists,
      admissionRestored: false,
      eventJournalRestored: false,
    };
  } finally {
    try {
      if (transaction) await client.query('ROLLBACK');
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(73101003)');
    }
  }
}
async function verifySandboxCopy(checkpoint: CoordinatedBackupReceipt, destination: string) {
  directory(destination);
  const expected = {
    format: 'cos-coordinated-sandbox/v1',
    manifestDigest: digest(checkpoint),
    schemaVersion: SCHEMA_VERSION,
    admissionRestored: false,
    eventJournalRestored: false,
  };
  if (
    digest(JSON.parse(privateBytes(path.join(destination, 'sandbox.json'), 16384).toString('utf8'))) !==
    digest(expected)
  )
    throw new Error('coordinated_restore_conflict');
  const files = [checkpoint.remote, ...checkpoint.sqlite, ...checkpoint.artifacts, ...checkpoint.restrictions],
    names = new Set(['sandbox.json', ...files.map((f) => f.file)]),
    dirs = new Set(['sqlite', 'artifacts', 'restrictions']);
  for (const file of files) {
    const parts = file.file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    const target = path.join(destination, file.file),
      stat = fs.lstatSync(target);
    directory(path.dirname(target));
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size !== file.bytes ||
      (await artifactHash(target, 4 * 1024 * 1024 * 1024)) !== file.sha256
    )
      throw new Error('coordinated_restore_conflict');
  }
  const visit = (relative: string, depth: number) => {
    if (depth > 4) throw new Error('coordinated_restore_conflict');
    directory(path.join(destination, relative));
    for (const name of fs.readdirSync(path.join(destination, relative))) {
      const child = relative ? relative + '/' + name : name,
        stat = fs.lstatSync(path.join(destination, child));
      if (stat.isDirectory() && dirs.has(child)) visit(child, depth + 1);
      else if (!stat.isFile() || !names.has(child)) throw new Error('coordinated_restore_conflict');
    }
  };
  visit('', 0);
  for (const file of checkpoint.sqlite) {
    const db = new Database(path.join(destination, file.file), { readonly: true, fileMustExist: true });
    try {
      if (digest(db.pragma('quick_check')) !== digest([{ quick_check: 'ok' }]))
        throw new Error('coordinated_restore_conflict');
    } finally {
      db.close();
    }
  }
}
/** Verify an actual protected test-database restore and the isolated local copy. No mutation is issued.
 * Same-database fixture drills remain useful evidence but cannot admit a production writer.
 * A copied remote.json alone is never proof that the remote database was restored.
 */
export async function verifyCoordinatedSandbox(
  options: CoordinatedBackupOptions,
  destination: string,
  sandbox: { client: pg.Client; config: PoolConfig; testTargetId: string },
): Promise<CoordinatedRestoreProof> {
  try {
    const checkpoint = await verify(options),
      root = parameters(options);
    if (
      [
        root,
        options.witness.root,
        options.artifacts.root,
        ...options.nativeDatabases,
        ...options.restrictionFiles,
      ].some(
        (source) =>
          source === destination || source.startsWith(destination + '/') || destination.startsWith(source + '/'),
      )
    )
      throw new Error('unsafe_coordinated_restore');
    await verifySandboxCopy(checkpoint, destination);
    // The protected marker and actual server identity are checked before inspecting restored scope data.
    await assertTestTarget(sandbox.client, sandbox.testTargetId);
    const fingerprint = await databaseFingerprint(sandbox.client, sandbox.config),
      restored = await remoteSnapshot({ ...options, client: sandbox.client, databaseFingerprint: fingerprint }),
      original = JSON.parse(fs.readFileSync(path.join(root, 'remote.json'), 'utf8')) as ScopeCheckpoint;
    if (digest(checkpointState(restored)) !== digest(checkpointState(original)))
      throw new Error('coordinated_restore_conflict');
    if (digest(await verify(options)) !== digest(checkpoint)) throw new Error('coordinated_restore_conflict');
    await verifySandboxCopy(checkpoint, destination);
    journalCurrent(options);
    const { scopeId, ownerId, agentGroupId, sessionId } = options.context;
    return {
      format: 'cos-coordinated-restore-proof/v1',
      checkpointDigest: digest(checkpoint),
      scopeIdentityDigest: digest({ scopeId, ownerId, agentGroupId, sessionId }),
      databaseFingerprint: options.databaseFingerprint,
      sandboxDatabaseFingerprint: fingerprint,
      sandboxSeparated: fingerprint !== options.databaseFingerprint,
      testMarkerDigest: digest(sandbox.testTargetId),
      schemaVersion: SCHEMA_VERSION,
      schemaDigest,
      restoredStateDigest: digest(checkpointState(restored)),
      sqliteCount: checkpoint.sqlite.length,
      journal: checkpoint.journal,
      admissionRestored: false,
      eventJournalRestored: false,
      verifiedAt: new Date().toISOString(),
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Restored content, account data, host paths and database diagnostics remain private.
    throw new Error('coordinated_restore_verification_unavailable');
  }
}
/** A private application logical export supplements the DBA's backups; it is not server backup/PITR.
 * The caller owns the durable target quiesce latch. This operation holds the remote exclusion lock
 * and the artifact lock while pairing all stores. It never restores admission or target journals.
 */
export async function backupCoordinatedState(options: CoordinatedBackupOptions): Promise<CoordinatedBackupReceipt> {
  try {
    const root = parameters(options),
      epoch = await barrier(options);
    if (fs.lstatSync(root, { throwIfNoEntry: false })) {
      const prior = await verify(options);
      await barrier(options, epoch);
      return prior;
    }
    const locked = (await options.client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked;
    if (!locked) throw new Error('coordinated_backup_busy');
    try {
      return await options.artifacts.exclusive(async () => {
        await barrier(options, epoch);
        const temporary = path.join(options.receiptRoot, '.coordinated-' + randomUUID());
        fs.mkdirSync(temporary, { mode: 0o700 });
        for (const child of ['sqlite', 'artifacts', 'restrictions'])
          fs.mkdirSync(path.join(temporary, child), { mode: 0o700 });
        const snapshot = await remoteSnapshot(options),
          remoteBytes = Buffer.from(JSON.stringify(snapshot) + '\n');
        if (remoteBytes.length > maximumRemoteBytes) throw new Error('coordinated_backup_bounds');
        publishBytes(temporary, 'remote.json', remoteBytes);
        const sqlite: FileReceipt[] = [];
        for (const [index, source] of options.nativeDatabases.entries()) {
          await barrier(options, epoch);
          const destination = path.join(temporary, 'sqlite', String(index));
          fs.mkdirSync(destination, { mode: 0o700 });
          const receipt = await backupNativeDatabase(source, destination),
            bytes = fs.lstatSync(receipt.file).size;
          sqlite.push({ file: 'sqlite/' + index + '/native.sqlite', sha256: receipt.sha256, bytes });
          // This manifest uses stable relative paths. The helper's temporary absolute path is not a restore receipt.
          fs.unlinkSync(path.join(destination, 'native-backup.json'));
          sync(destination);
        }
        const artifacts = copyArtifacts(options, temporary),
          restrictions: FileReceipt[] = [];
        for (const [index, source] of options.restrictionFiles.entries()) {
          const bytes = privateBytes(source, 1024 * 1024);
          if (!secretFree(JSON.parse(bytes.toString('utf8'))))
            throw new Error('coordinated_backup_credentials_excluded');
          publishBytes(path.join(temporary, 'restrictions'), index + '.json', bytes);
          restrictions.push(fileReceipt('restrictions/' + index + '.json', bytes));
        }
        const receipt: CoordinatedBackupReceipt = {
          format: 'cos-coordinated-backup/v1',
          operationId: options.operationId,
          contextDigest: digest(options.context),
          inputsDigest: inputsDigest(options),
          databaseFingerprint: options.databaseFingerprint,
          schemaVersion: SCHEMA_VERSION,
          schemaDigest,
          barrierDigest: epoch,
          admissionRestored: false,
          journal: { installationDigest: options.witness.installationDigest, generation: options.witness.generation },
          remote: fileReceipt('remote.json', remoteBytes),
          sqlite,
          artifacts,
          restrictions,
        };
        await barrier(options, epoch);
        writeAtomic(temporary, 'manifest.json', receipt);
        sync(temporary);
        fs.renameSync(temporary, root);
        sync(options.receiptRoot);
        const verified = await verify(options);
        await barrier(options, epoch);
        return verified;
      });
    } finally {
      await options.client.query('SELECT pg_advisory_unlock(73101003)');
    }
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Database, filesystem and private snapshot diagnostics stay on the host.
    throw new Error('coordinated_backup_unavailable');
  }
}
