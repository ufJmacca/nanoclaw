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
import { captureNativeDatabase, verifyRecoveredNativeDatabase } from './backup-native.js';
import type { BackupSnapshotSink, BackupQueueReceipt } from './backup-queue.js';
import type { BackupRestoreValidationScope } from './backup-restore-workspace.js';
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
export type CoordinatedRecoveryIdentity = Omit<CoordinatedBackupIdentity, 'receiptRoot'>;
/** Current independent journal checks for an already admitted recovery caller.
 * This is read-only identity continuity, never restored permission. */
export function assertCoordinatedRecoveryIdentity(options: CoordinatedRecoveryIdentity): void {
  try {
    identityParameters(options);
    journalCurrent(options);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Current private binding and journal diagnostics stay in the trusted recovery process.
    throw Error('coordinated_recovery_identity_unavailable');
  }
}
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
const inputsDigest = (
  options: Pick<CoordinatedRecoveryIdentity, 'nativeDatabases' | 'restrictionFiles' | 'artifacts'>,
) =>
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
async function barrier(
  options: CoordinatedBackupIdentity & Pick<CoordinatedBackupOptions, 'quiescent'>,
  expected?: string,
) {
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
function journalCurrent(options: Pick<CoordinatedRecoveryIdentity, 'witness'>) {
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
  const root = path.join(options.receiptRoot, 'coordinated');
  identityParameters(options, root);
  return root;
}
function identityParameters(options: CoordinatedRecoveryIdentity, root?: string) {
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
  for (const source of [
    ...options.nativeDatabases,
    ...options.restrictionFiles,
    options.artifacts.root,
    options.witness.root,
  ]) {
    if (
      !path.isAbsolute(source) ||
      path.resolve(source) !== source ||
      (root && (source === root || source.startsWith(root + '/') || root.startsWith(source + '/')))
    )
      throw new Error('unsafe_coordinated_backup');
  }
  if (
    [...options.nativeDatabases, ...options.restrictionFiles, options.artifacts.root].some(
      (source) => source === options.witness.root || source.startsWith(options.witness.root + '/'),
    )
  )
    throw new Error('unsafe_coordinated_backup');
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
function artifactContents(options: CoordinatedBackupOptions, write: (name: string, bytes: Buffer) => void) {
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
    try {
      bytes += content.length;
      if (bytes > maximumRemoteBytes) throw new Error('coordinated_backup_bounds');
      result.push(fileReceipt('artifacts/' + name, content));
      write(name, content);
    } finally {
      content.fill(0);
    }
  }
  return result;
}
function copyArtifacts(options: CoordinatedBackupOptions, temporary: string) {
  const result = artifactContents(options, (name, content) =>
    publishBytes(path.join(temporary, 'artifacts'), name, content),
  );
  sync(path.join(temporary, 'artifacts'));
  return result;
}
/** Captures the existing portable v1 receipt directly through an admitted encrypted queue sink.
 * receiptRoot is validated for identity only; no staging directory or plaintext file is created there.
 * The caller retains maintenance and publishes the queue only after this operation succeeds. */
export async function captureCoordinatedState(
  options: CoordinatedBackupOptions,
  sink: BackupSnapshotSink,
): Promise<CoordinatedBackupReceipt> {
  try {
    parameters(options);
    const epoch = await barrier(options);
    const locked = (await options.client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked;
    if (!locked) throw Error('coordinated_backup_busy');
    try {
      return await options.artifacts.exclusive(async () => {
        await barrier(options, epoch);
        const snapshot = await remoteSnapshot(options),
          remoteBytes = Buffer.from(JSON.stringify(snapshot) + '\n');
        let remote: FileReceipt;
        try {
          if (remoteBytes.length > maximumRemoteBytes) throw Error('coordinated_backup_bounds');
          remote = fileReceipt('remote.json', remoteBytes);
          sink.write('coordinated/remote.json', remoteBytes);
        } finally {
          remoteBytes.fill(0);
        }
        const sqlite: FileReceipt[] = [];
        for (const [index, source] of options.nativeDatabases.entries()) {
          await barrier(options, epoch);
          const prefix = 'sqlite/' + index;
          const native = captureNativeDatabase(
            source,
            {
              write(name, bytes) {
                // The portable coordinated manifest carries this hash; the helper's source-path receipt is redundant.
                if (name === prefix + '/native.sqlite') sink.write('coordinated/' + name, bytes);
              },
            },
            prefix,
            maximumRemoteBytes,
          );
          sqlite.push({ file: native.file, bytes: native.bytes, sha256: native.sha256 });
        }
        const artifacts = artifactContents(options, (name, bytes) =>
          sink.write('coordinated/artifacts/' + name, bytes),
        );
        const restrictions: FileReceipt[] = [];
        for (const [index, source] of options.restrictionFiles.entries()) {
          await barrier(options, epoch);
          const bytes = privateBytes(source, 1024 ** 2);
          try {
            if (!secretFree(JSON.parse(bytes.toString('utf8')))) throw Error('coordinated_backup_credentials_excluded');
            restrictions.push(fileReceipt('restrictions/' + index + '.json', bytes));
            sink.write('coordinated/restrictions/' + index + '.json', bytes);
          } finally {
            bytes.fill(0);
          }
        }
        if (2 + sqlite.length + artifacts.length + restrictions.length > 4096) throw Error('coordinated_backup_bounds');
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
          remote,
          sqlite,
          artifacts,
          restrictions,
        };
        await barrier(options, epoch);
        const metadata = Buffer.from(JSON.stringify(receipt) + '\n');
        try {
          if (metadata.length > 1024 ** 2) throw Error('coordinated_backup_bounds');
          sink.write('coordinated/manifest.json', metadata);
        } finally {
          metadata.fill(0);
        }
        await barrier(options, epoch);
        return receipt;
      });
    } finally {
      await options.client.query('SELECT pg_advisory_unlock(73101003)');
    }
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Database contents, source paths and capture diagnostics are private.
    throw Error('coordinated_backup_unavailable');
  }
}
async function verify(options: CoordinatedBackupIdentity): Promise<CoordinatedBackupReceipt> {
  const root = parameters(options);
  journalCurrent(options);
  directory(root);
  const value = readPrivate<CoordinatedBackupReceipt>(path.join(root, 'manifest.json'), 1024 * 1024);
  receiptIdentity(options, value);
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
function receiptIdentity(options: CoordinatedRecoveryIdentity, value: CoordinatedBackupReceipt) {
  if (
    !value ||
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
export async function restoreCoordinatedSandbox(
  options: CoordinatedBackupIdentity & Pick<CoordinatedBackupOptions, 'quiescent'>,
  destination: string,
) {
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
  return validateScopedCheckpoint(options, value);
}
function validateScopedCheckpoint(
  options: Pick<CoordinatedRecoveryIdentity, 'context' | 'databaseFingerprint'>,
  value: ScopeCheckpoint,
): ScopeCheckpoint {
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
/** Portable verification uses the already owned encrypted workspace, with no
 * second payload copy or activation of archived restrictions or journals.
 * A PostgreSQL import still requires separate test-target admission. */
export function verifyRecoveredCoordinatedState(
  options: CoordinatedRecoveryIdentity,
  scope: BackupRestoreValidationScope,
  entries: BackupQueueReceipt['files'],
): {
  receipt: CoordinatedBackupReceipt;
  checkpoint: ScopeCheckpoint;
  nativeDatabasesVerified: number;
  admissionRestored: false;
  eventJournalRestored: false;
} {
  try {
    const current = () => {
      scope.assertCurrent();
      journalCurrent(options);
      scope.assertCurrent();
    };
    current();
    identityParameters(options);
    if (
      !Array.isArray(entries) ||
      entries.length > 4096 ||
      new Set(entries.map((item) => item.name)).size !== entries.length
    )
      throw Error('coordinated_recovery_bounds');
    const selected = entries.filter((item) => item.name.startsWith('coordinated/')),
      listed = new Map(selected.map((item) => [item.name, item]));
    const checkFile = (item: FileReceipt, maximum: number) => {
      current();
      const entry = listed.get('coordinated/' + item.file);
      if (
        !item ||
        Object.keys(item).sort().join(',') !== 'bytes,file,sha256' ||
        typeof item.file !== 'string' ||
        !/^(?:[A-Za-z0-9]|\.cos-)[A-Za-z0-9_.-]*(?:\/(?:[A-Za-z0-9]|\.cos-)[A-Za-z0-9_.-]*){0,6}$/.test(item.file) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        item.bytes > maximum ||
        typeof item.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !entry ||
        entry.bytes !== item.bytes ||
        entry.sha256 !== item.sha256
      )
        throw Error('coordinated_recovery_file_changed');
      const actual = scope.inspectFile(entry.name);
      if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256)
        throw Error('coordinated_recovery_file_changed');
      current();
    };
    const readJson = <T>(name: string, maximum: number): T =>
      scope.withFileBytes(
        'coordinated/' + name,
        maximum,
        (bytes) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T,
      );
    const metadata = listed.get('coordinated/manifest.json');
    if (!metadata) throw Error('coordinated_recovery_manifest_missing');
    const manifestFile = { file: 'manifest.json', bytes: metadata.bytes, sha256: metadata.sha256 };
    checkFile(manifestFile, 1024 ** 2);
    const receipt = readJson<CoordinatedBackupReceipt>('manifest.json', 1024 ** 2);
    if (
      !receipt ||
      Object.keys(receipt).sort().join(',') !==
        'admissionRestored,artifacts,barrierDigest,contextDigest,databaseFingerprint,format,inputsDigest,journal,operationId,remote,restrictions,schemaDigest,schemaVersion,sqlite' ||
      typeof receipt.barrierDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.barrierDigest)
    )
      throw Error('coordinated_recovery_manifest_changed');
    receiptIdentity(options, receipt);
    const files = [receipt.remote, ...receipt.sqlite, ...receipt.artifacts, ...receipt.restrictions],
      expectedNames = new Set(['coordinated/manifest.json', ...files.map((item) => 'coordinated/' + item.file)]);
    if (
      files.length > 4095 ||
      expectedNames.size !== files.length + 1 ||
      selected.length !== expectedNames.size ||
      selected.some((item) => !expectedNames.has(item.name))
    )
      throw Error('coordinated_recovery_graph_changed');
    if (receipt.remote.file !== 'remote.json') throw Error('coordinated_recovery_file_changed');
    checkFile(receipt.remote, maximumRemoteBytes);
    const checkpoint = validateScopedCheckpoint(options, readJson<ScopeCheckpoint>('remote.json', maximumRemoteBytes));
    for (const [index, item] of receipt.sqlite.entries()) {
      if (item.file !== 'sqlite/' + index + '/native.sqlite') throw Error('coordinated_recovery_native_changed');
      checkFile(item, maximumRemoteBytes);
      verifyRecoveredNativeDatabase(scope, { ...item, file: 'coordinated/' + item.file });
    }
    for (const [index, item] of receipt.restrictions.entries()) {
      if (item.file !== 'restrictions/' + index + '.json') throw Error('coordinated_recovery_restriction_changed');
      checkFile(item, 1024 ** 2);
      if (!secretFree(readJson(item.file, 1024 ** 2))) throw Error('coordinated_recovery_credentials_excluded');
    }
    if (!receipt.artifacts.some((item) => item.file === 'artifacts/.cos-artifacts'))
      throw Error('coordinated_recovery_artifacts_changed');
    for (const item of receipt.artifacts) {
      if (item.file !== 'artifacts/.cos-artifacts' && !/^artifacts\/[a-f0-9]{64}-[a-f0-9]{64}\.blob$/.test(item.file))
        throw Error('coordinated_recovery_artifacts_changed');
      checkFile(item, 1024 ** 2);
    }
    current();
    checkFile(manifestFile, 1024 ** 2);
    return {
      receipt,
      checkpoint,
      nativeDatabasesVerified: receipt.sqlite.length,
      admissionRestored: false,
      eventJournalRestored: false,
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Recovered rows, native files and current journal diagnostics remain private.
    throw Error('coordinated_recovery_check_unavailable');
  }
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
export type CoordinatedTestRestoreStart = {
  format: 'cos-sandbox-restore-start/v1';
  checkpointDigest: string;
  sandboxDatabaseFingerprint: string;
  testMarkerDigest: string;
  scopeId: string;
  journal: CoordinatedBackupReceipt['journal'];
};
/** Trusted live storage only. Installed recovery must bind this port to a
 * separately admitted encrypted reservation, never a file from the archive.
 * Creation must be exclusive and durable before the first database insert. */
export type CoordinatedTestRestoreReservation = Readonly<{
  assertCurrent(): void;
  read(): unknown | undefined;
  create(start: CoordinatedTestRestoreStart): void;
}>;
type TestSandbox = { client: pg.Client; config: PoolConfig; testTargetId: string };
type CheckedCheckpoint = { receipt: CoordinatedBackupReceipt; checkpoint: ScopeCheckpoint };
/** Portable insert-only component. The installed caller must also validate the
 * complete capture and hold current owner, vault, repository and queue authority.
 * No filesystem path conversion or second recovered payload is needed. */
export async function restoreRecoveredCoordinatedTestScope(
  options: CoordinatedRecoveryIdentity,
  scope: BackupRestoreValidationScope,
  entries: BackupQueueReceipt['files'],
  sandbox: TestSandbox,
  reservation: CoordinatedTestRestoreReservation,
  check: () => Promise<void>,
) {
  try {
    const inventoryDigest = digest(entries);
    return await restoreCheckedTestScope(
      options,
      sandbox,
      reservation,
      async () => {
        scope.assertCurrent();
        if (digest(entries) !== inventoryDigest) throw Error('coordinated_restore_inventory_changed');
        await check();
        scope.assertCurrent();
        if (digest(entries) !== inventoryDigest) throw Error('coordinated_restore_inventory_changed');
      },
      async () => verifyRecoveredCoordinatedState(options, scope, entries),
    );
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Recovered content, reservation and test endpoint diagnostics remain private.
    throw Error('coordinated_test_restore_unavailable');
  }
}
async function restoreTestScope(
  options: CoordinatedBackupIdentity,
  operationRoot: string,
  sandbox: { client: pg.Client; config: PoolConfig; testTargetId: string },
  check: () => Promise<void>,
) {
  directory(operationRoot);
  if (
    [
      parameters(options),
      options.witness.root,
      options.artifacts.root,
      ...options.nativeDatabases,
      ...options.restrictionFiles,
    ].some(
      (root) => root === operationRoot || operationRoot.startsWith(root + '/') || root.startsWith(operationRoot + '/'),
    )
  )
    throw Error('unsafe_coordinated_restore');
  const file = path.join(operationRoot, 'restore-start.json');
  return restoreCheckedTestScope(
    options,
    sandbox,
    {
      assertCurrent: () => directory(operationRoot),
      read: () =>
        fs.lstatSync(file, { throwIfNoEntry: false })
          ? JSON.parse(privateBytes(file, 16384).toString('utf8'))
          : undefined,
      create: (start) => {
        if (fs.lstatSync(file, { throwIfNoEntry: false })) throw Error('coordinated_restore_conflict');
        writeAtomic(operationRoot, 'restore-start.json', start);
      },
    },
    check,
    async () => {
      const receipt = await verify(options);
      return { receipt, checkpoint: scopedCheckpoint(options, receipt) };
    },
  );
}
async function restoreCheckedTestScope(
  options: CoordinatedRecoveryIdentity,
  sandbox: TestSandbox,
  reservationPort: CoordinatedTestRestoreReservation,
  check: () => Promise<void>,
  verifyCheckpoint: () => Promise<CheckedCheckpoint>,
) {
  let locked = false,
    transaction = false;
  const client = sandbox.client,
    port = { ...reservationPort },
    configuration = () =>
      digest({
        context: options.context,
        databaseFingerprint: options.databaseFingerprint,
        operationId: options.operationId,
        nativeDatabases: options.nativeDatabases,
        restrictionFiles: options.restrictionFiles,
        artifactsRoot: options.artifacts.root,
        witness: {
          root: options.witness.root,
          installationDigest: options.witness.installationDigest,
          generation: options.witness.generation,
        },
        config: sandbox.config,
        testTargetId: sandbox.testTargetId,
      }),
    initial = configuration();
  const current = () => {
    if (
      sandbox.client !== client ||
      configuration() !== initial ||
      reservationPort.assertCurrent !== port.assertCurrent ||
      reservationPort.read !== port.read ||
      reservationPort.create !== port.create
    )
      throw Error('coordinated_restore_identity_changed');
    journalCurrent(options);
    port.assertCurrent();
  };
  const checked = async () => {
    current();
    await check();
    current();
  };
  try {
    await checked();
    const { receipt, checkpoint: original } = await verifyCheckpoint(),
      receiptDigest = digest(receipt),
      originalDigest = digest(original);
    await checked();
    await assertTestTarget(client, sandbox.testTargetId);
    const fingerprint = await databaseFingerprint(client, sandbox.config);
    if (fingerprint === options.databaseFingerprint || (await migrationStatus(client)) !== SCHEMA_VERSION)
      throw Error('unsafe_coordinated_restore');
    await checked();
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
    const reservation: CoordinatedTestRestoreStart = {
      format: 'cos-sandbox-restore-start/v1',
      checkpointDigest: digest(receipt),
      sandboxDatabaseFingerprint: fingerprint,
      testMarkerDigest: digest(sandbox.testTargetId),
      scopeId: original.scopeId,
      journal: receipt.journal,
    };
    const readStart = () => {
        current();
        const value = port.read();
        current();
        return value;
      },
      start = readStart(),
      started = start !== undefined;
    if (started && digest(start) !== digest(reservation)) throw Error('coordinated_restore_conflict');
    const unchanged = async () => {
      await checked();
      const verified = await verifyCheckpoint();
      await checked();
      if (
        digest(verified.receipt) !== receiptDigest ||
        digest(verified.checkpoint) !== originalDigest ||
        digest(original) !== originalDigest ||
        digest(receipt) !== receiptDigest
      )
        throw Error('coordinated_restore_conflict');
    };
    const admit = async () => {
      await checked();
      await assertTestTarget(client, sandbox.testTargetId);
      if (
        (await databaseFingerprint(client, sandbox.config)) !== fingerprint ||
        (await migrationStatus(client)) !== SCHEMA_VERSION
      )
        throw Error('coordinated_restore_identity_changed');
      await checked();
    };
    await unchanged();
    await admit();
    await client.query('BEGIN');
    transaction = true;
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const exists =
      (await client.query('SELECT id FROM cos.scopes WHERE id=$1 FOR UPDATE', [original.scopeId])).rows.length > 0;
    if (exists && !started) throw Error('coordinated_restore_scope_exists');
    if (!exists) {
      await checked();
      if (!started) {
        port.create(reservation);
        current();
      }
      if (digest(readStart()) !== digest(reservation)) throw Error('coordinated_restore_conflict');
      let remaining = CHECKPOINT_TABLES.filter((table) => original.rows[table].length > 0);
      while (remaining.length) {
        const retry: string[] = [];
        for (const table of remaining) {
          await admit();
          if (digest(original) !== originalDigest || digest(readStart()) !== digest(reservation))
            throw Error('coordinated_restore_conflict');
          await client.query('SAVEPOINT cos_sandbox_restore');
          try {
            await checked();
            if (digest(original) !== originalDigest || digest(readStart()) !== digest(reservation))
              throw Error('coordinated_restore_conflict');
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
    await unchanged();
    await admit();
    if (digest(readStart()) !== digest(reservation)) throw Error('coordinated_restore_conflict');
    await client.query('COMMIT');
    transaction = false;
    await checked();
    const restored = await remoteSnapshot({ context: options.context, databaseFingerprint: fingerprint, client });
    if (
      digest(checkpointState(restored)) !== digest(checkpointState(original)) ||
      digest(readStart()) !== digest(reservation)
    )
      throw Error('coordinated_restore_conflict');
    await unchanged();
    await admit();
    if (digest(readStart()) !== digest(reservation)) throw Error('coordinated_restore_conflict');
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
/** Verify copied bytes before any database import, without a login or archived authority. */
export async function verifyCoordinatedLocalSandbox(options: CoordinatedBackupIdentity, destination: string) {
  try {
    const receipt = await verify(options);
    if (
      [
        parameters(options),
        options.witness.root,
        options.artifacts.root,
        ...options.nativeDatabases,
        ...options.restrictionFiles,
      ].some((root) => root === destination || root.startsWith(destination + '/') || destination.startsWith(root + '/'))
    )
      throw Error('unsafe_coordinated_restore');
    await verifySandboxCopy(receipt, destination);
    if (digest(await verify(options)) !== digest(receipt)) throw Error('coordinated_restore_conflict');
    journalCurrent(options);
    return { checkpointDigest: digest(receipt), admissionRestored: false, eventJournalRestored: false };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Copied bytes and backup paths are never returned as diagnostics.
    throw Error('coordinated_restore_verification_unavailable');
  }
}
/** Verify an actual protected test-database restore and the isolated local copy. No mutation is issued.
 * Same-database fixture drills remain useful evidence but cannot admit a production writer.
 * A copied remote.json alone is never proof that the remote database was restored.
 */
export async function verifyCoordinatedSandbox(
  options: CoordinatedBackupIdentity,
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
