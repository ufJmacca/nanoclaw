import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { backupNasMountCommand } from './backup-nas-units.js';
import type { RootBackupSmbLease } from './backup-smb-root-lease.js';
import { verifyVaultMemory } from './vault-memory.js';
export type BackupNasMountProcessControls = {
  assertRole?(): void;
  spawnMount?(command: string, args: string[], options: SpawnOptions): ChildProcess;
  deadlineMs?: number;
};
/** Command execution only, never provisioning or mount ownership. The installed caller
 * must admit the fixed claimed mountpoint before the effect and the actual signed kernel
 * mount after it. Failure is uncertain until that caller reconciles its owned mount state.
 */
export async function executeBackupNasMount(
  input: Parameters<typeof backupNasMountCommand>[0],
  lease: RootBackupSmbLease,
  assertDestination: (phase: 'before' | 'after') => void,
  controls: BackupNasMountProcessControls = {},
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
      if (stopped || lease.signal.aborted || !Number.isSafeInteger(lease.fd) || lease.fd < 3)
        throw Error('mount_lease_unavailable');
    };
    guard();
    const command = backupNasMountCommand(input),
      deadline = controls.deadlineMs ?? 20000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 20000) throw Error('invalid_mount_deadline');
    await lease.assertCurrent();
    guard();
    assertDestination('before');
    guard();
    child = (controls.spawnMount ?? spawn)(command.command, [...command.args], {
      cwd: '/',
      detached: true,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'ignore', 'ignore', lease.fd],
    });
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
    if (!(await closed)) throw Error('mount_command_failed');
    guard();
    await lease.assertCurrent();
    guard();
    assertDestination('after');
    guard();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Neither private mount utility diagnostics nor owner/destination errors enter status.
    throw Error('backup_nas_mount_unavailable');
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
