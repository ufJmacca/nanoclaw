import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { backupNasSetupRequest, writeBackupNasSetupRequest } from './backup-nas-setup-wire.js';
import { backupNasRecoveryRequest, writeBackupNasRecoveryRequest } from './backup-nas-recovery-wire.js';
import { runtimeTestMessages } from './runtime-test-wire.js';
import { verifyVaultMemory } from './vault-memory.js';
export type BackupNasProcessControls = {
  assertMemory?(): void;
  deadlineMs?: number;
  spawnRoot?(command: string, args: string[], options: SpawnOptions): ChildProcess;
  stopUnit?(unit: string): boolean;
};
export function backupNasProcessInvocation(
  kind: 'setup' | 'recovery' | 'inspection',
  input: VaultRootConfiguration,
  selected: unknown,
): { tool: string; unit: string; env: Record<string, string>; args: string[] } {
  if (kind !== 'setup' && kind !== 'recovery' && kind !== 'inspection') throw Error('backup_nas_process_unavailable');
  const vault = vaultRootConfiguration(input),
    request = kind === 'recovery' ? backupNasRecoveryRequest(selected, vault) : backupNasSetupRequest(selected, vault),
    root = '/opt/nanoclaw-cos/vault/' + vault.artifact.digest;
  const unit = 'nanoclaw-cos-backup-' + kind + '-' + request.scope.operationId + '-' + randomUUID() + '.service',
    env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' };
  return {
    tool: '/usr/bin/sudo',
    unit,
    env,
    args: [
      '-n',
      '/usr/bin/systemd-run',
      '--quiet',
      '--pipe',
      '--wait',
      '--collect',
      '--unit=' + unit,
      '--property=LimitCORE=0',
      '--property=MemorySwapMax=0',
      '--property=RuntimeMaxSec=90',
      '--property=TimeoutStopSec=5',
      '--property=KillMode=control-group',
      '--property=UMask=0077',
      '--',
      '/usr/bin/env',
      '-i',
      'PATH=' + env.PATH,
      'LANG=C',
      'LC_ALL=C',
      root + '/node',
      root + '/gateway.mjs',
      kind === 'setup'
        ? '--backup-configure'
        : kind === 'inspection'
          ? '--backup-inspect-initialization'
          : '--backup-recover-unmount',
    ],
  };
}
/** A fixed transient root unit carries private metadata only. The owner keeps its
 * permission live through actual child closure; failed or stalled callers terminate
 * only their generated unit and owned process group, and cannot acknowledge an operation.
 */
export async function executeBackupNasProcess(
  kind: 'setup' | 'recovery' | 'inspection',
  input: VaultRootConfiguration,
  selected: unknown,
  check: () => Promise<void>,
  controls: BackupNasProcessControls = {},
): Promise<unknown> {
  let child: ChildProcess | undefined,
    closed: Promise<boolean> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    killTimer: ReturnType<typeof setTimeout> | undefined,
    command: ReturnType<typeof backupNasProcessInvocation> | undefined;
  let exited = false,
    stopped = false,
    failed = false,
    complete = false,
    reply: unknown;
  const unavailable = 'backup_nas_' + kind + '_process_unavailable';
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => {});
  const terminate = (signal: NodeJS.Signals) => {
    if (!child?.pid || exited) return;
    try {
      process.kill(-child.pid, signal);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Signal callbacks retain only failure status and still await owned-process closure.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failed = true;
    }
  };
  const stop = () => {
    stopped = true;
    rejectFailure(Error(unavailable));
    terminate('SIGTERM');
    if (child?.pid && !exited) killTimer ??= setTimeout(() => terminate('SIGKILL'), 250);
  };
  const within = <T>(promise: Promise<T>) => Promise.race([promise, failure]);
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory,
      vault = vaultRootConfiguration(input),
      request =
        kind === 'recovery' ? backupNasRecoveryRequest(selected, vault) : backupNasSetupRequest(selected, vault),
      deadline = controls.deadlineMs ?? 95000,
      until = Date.now() + deadline;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 95000) throw Error('invalid_setup_deadline');
    const guard = () => {
      memory();
      if (
        process.platform !== 'linux' ||
        process.arch !== 'arm64' ||
        !process.getuid?.() ||
        process.getuid?.() !== vault.owner.uid ||
        process.getgid?.() !== vault.owner.gid ||
        stopped ||
        Date.now() >= until
      )
        throw Error('owner_setup_process_unavailable');
    };
    guard();
    await check();
    guard();
    command = backupNasProcessInvocation(kind, vault, request);
    child = (controls.spawnRoot ?? spawn)(command.tool, command.args, {
      cwd: '/',
      detached: true,
      env: command.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    closed = new Promise<boolean>((resolve) => {
      child!.once('error', stop);
      child!.once('close', (code, signal) => {
        exited = true;
        resolve(code === 0 && signal === null);
      });
    });
    timer = setTimeout(stop, Math.max(1, until - Date.now()));
    if (!child.stdin || !child.stdout) throw Error('setup_pipe_unavailable');
    child.stdin.on('error', () => {});
    await within(
      kind !== 'recovery'
        ? writeBackupNasSetupRequest(child.stdin, vault, backupNasSetupRequest(request, vault), { assertMemory: guard })
        : writeBackupNasRecoveryRequest(child.stdin, vault, backupNasRecoveryRequest(request, vault), {
            assertMemory: guard,
          }),
    );
    child.stdin.end();
    let replies = 0;
    await within(
      (async () => {
        for await (const value of runtimeTestMessages(child!.stdout!)) {
          guard();
          if (++replies !== 1) throw Error('setup_reply_count');
          reply = value;
        }
      })(),
    );
    if (!(await within(closed)) || replies !== 1) throw Error('setup_child_unverified');
    guard();
    await check();
    guard();
    complete = true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Keep failure status while the owned process and unit are closed below.
  } catch {
    failed = true;
  } finally {
    if (timer) clearTimeout(timer);
    if (child && !complete) {
      stop();
      child.stdin?.destroy();
      child.stdout?.destroy();
      try {
        if (
          !command ||
          !(
            controls.stopUnit ??
            ((unit) => {
              const result = spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'stop', unit], {
                cwd: '/',
                env: command!.env,
                stdio: 'ignore',
                timeout: 10000,
              });
              return !result.error && !result.signal && result.status === 0;
            })
          )(command.unit)
        )
          failed = true;
        // eslint-disable-next-line no-catch-all/no-catch-all -- Unit stop diagnostics are private; failed cleanup cannot acknowledge installation.
      } catch {
        failed = true;
      }
    }
    if (closed) await closed;
    if (killTimer) clearTimeout(killTimer);
  }
  if (failed || !complete) throw Error(unavailable);
  return reply;
}
