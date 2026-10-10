import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { BackupNasMountClaim } from './backup-nas-mount-state.js';
import { verifyVaultMemory } from './vault-memory.js';
export type RootBackupNasControlLease = Readonly<{ signal: AbortSignal; assertCurrent(): Promise<void> }>;
/** Code-only child/deadline fixtures. The installed helper cannot select a utility, target or flags. */
export type BackupNasUnmountProcessControls = {
  assertRole?(): void;
  spawnUnmount?(command: string, args: string[], options: SpawnOptions): ChildProcess;
  deadlineMs?: number;
};
/** Disconnect only the fixed admitted mount. The caller holds its writer and compares
 * the exact kernel instance before execution and original closed underlay afterward.
 * Busy, timed-out or uncertain effects remain in the journal for reconciliation.
 */
export async function executeBackupNasUnmount(
  input: BackupNasMountClaim,
  lease: RootBackupNasControlLease,
  assertDestination: (phase: 'before' | 'after', claim: BackupNasMountClaim) => void,
  controls: BackupNasUnmountProcessControls = {},
): Promise<void> {
  let child: ChildProcess | undefined,
    closed: Promise<boolean> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    killTimer: ReturnType<typeof setTimeout> | undefined;
  let exited = false,
    stopped = false;
  const terminate = (signal: NodeJS.Signals) => {
    if (!child?.pid || exited) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const stop = () => {
    stopped = true;
    terminate('SIGTERM');
    if (child?.pid && !exited) killTimer ??= setTimeout(() => terminate('SIGKILL'), 250);
  };
  try {
    const role =
      controls.assertRole ??
      (() => {
        if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
          throw Error('root_required');
      });
    const guard = () => {
      verifyVaultMemory();
      role();
      if (stopped || lease.signal.aborted) throw Error('unmount_lease_unavailable');
    };
    guard();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'bindingDigest,device,id,inode' ||
      !Number.isSafeInteger(input.id) ||
      input.id < 1 ||
      !Number.isSafeInteger(input.device) ||
      input.device < 0 ||
      !Number.isSafeInteger(input.inode) ||
      input.inode < 1 ||
      typeof input.bindingDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.bindingDigest)
    )
      throw Error('invalid_mount_claim');
    const claim = Object.freeze({ ...input }),
      deadline = controls.deadlineMs ?? 5000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 5000) throw Error('invalid_unmount_deadline');
    await lease.assertCurrent();
    guard();
    assertDestination('before', claim);
    guard();
    child = (controls.spawnUnmount ?? spawn)(
      '/usr/bin/umount',
      ['--internal-only', '--no-canonicalize', '--no-mtab', '--types', 'cifs', '--', '/var/lib/nanoclaw-cos/nas'],
      {
        cwd: '/',
        detached: true,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    closed = new Promise<boolean>((resolve) => {
      child!.once('error', () => {
        stopped = true;
      });
      child!.once('close', (code, signal) => {
        exited = true;
        resolve(code === 0 && signal === null);
      });
    });
    lease.signal.addEventListener('abort', stop, { once: true });
    timer = setTimeout(stop, deadline);
    if (lease.signal.aborted) stop();
    if (!(await closed)) throw Error('unmount_command_failed');
    guard();
    await lease.assertCurrent();
    guard();
    assertDestination('after', claim);
    guard();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Utility, mount and authority diagnostics are private; no success is inferred from uncertain effects.
    throw Error('backup_nas_unmount_unavailable');
  } finally {
    if (timer) clearTimeout(timer);
    lease.signal.removeEventListener('abort', stop);
    try {
      if (child && !exited) stop();
      if (closed) await closed;
    } finally {
      if (killTimer) clearTimeout(killTimer);
    }
  }
}
