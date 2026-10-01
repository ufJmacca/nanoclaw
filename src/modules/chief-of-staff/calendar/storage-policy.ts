import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from '../ops/target-state.js';
import { verifyEncryptedCalendarDirectory, type StorageInspection, type StorageProof } from './storage-protection.js';
export type CalendarStorageRoots = { targetRoot: string; installationRoot: string; dataRoot: string };
export type CalendarStoragePolicy = {
  contract: 'cos-calendar-storage/v1';
  targetDigest: string;
  credentials: StorageProof;
  backupRoot: string;
  backups: StorageProof;
};
const filename = 'calendar-storage.json',
  marker = '.cos-calendar-backups';
const overlap = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
function rootGuard(roots: CalendarStorageRoots, backupRoot: string): void {
  for (const root of [...Object.values(roots), backupRoot])
    if (!path.isAbsolute(root) || path.resolve(root) !== root || /[\0\r\n]/.test(root))
      throw new Error('unsafe_storage_root');
  const target = fs.lstatSync(roots.targetRoot);
  if (
    !target.isDirectory() ||
    fs.realpathSync(roots.targetRoot) !== roots.targetRoot ||
    target.uid !== process.getuid?.() ||
    (target.mode & 0o777) !== 0o700 ||
    [roots.installationRoot, roots.dataRoot].some((root) => overlap(root, roots.targetRoot)) ||
    Object.values(roots).some((root) => overlap(root, backupRoot))
  )
    throw new Error('unsafe_storage_root');
}
function read(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) throw new Error('unsafe_storage_policy');
  return readPrivate(file, 16384);
}
function policyAt(roots: CalendarStorageRoots): CalendarStoragePolicy {
  const value = read(path.join(roots.targetRoot, filename));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_storage_policy');
  const policy = value as CalendarStoragePolicy;
  if (
    Object.keys(policy).sort().join(',') !== 'backupRoot,backups,contract,credentials,targetDigest' ||
    policy.contract !== 'cos-calendar-storage/v1' ||
    typeof policy.backupRoot !== 'string' ||
    policy.targetDigest !== digest(roots.targetRoot)
  )
    throw new Error('invalid_storage_policy');
  return policy;
}
function currentPolicy(
  roots: CalendarStorageRoots,
  backupRoot: string,
  inspect?: StorageInspection,
): CalendarStoragePolicy {
  rootGuard(roots, backupRoot);
  return {
    contract: 'cos-calendar-storage/v1',
    targetDigest: digest(roots.targetRoot),
    credentials: verifyEncryptedCalendarDirectory(path.join(roots.targetRoot, 'calendar'), inspect),
    backupRoot,
    backups: verifyEncryptedCalendarDirectory(backupRoot, inspect),
  };
}
function owner(roots: CalendarStorageRoots, backupRoot: string, initialize: boolean): void {
  const expected = { contract: 'cos-calendar-backups/v1', targetDigest: digest(roots.targetRoot) };
  const file = path.join(backupRoot, marker);
  if (!fs.lstatSync(file, { throwIfNoEntry: false }) && initialize && !fs.readdirSync(backupRoot).length)
    writeAtomic(backupRoot, marker, expected);
  if (digest(read(file)) !== digest(expected)) throw new Error('calendar_backup_owner_mismatch');
}
/** Explicit owner setup only; the caller holds the target and host/maintenance leases. No tokens are read here. */
export function configureCalendarStorage(
  roots: CalendarStorageRoots,
  backupRoot: string,
  inspect?: StorageInspection,
): CalendarStoragePolicy {
  try {
    const current = currentPolicy(roots, backupRoot, inspect);
    const existing = !!fs.lstatSync(path.join(roots.targetRoot, filename), { throwIfNoEntry: false });
    if (existing && digest(policyAt(roots)) !== digest(current)) throw new Error('calendar_storage_policy_conflict');
    owner(roots, backupRoot, !existing);
    if (digest(currentPolicy(roots, backupRoot, inspect)) !== digest(current))
      throw new Error('calendar_storage_changed');
    writeAtomic(roots.targetRoot, filename, current);
    return verifyCalendarStorage(roots, inspect);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Configuration/inspection diagnostics may contain private paths or user content.
    throw new Error('calendar_storage_policy_unavailable');
  }
}
/** Runtime and backup verification never initialize policy or repair lost ownership. */
export function verifyCalendarStorage(roots: CalendarStorageRoots, inspect?: StorageInspection): CalendarStoragePolicy {
  try {
    const expected = policyAt(roots),
      current = currentPolicy(roots, expected.backupRoot, inspect);
    if (digest(current) !== digest(expected)) throw new Error('calendar_storage_changed');
    owner(roots, current.backupRoot, false);
    return current;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Return one fixed failure without leaking host paths or private policy bytes.
    throw new Error('calendar_storage_policy_unavailable');
  }
}
