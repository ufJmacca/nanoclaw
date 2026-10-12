import { spawn } from 'node:child_process';
import type { VerifiedResticBinary } from './restic-artifact.js';
import type { BackupPassword } from './backup-password.js';
import type { SignedBackupRepository } from './backup-nas-access.js';
import type { BackupRepositoryLease } from './backup-repository-lease.js';
export type BackupResticScopes = {
  binary: VerifiedResticBinary;
  password: BackupPassword;
  repository: SignedBackupRepository;
  cache: Readonly<{ fd: number; assertCurrent(): void }>;
  writer: BackupRepositoryLease;
  timeoutMs?: number;
};
/** Trusted code-only process adapter. Installed callers construct all borrowed
 * scopes from verified factories and supply fixed operations, never CLI arguments. */
export function assertBackupResticScopes(o: BackupResticScopes): void {
  o.writer.assertCurrent();
  o.binary.assertCurrent();
  o.repository.assertCurrent();
  o.password.assertCurrent();
  o.cache.assertCurrent();
  for (const scope of [o.binary, o.repository, o.password, o.cache])
    if (!Number.isSafeInteger(scope.fd) || scope.fd < 3) throw Error('invalid_transfer_descriptor');
}
export async function* backupResticOutput(
  o: BackupResticScopes,
  args: string[],
  maximum: number,
): AsyncGenerator<Buffer> {
  try {
    assertBackupResticScopes(o);
    const child = spawn(
      '/proc/self/fd/3',
      ['--repo', '/proc/self/fd/5', '--password-file', '/proc/self/fd/4', '--no-cache', '--json', '--quiet', ...args],
      {
        cwd: '/',
        detached: true,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'Australia/Sydney', TMPDIR: '/proc/self/fd/6' },
        stdio: ['ignore', 'pipe', 'pipe', o.binary.fd, o.password.fd, o.repository.fd, o.cache.fd],
      },
    );
    const closed = new Promise<boolean>((resolve) => {
      child.once('error', () => resolve(false));
      child.once('close', (code, signal) => resolve(code === 0 && signal === null));
    });
    const terminate = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    let expired = false,
      withdrawn = false,
      completed = false,
      killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      terminate('SIGTERM');
      killTimer ??= setTimeout(() => terminate('SIGKILL'), 5000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, o.timeoutMs ?? 900000);
    timer.unref();
    const permissionTimer = setInterval(() => {
      try {
        assertBackupResticScopes(o);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Any withdrawn descriptor or target proof terminates the private subprocess; the awaited command reports the fixed error.
      } catch {
        withdrawn = true;
        stop();
      }
    }, 1000);
    permissionTimer.unref();
    try {
      if (!child.stdout || !child.stderr) throw Error('transfer_pipe_required');
      child.stderr.on('data', (bytes: Buffer) => bytes.fill(0));
      let bytes = 0;
      for await (const chunk of child.stdout) {
        const data = chunk as Buffer;
        try {
          bytes += data.length;
          if (expired || withdrawn || bytes > maximum) throw Error('transfer_output_bounds');
          for (let offset = 0; offset < data.length; offset += 65536) {
            assertBackupResticScopes(o);
            yield data.subarray(offset, offset + 65536);
            assertBackupResticScopes(o);
            if (expired || withdrawn) throw Error('transfer_permission_withdrawn');
          }
        } finally {
          data.fill(0);
        }
      }
      if (!(await closed) || expired || withdrawn) throw Error('transfer_command_failed');
      assertBackupResticScopes(o);
      completed = true;
    } catch {
      stop();
      await closed;
      // eslint-disable-next-line preserve-caught-error -- Stderr, paths, producer failures and command details remain private.
      throw Error('backup_transfer_unavailable');
    } finally {
      if (!completed) {
        stop();
        await closed;
      }
      clearTimeout(timer);
      clearInterval(permissionTimer);
      if (killTimer) clearTimeout(killTimer);
    }
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Descriptor proof errors must not leak private host state.
    throw Error('backup_transfer_unavailable');
  }
}
