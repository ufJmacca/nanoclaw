import fs from 'node:fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { BACKUP_SMB_MAX_CHALLENGES, backupSmbMessages, backupSmbOpenRequest } from './backup-smb-probe.js';
import { writeRuntimeTestMessage } from './runtime-test-wire.js';
import { verifyVaultMemory } from './vault-memory.js';
import { verifyVaultRootArtifact, withVaultRootArtifact } from './vault-root-artifact.js';
import {
  readVaultRootConfiguration,
  vaultRootConfiguration,
  type VaultRootConfiguration,
} from './vault-root-config.js';

export type RootBackupSmbLease = Readonly<{
  fd: number;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}>;
/** Source-only composition seams. Installed callers use only the selected root configuration and sealed helper. */
export type RootBackupSmbControls = {
  assertMemory?(): void;
  assertRole?(): void;
  readConfiguration?: typeof readVaultRootConfiguration;
  verifyArtifact?: (config: VaultRootConfiguration) => void;
  spawnOwner?(command: string, args: string[], options: SpawnOptions): ChildProcess;
  deadlineMs?: number;
};
function fileIdentity(stat: fs.Stats) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function readyMetadata(value: unknown, config: VaultRootConfiguration) {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'contract,fd,file,filesystemUuid,installationDigest' ||
    value.contract !== 'cos-backup-smb-ready/v1' ||
    !Number.isSafeInteger(value.fd) ||
    Number(value.fd) < 3 ||
    Number(value.fd) > 1023 ||
    value.filesystemUuid !== config.identity.filesystemUuid ||
    typeof value.installationDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.installationDigest) ||
    !object(value.file) ||
    Object.keys(value.file).sort().join(',') !== 'ctimeMs,dev,gid,ino,mode,mtimeMs,nlink,size,uid'
  )
    throw Error('invalid_owner_descriptor');
  const file = value.file;
  if (
    ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size'].some(
      (name) => !Number.isSafeInteger(file[name]) || Number(file[name]) < 1,
    ) ||
    ['mtimeMs', 'ctimeMs'].some(
      (name) => typeof file[name] !== 'number' || !Number.isFinite(file[name]) || file[name] < 0,
    ) ||
    file.uid !== config.owner.uid ||
    file.gid !== config.owner.gid ||
    file.nlink !== 1 ||
    (Number(file.mode) & 0o7777) !== 0o600 ||
    (Number(file.mode) & fs.constants.S_IFMT) !== fs.constants.S_IFREG ||
    Number(file.size) < Buffer.byteLength('username=nanoclaw-cos-backup\npassword=') + 17 ||
    Number(file.size) > Buffer.byteLength('username=nanoclaw-cos-backup\npassword=') + 65
  )
    throw Error('invalid_owner_descriptor');
  return Object.freeze({ fd: Number(value.fd), file: Object.freeze({ ...file }) });
}
/** Fixed root-to-owner process boundary. Only the child actually spawned here can supply
 * a descriptor. The root duplicate is compared with its live metadata before/after every
 * fresh challenge. No secret is read by this process or passed in argv/environment.
 * Effects must honor the abort signal and await their owned subprocess termination.
 */
export async function withRootBackupSmbCredentials<T>(
  input: VaultRootConfiguration,
  credentialReference: string,
  operation: (lease: RootBackupSmbLease) => Promise<T>,
  controls: RootBackupSmbControls = {},
): Promise<T> {
  try {
    if (controls.verifyArtifact) return await rootBackupSmbSession(input, credentialReference, operation, controls);
    return await withVaultRootArtifact(
      input,
      (artifact) =>
        rootBackupSmbSession(input, credentialReference, operation, {
          ...controls,
          verifyArtifact: () => artifact.assertCurrent(),
        }),
      { assertMemory: controls.assertMemory, assertRole: controls.assertRole },
    );
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Artifact custody and root/owner effects remain private.
    throw Error('backup_smb_root_lease_unavailable');
  }
}
async function rootBackupSmbSession<T>(
  input: VaultRootConfiguration,
  credentialReference: string,
  operation: (lease: RootBackupSmbLease) => Promise<T>,
  controls: RootBackupSmbControls = {},
): Promise<T> {
  let fd: number | undefined,
    child: ChildProcess | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    killTimer: ReturnType<typeof setTimeout> | undefined,
    closed: Promise<boolean> | undefined;
  let active = false,
    exited = false,
    releasing = false;
  const abort = new AbortController();
  const failed = new Promise<never>((_resolve, reject) => {
    abort.signal.addEventListener('abort', () => reject(Error('backup_smb_root_lease_unavailable')), { once: true });
  });
  // Failure can occur between awaited pipe operations. Its eventual race still observes it.
  void failed.catch(() => {});
  const within = <V>(promise: Promise<V>) => Promise.race([promise, failed]);
  const terminate = (signal: NodeJS.Signals) => {
    if (!child?.pid || exited) return;
    try {
      process.kill(-child.pid, signal);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Signal failure aborts admission; cleanup must still await actual owner closure.
    } catch (error) {
      // Signal denial must not skip the awaited close below or escape a timer callback.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') abort.abort();
    }
  };
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory,
      role =
        controls.assertRole ??
        (() => {
          if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
            throw Error('root_required');
        });
    memory();
    role();
    const config = vaultRootConfiguration(input),
      configDigest = digest(config),
      deadline = controls.deadlineMs ?? 25000;
    const request = backupSmbOpenRequest({
      contract: 'cos-backup-smb-open/v1',
      owner: { uid: config.owner.uid, gid: config.owner.gid },
      roots: {
        targetRoot: config.owner.targetRoot,
        installationRoot: config.target.binding.installationRoot,
        dataRoot: config.target.binding.dataRoot,
      },
      expected: {
        filesystemUuid: config.identity.filesystemUuid,
        targetDigest: config.identity.targetDigest,
        minimumGeneration: config.target.minimumGeneration,
        credentialReference,
      },
    });
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 25000) throw Error('invalid_root_deadline');
    const until = Date.now() + deadline;
    const trusted = () => {
      memory();
      role();
      if (abort.signal.aborted || Date.now() >= until) throw Error('root_lease_expired');
      const current = (controls.readConfiguration ?? readVaultRootConfiguration)();
      if (digest(current) !== configDigest) throw Error('root_configuration_changed');
      (controls.verifyArtifact ?? verifyVaultRootArtifact)(current);
    };
    trusted();
    const root = '/opt/nanoclaw-cos/vault/' + config.artifact.digest;
    child = (controls.spawnOwner ?? spawn)(
      '/usr/bin/setpriv',
      [
        '--clear-groups',
        '--reuid=' + config.owner.uid,
        '--regid=' + config.owner.gid,
        '--bounding-set=-all',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '--',
        root + '/node',
        root + '/gateway.mjs',
        '--backup-credential-probe',
      ],
      {
        cwd: '/',
        detached: true,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: config.owner.home },
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    const owned = child,
      pid = child.pid;
    closed = new Promise<boolean>((resolve) => {
      owned.once('error', () => abort.abort());
      owned.once('close', (code, signal) => {
        exited = true;
        resolve(code === 0 && signal === null);
        if (!releasing) abort.abort();
      });
    });
    timer = setTimeout(
      () => {
        abort.abort();
        terminate('SIGTERM');
      },
      Math.max(1, until - Date.now()),
    );
    if (!pid || !owned.stdin || !owned.stdout) throw Error('owner_pipe_required');
    owned.stdin.on('error', () => abort.abort());
    const messages = backupSmbMessages(owned.stdout);
    await within(writeRuntimeTestMessage(owned.stdin, request));
    const first = await within(messages.next());
    trusted();
    if (first.done || exited) throw Error('owner_descriptor_missing');
    const ready = readyMetadata(first.value, config);
    const childIdentity = () => {
      if (exited || owned.pid !== pid) throw Error('owner_process_changed');
      const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8'),
        stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      if (Buffer.byteLength(status) > 65536 || Buffer.byteLength(stat) > 8192) throw Error('owner_process_bounds');
      for (const [label, id] of [
        ['Uid', config.owner.uid],
        ['Gid', config.owner.gid],
      ] as const) {
        const fields = status.match(new RegExp('^' + label + ':\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*$', 'm'));
        if (!fields || fields.slice(1).some((value) => Number(value) !== id)) throw Error('owner_process_changed');
      }
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      if (!/^[1-9][0-9]*$/.test(start ?? '')) throw Error('owner_process_changed');
      return start;
    };
    const start = childIdentity();
    // Intentionally follow only this controlled procfs alias, after verifying its actual child identity.
    fd = fs.openSync('/proc/' + pid + '/fd/' + ready.fd, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const heldFd = fd,
      initial = digest(ready.file);
    const descriptor = () => {
      if (childIdentity() !== start || digest(fileIdentity(fs.fstatSync(heldFd))) !== initial)
        throw Error('owner_descriptor_changed');
    };
    descriptor();
    active = true;
    let sequence = 0,
      checking = false;
    const challenge = async (action: 'check' | 'release') => {
      if (!active || checking || ++sequence > BACKUP_SMB_MAX_CHALLENGES) throw Error('root_lease_released');
      checking = true;
      try {
        trusted();
        descriptor();
        const nonce = randomUUID();
        await within(
          writeRuntimeTestMessage(owned.stdin!, { contract: 'cos-backup-smb-challenge/v1', action, sequence, nonce }),
        );
        if (action === 'release') {
          releasing = true;
          owned.stdin!.end();
        }
        const next = await within(messages.next());
        if (
          next.done ||
          !object(next.value) ||
          Object.keys(next.value).sort().join(',') !== 'contract,nonce,sequence' ||
          next.value.contract !== (action === 'check' ? 'cos-backup-smb-current/v1' : 'cos-backup-smb-released/v1') ||
          next.value.nonce !== nonce ||
          next.value.sequence !== sequence
        )
          throw Error('owner_challenge_failed');
        trusted();
        if (action === 'check') descriptor();
        else if (digest(fileIdentity(fs.fstatSync(heldFd))) !== initial) throw Error('owner_descriptor_changed');
      } finally {
        checking = false;
      }
    };
    const assertCurrent = async () => {
      try {
        await challenge('check');
      } catch {
        // eslint-disable-next-line preserve-caught-error -- The live challenge and descriptor diagnostics are private.
        throw Error('backup_smb_root_lease_unavailable');
      }
    };
    await assertCurrent();
    const lease = Object.freeze({ fd: heldFd, signal: abort.signal, assertCurrent });
    const result = await within(operation(lease));
    await assertCurrent();
    await challenge('release');
    if (!(await within(messages.next())).done || !(await within(closed))) throw Error('owner_release_failed');
    trusted();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Root/owner effects can include secret utility diagnostics.
    throw Error('backup_smb_root_lease_unavailable');
  } finally {
    active = false;
    abort.abort();
    if (timer) clearTimeout(timer);
    try {
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      terminate('SIGTERM');
      if (child?.pid && !exited) killTimer = setTimeout(() => terminate('SIGKILL'), 250);
      if (closed) await closed;
    } finally {
      if (killTimer) clearTimeout(killTimer);
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
