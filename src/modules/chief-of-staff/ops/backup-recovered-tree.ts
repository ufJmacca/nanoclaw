import type { CalendarCaptureReceipt } from '../calendar/backup.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { BACKUP_LIMITS } from './backup-policy.js';
import type { BackupQueueReceipt } from './backup-queue.js';
import type { BackupRestoreValidationScope } from './backup-restore-workspace.js';
export type ForensicCapturePrefix = 'effects' | 'vault-backup-credentials' | 'vault-journals';
export type ForensicCaptureReceipt = {
  contract: 'cos-private-tree-capture/v1';
  prefix: ForensicCapturePrefix;
  bytes: number;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  directories: string[];
  excluded: Array<{ name: '.vault-canary'; reason: 'host_bound_vault_proof'; metadataDigest: string }>;
};
const hex = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, fields: string[]) =>
  object(value) && Object.keys(value).sort().join(',') === fields.sort().join(',');
const bounded = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
const nameValid = (prefix: string, relative: unknown): relative is string =>
  typeof relative === 'string' &&
  Buffer.byteLength(prefix + '/' + relative) <= 192 &&
  relative.split('/').length <= 7 &&
  relative.split('/').every((part) => /^(?:[A-Za-z0-9]|\.cos-)[A-Za-z0-9_.-]*$/.test(part));
function recoveredEntries(entries: BackupQueueReceipt['files']) {
  if (
    !Array.isArray(entries) ||
    entries.length > 4096 ||
    new Set(entries.map((item) => item.name)).size !== entries.length
  )
    throw Error('recovered_tree_bounds');
  return new Map(entries.map((item) => [item.name, item]));
}
function checkEntry(
  scope: BackupRestoreValidationScope,
  entry: BackupQueueReceipt['files'][number] | undefined,
  maximum: number,
) {
  scope.assertCurrent();
  if (
    !entry ||
    !exact(entry, ['name', 'bytes', 'sha256']) ||
    !bounded(entry.bytes, maximum) ||
    typeof entry.sha256 !== 'string' ||
    !hex.test(entry.sha256)
  )
    throw Error('recovered_tree_file_bounds');
  const actual = scope.inspectFile(entry.name);
  if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw Error('recovered_tree_file_changed');
  scope.assertCurrent();
}
function metadata<T>(
  scope: BackupRestoreValidationScope,
  entries: Map<string, BackupQueueReceipt['files'][number]>,
  name: string,
) {
  const entry = entries.get(name);
  checkEntry(scope, entry, 1024 ** 2);
  return {
    entry: entry!,
    receipt: scope.withFileBytes(name, 1024 ** 2, (bytes) =>
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ) as T,
  };
}
/** Reconstruct the capture's sorted depth-first inventory using streamed owned-file
 * hashes. No credential bytes are parsed or installed. Empty directories are
 * created only after the complete original inventory passes. */
function inventory(
  scope: BackupRestoreValidationScope,
  entries: Map<string, BackupQueueReceipt['files'][number]>,
  prefix: string,
  recordedDirectories: string[],
  maximumFile: number,
  maximumTotal: number,
  maximumNodes = 4096,
) {
  if (
    !Array.isArray(recordedDirectories) ||
    recordedDirectories.length > 4096 ||
    new Set(recordedDirectories).size !== recordedDirectories.length
  )
    throw Error('recovered_tree_directories');
  const directories = new Set(recordedDirectories),
    files = new Map<string, BackupQueueReceipt['files'][number]>(),
    children = new Map<string, string[]>();
  if (entries.has(prefix)) throw Error('recovered_tree_graph');
  for (const entry of entries.values())
    if (entry.name.startsWith(prefix + '/')) files.set(entry.name.slice(prefix.length + 1), entry);
  if (directories.size + files.size > maximumNodes) throw Error('recovered_tree_bounds');
  for (const name of [...directories, ...files.keys()]) {
    if (!nameValid(prefix, name) || (files.has(name) && directories.has(name))) throw Error('recovered_tree_name');
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++)
      if (!directories.has(parts.slice(0, i).join('/'))) throw Error('recovered_tree_ancestor');
    const parent = path.posix.dirname(name),
      list = children.get(parent) ?? [];
    list.push(name);
    children.set(parent, list);
  }
  const hash = createHash('sha256'),
    orderedDirectories: string[] = [],
    orderedFiles: Array<{ name: string; bytes: number; sha256: string }> = [];
  let bytes = 0;
  const visit = (name: string) => {
    scope.assertCurrent();
    if (directories.has(name)) {
      orderedDirectories.push(name);
      hash.update(JSON.stringify([name, 'directory']) + '\n');
      for (const child of (children.get(name) ?? []).sort()) visit(child);
    } else {
      const entry = files.get(name)!;
      checkEntry(scope, entry, maximumFile);
      bytes += entry.bytes;
      if (bytes > maximumTotal) throw Error('recovered_tree_bounds');
      orderedFiles.push({ name, bytes: entry.bytes, sha256: entry.sha256 });
      hash.update(JSON.stringify([name, 'file', entry.bytes, entry.sha256]) + '\n');
    }
  };
  for (const name of (children.get('.') ?? []).sort()) visit(name);
  if (digest(orderedDirectories) !== digest(recordedDirectories)) throw Error('recovered_tree_order');
  return { bytes, files: orderedFiles, directories: orderedDirectories, sha256: hash.digest('hex') };
}
function restoreDirectories(scope: BackupRestoreValidationScope, prefix: string, directories: string[]) {
  scope.assertCurrent();
  scope.ensureDirectory(prefix);
  for (const name of directories) scope.ensureDirectory(prefix + '/' + name);
  scope.assertCurrent();
}
/** Portable forensic bytes are checked in isolation. Excluded host-bound canary
 * metadata cannot recreate a mount proof or become live journal authority. */
export function verifyRecoveredForensicTree(
  scope: BackupRestoreValidationScope,
  entries: BackupQueueReceipt['files'],
  prefix: ForensicCapturePrefix,
): ForensicCaptureReceipt {
  try {
    scope.assertCurrent();
    if (!['effects', 'vault-backup-credentials', 'vault-journals'].includes(prefix))
      throw Error('recovered_tree_prefix');
    const listed = recoveredEntries(entries),
      { receipt, entry } = metadata<ForensicCaptureReceipt>(scope, listed, prefix + '.capture.json');
    if (
      !exact(receipt, ['contract', 'prefix', 'bytes', 'files', 'directories', 'excluded']) ||
      receipt.contract !== 'cos-private-tree-capture/v1' ||
      receipt.prefix !== prefix ||
      !bounded(receipt.bytes, BACKUP_LIMITS.staging) ||
      !Array.isArray(receipt.files) ||
      receipt.files.length > 4096 ||
      !Array.isArray(receipt.excluded) ||
      receipt.excluded.length > 1
    )
      throw Error('recovered_tree_receipt');
    for (const item of receipt.excluded)
      if (
        prefix !== 'vault-journals' ||
        !exact(item, ['name', 'reason', 'metadataDigest']) ||
        item.name !== '.vault-canary' ||
        item.reason !== 'host_bound_vault_proof' ||
        typeof item.metadataDigest !== 'string' ||
        !hex.test(item.metadataDigest)
      )
        throw Error('recovered_tree_exclusion');
    const actual = inventory(
      scope,
      listed,
      prefix,
      receipt.directories,
      BACKUP_LIMITS.credentials,
      BACKUP_LIMITS.staging,
    );
    if (actual.bytes !== receipt.bytes || digest(actual.files) !== digest(receipt.files))
      throw Error('recovered_tree_inventory');
    restoreDirectories(scope, prefix, actual.directories);
    checkEntry(scope, entry, 1024 ** 2);
    return receipt;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Credential, journal and private path diagnostics stay in the recovery process.
    throw Error('forensic_tree_recovery_check_unavailable');
  }
}
export function verifyRecoveredCalendarState(
  scope: BackupRestoreValidationScope,
  entries: BackupQueueReceipt['files'],
  expected: { targetRoot: string; operationId: string },
): CalendarCaptureReceipt {
  try {
    scope.assertCurrent();
    if (
      !expected ||
      !path.isAbsolute(expected.targetRoot) ||
      path.resolve(expected.targetRoot) !== expected.targetRoot ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(expected.operationId)
    )
      throw Error('recovered_calendar_identity');
    const listed = recoveredEntries(entries),
      { receipt, entry } = metadata<CalendarCaptureReceipt>(scope, listed, 'calendar-capture-receipt.json');
    if (
      !exact(receipt, [
        'contract',
        'operationId',
        'targetDigest',
        'present',
        'storageDigest',
        'sha256',
        'files',
        'bytes',
        'directories',
      ]) ||
      receipt.contract !== 'cos-calendar-capture/v1' ||
      receipt.operationId !== expected.operationId ||
      receipt.targetDigest !== digest(expected.targetRoot) ||
      typeof receipt.present !== 'boolean' ||
      (receipt.present
        ? typeof receipt.storageDigest !== 'string' || !hex.test(receipt.storageDigest)
        : receipt.storageDigest !== null) ||
      typeof receipt.sha256 !== 'string' ||
      !hex.test(receipt.sha256) ||
      !bounded(receipt.files, 4096) ||
      !bounded(receipt.bytes, 64 * 1024 ** 2)
    )
      throw Error('recovered_calendar_receipt');
    const actual = inventory(scope, listed, 'calendar-state', receipt.directories, 1024 ** 2, 64 * 1024 ** 2, 8192);
    if (
      actual.sha256 !== receipt.sha256 ||
      actual.bytes !== receipt.bytes ||
      actual.files.length !== receipt.files ||
      (!receipt.present && (actual.bytes || actual.files.length || actual.directories.length))
    )
      throw Error('recovered_calendar_inventory');
    if (receipt.present) restoreDirectories(scope, 'calendar-state', actual.directories);
    checkEntry(scope, entry, 1024 ** 2);
    return receipt;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Recovered Calendar credentials and current private storage diagnostics remain private.
    throw Error('calendar_recovery_check_unavailable');
  }
}
