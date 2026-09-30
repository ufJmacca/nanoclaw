import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';

export type TargetBinding = {
  hostFingerprint: string;
  databaseFingerprint: string;
  service: string;
  installationRoot: string;
  dataRoot: string;
};
export type TargetState = {
  version: 1;
  binding: TargetBinding;
  lifecycle: 'implementation_disposable' | 'protected';
  generation: number;
  maintenance: boolean;
  maintenanceId?: string | null;
  maintenanceHistory?: boolean;
  /** A durable replacement reservation spanning the closed interval between deployment leases. */
  recoveryOwner?: string;
  releaseId: string | null;
};

function validBinding(binding: TargetBinding): boolean {
  return (
    !!binding &&
    /^[a-f0-9]{64}$/.test(binding.hostFingerprint) &&
    /^[a-f0-9]{64}$/.test(binding.databaseFingerprint) &&
    /^[a-zA-Z0-9_.@-]+\.service$/.test(binding.service) &&
    [binding.installationRoot, binding.dataRoot].every(
      (value) => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && value !== '/',
    )
  );
}
function privateRoot(root: string): void {
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    stat.uid !== process.getuid?.() ||
    fs.realpathSync(root) !== path.resolve(root)
  )
    throw new Error('unsafe_target_state');
}
export function readPrivate<T>(file: string, maximumBytes = 65536): T {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 * 1024)
    throw new Error('unsafe_target_state');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > maximumBytes)
      throw new Error('unsafe_target_state');
    return JSON.parse(fs.readFileSync(fd, 'utf8')) as T;
  } finally {
    fs.closeSync(fd);
  }
}
export function writeAtomic(root: string, name: string, value: unknown): void {
  const temporary = path.join(root, '.' + randomUUID() + '.tmp');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, path.join(root, name));
  const directory = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

/** Initialisation is allowed once by the standing programme authority, never from a replacement Mac ledger. */
export function initializeTarget(root: string, binding: TargetBinding): TargetState {
  if (!validBinding(binding)) throw new Error('invalid_target_binding');
  if (fs.existsSync(root) || fs.lstatSync(root, { throwIfNoEntry: false })) return readTarget(root, binding);
  fs.mkdirSync(root, { mode: 0o700 });
  privateRoot(root);
  const state: TargetState = {
    version: 1,
    binding,
    lifecycle: 'implementation_disposable',
    generation: 1,
    maintenance: true,
    maintenanceId: null,
    releaseId: null,
  };
  writeAtomic(root, 'state.json', state);
  return state;
}
export function readTarget(root: string, binding: TargetBinding): TargetState {
  if (!validBinding(binding)) throw new Error('invalid_target_binding');
  privateRoot(root);
  const state = readPrivate<TargetState>(path.join(root, 'state.json'));
  if (
    !state ||
    state.version !== 1 ||
    !validBinding(state.binding) ||
    digest(state.binding) !== digest(binding) ||
    !['implementation_disposable', 'protected'].includes(state.lifecycle) ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1 ||
    typeof state.maintenance !== 'boolean' ||
    (state.maintenanceHistory !== undefined && typeof state.maintenanceHistory !== 'boolean') ||
    (state.recoveryOwner !== undefined &&
      (typeof state.recoveryOwner !== 'string' ||
        !/^release-[a-zA-Z0-9_-]{1,120}$/.test(state.recoveryOwner) ||
        !state.maintenance)) ||
    (state.maintenanceId != null &&
      (typeof state.maintenanceId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(state.maintenanceId) ||
        !state.maintenance)) ||
    (state.releaseId !== null &&
      (typeof state.releaseId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(state.releaseId)))
  )
    throw new Error('target_state_conflict');
  const sealPath = path.join(root, 'protected.json');
  if (fs.lstatSync(sealPath, { throwIfNoEntry: false })) {
    const seal = readPrivate<{ bindingDigest: string; generation: number }>(sealPath);
    if (seal.bindingDigest !== digest(binding) || !Number.isSafeInteger(seal.generation) || seal.generation < 1)
      throw new Error('target_protection_conflict');
    return { ...state, lifecycle: 'protected', generation: Math.max(state.generation, seal.generation) };
  }
  if (state.lifecycle === 'protected') throw new Error('target_protection_history_missing');
  return state;
}

/** Never steals locks, including a lock left by an interrupted deployment. */
export function acquireTargetLock(root: string): () => void {
  privateRoot(root);
  const lock = path.join(root, 'deploy.lock'),
    nonce = randomUUID();
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('target_locked', { cause: error });
    throw error;
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ nonce, pid: process.pid }) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  let released = false;
  return () => {
    if (released) return;
    const owner = readPrivate<{ nonce: string }>(path.join(lock, 'owner.json'));
    if (owner.nonce !== nonce) throw new Error('target_lock_owner_changed');
    fs.unlinkSync(path.join(lock, 'owner.json'));
    fs.rmdirSync(lock);
    released = true;
  };
}
/** Synchronous atomic state transitions; asynchronous deployment uses acquireTargetLock explicitly. */
export function withTargetLock<T>(root: string, operation: () => T): T {
  const release = acquireTargetLock(root);
  try {
    return operation();
  } finally {
    release();
  }
}
export function protectTarget(root: string, binding: TargetBinding): TargetState {
  return withTargetLock(root, () => {
    const state = readTarget(root, binding);
    if (state.lifecycle === 'protected') return state;
    if (state.maintenanceId) throw new Error('active_maintenance_lease');
    const next: TargetState = { ...state, lifecycle: 'protected', generation: state.generation + 1, maintenance: true };
    // Seal first: a crash or stale state copy can tighten protection but cannot reopen disposal.
    writeAtomic(root, 'protected.json', { bindingDigest: digest(binding), generation: next.generation });
    writeAtomic(root, 'state.json', next);
    return next;
  });
}
