import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import {
  backupNasInitializationResource,
  type BackupNasInitializationResource,
} from './backup-nas-initialization-recovery-scope.js';
export type BackupNasInitializationProgress = Readonly<{
  contract: 'cos-backup-nas-initialization-progress/v1';
  nasDigest: string;
  vaultStateDigest: string;
  resource: BackupNasInitializationResource;
  phase: 'observed' | 'retired';
}>;
export type BackupNasInitializationProgressLease = {
  read(): BackupNasInitializationProgress | null;
  assertCurrent(): void;
  write(value: BackupNasInitializationProgress): Promise<void>;
};
type Scope = Pick<BackupNasInitializationProgress, 'nasDigest' | 'vaultStateDigest'>;
function record(value: unknown, scope: Scope): BackupNasInitializationProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_progress');
  const keys = Reflect.ownKeys(value).sort().join(','),
    { contract, nasDigest, vaultStateDigest, resource, phase } = value as Record<string, unknown>;
  if (
    keys !== 'contract,nasDigest,phase,resource,vaultStateDigest' ||
    contract !== 'cos-backup-nas-initialization-progress/v1' ||
    nasDigest !== scope.nasDigest ||
    vaultStateDigest !== scope.vaultStateDigest ||
    (phase !== 'observed' && phase !== 'retired')
  )
    throw Error('invalid_progress');
  return Object.freeze({
    contract,
    nasDigest,
    vaultStateDigest,
    resource: backupNasInitializationResource(resource),
    phase,
  });
}
/** This owner metadata only retains an already verified observation. It contains
 * no authority, credential or caller-selected path. The enclosing command holds
 * the exclusive native/maintenance leases; root must independently verify its
 * matching durable intent, current resource and fresh resource-bound permission.
 */
export async function withBackupNasInitializationProgress<T>(
  input: Scope & { root: string; check(): Promise<void> },
  operation: (lease: BackupNasInitializationProgressLease) => Promise<T>,
): Promise<T> {
  try {
    return await runProgress(input, operation);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private owner progress and cleanup diagnostics do not escape this boundary.
    throw Error('backup_nas_initialization_progress_unavailable');
  }
}
async function runProgress<T>(
  input: Scope & { root: string; check(): Promise<void> },
  operation: (lease: BackupNasInitializationProgressLease) => Promise<T>,
): Promise<T> {
  let parentFd: number | undefined,
    fd: number | undefined,
    closed = false,
    pending: Promise<void> | undefined;
  try {
    const root = input.root,
      scope = Object.freeze({ nasDigest: input.nasDigest, vaultStateDigest: input.vaultStateDigest }),
      check = input.check;
    if (
      process.platform !== 'linux' ||
      process.arch !== 'arm64' ||
      !process.getuid?.() ||
      !Object.values(scope).every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
    )
      throw Error('owner_required');
    const parent = fs.lstatSync(root);
    parentFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const parentHeld = parentFd,
      file = '/proc/self/fd/' + parentHeld + '/nas-initialization-progress.' + digest(scope) + '.json';
    let before: fs.Stats | undefined,
      value: BackupNasInitializationProgress | null = null;
    const parentCurrent = () => {
      if (closed) throw Error('closed_progress');
      for (const stat of [fs.fstatSync(parentHeld), fs.lstatSync(root)])
        if (
          !stat.isDirectory() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o700 ||
          stat.dev !== parent.dev ||
          stat.ino !== parent.ino ||
          fs.realpathSync(root) !== root
        )
          throw Error('progress_parent_changed');
    };
    const verifyFile = (held: number, named: string, accepted: fs.Stats) => {
      parentCurrent();
      for (const stat of [fs.fstatSync(held), fs.lstatSync(named)])
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o600 ||
          stat.nlink !== 1 ||
          stat.dev !== parent.dev ||
          stat.dev !== accepted.dev ||
          stat.ino !== accepted.ino ||
          stat.size < 1 ||
          stat.size > 4096 ||
          stat.size !== accepted.size ||
          stat.mtimeMs !== accepted.mtimeMs ||
          stat.ctimeMs !== accepted.ctimeMs
        )
          throw Error('progress_changed');
    };
    const openCurrent = () => {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      before = fs.fstatSync(fd);
      verifyFile(fd, file, before);
      const bytes = Buffer.alloc(before.size + 1);
      try {
        if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== before.size) throw Error('progress_changed');
        verifyFile(fd, file, before);
        value = record(JSON.parse(bytes.subarray(0, before.size).toString('utf8')), scope);
        if (bytes.subarray(0, before.size).toString('utf8') !== JSON.stringify(value) + '\n')
          throw Error('noncanonical_progress');
      } finally {
        bytes.fill(0);
      }
    };
    const guard = () => {
      parentCurrent();
      if (fd === undefined) {
        if (fs.lstatSync(file, { throwIfNoEntry: false })) throw Error('progress_appeared');
      } else verifyFile(fd, file, before!);
    };
    const current = async () => {
      guard();
      await check();
      guard();
    };
    parentCurrent();
    await check();
    parentCurrent();
    if (fs.lstatSync(file, { throwIfNoEntry: false })) openCurrent();
    await current();
    if (fd !== undefined) fs.fsyncSync(fd);
    fs.fsyncSync(parentHeld);
    await current();
    const lease: BackupNasInitializationProgressLease = {
      read() {
        guard();
        return value;
      },
      assertCurrent: guard,
      async write(selected) {
        if (pending || closed) throw Error('progress_busy_or_closed');
        const next = record(selected, scope),
          prior = value;
        if (
          (!prior && next.phase !== 'observed') ||
          (prior?.phase === 'observed' && digest(prior.resource) !== digest(next.resource)) ||
          (next.phase === 'retired' && (!prior || digest(prior.resource) !== digest(next.resource)))
        )
          throw Error('progress_transition_denied');
        const write = async () => {
          await current();
          const temporary = '/proc/self/fd/' + parentHeld + '/.nas-initialization-progress.' + randomUUID() + '.tmp';
          let tmpFd: number | undefined,
            tmpStat: fs.Stats | undefined,
            published = false;
          try {
            tmpFd = fs.openSync(
              temporary,
              fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
              0o600,
            );
            fs.writeFileSync(tmpFd, JSON.stringify(next) + '\n');
            fs.fsyncSync(tmpFd);
            tmpStat = fs.fstatSync(tmpFd);
            verifyFile(tmpFd, temporary, tmpStat);
            await current();
            verifyFile(tmpFd, temporary, tmpStat);
            fs.renameSync(temporary, file);
            published = true;
            fs.fsyncSync(parentHeld);
            if (fd !== undefined) {
              const previousFd = fd;
              fd = undefined;
              fs.closeSync(previousFd);
            }
            openCurrent();
            if (digest(value) !== digest(next)) throw Error('progress_publication_changed');
            fs.fsyncSync(fd!);
            fs.fsyncSync(parentHeld);
            await current();
          } finally {
            try {
              if (!published && tmpFd !== undefined && tmpStat) {
                verifyFile(tmpFd, temporary, tmpStat);
                fs.unlinkSync(temporary);
                fs.fsyncSync(parentHeld);
              }
            } finally {
              if (tmpFd !== undefined) fs.closeSync(tmpFd);
            }
          }
        };
        pending = write();
        try {
          await pending;
        } finally {
          pending = undefined;
        }
      },
    };
    const result = await operation(Object.freeze(lease));
    if (pending) {
      await pending;
      throw Error('detached_progress_write');
    }
    await current();
    return result;
  } finally {
    closed = true;
    try {
      await pending;
    } finally {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } finally {
        if (parentFd !== undefined) fs.closeSync(parentFd);
      }
    }
  }
}
