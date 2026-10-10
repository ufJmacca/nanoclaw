import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { withVaultSmbCredentials, type BackupSmbCredentialScope } from './backup-smb-credentials.js';
import { runtimeTestMessages, writeRuntimeTestMessage } from './runtime-test-wire.js';
import { verifyVaultMemory } from './vault-memory.js';

/** Enough fresh challenges for journal reconciliation; byte and wall-clock limits remain independent. */
export const BACKUP_SMB_MAX_CHALLENGES = 128;

export type BackupSmbOpenRequest = Readonly<{
  contract: 'cos-backup-smb-open/v1';
  owner: Readonly<{ uid: number; gid: number }>;
  roots: CalendarStorageRoots;
  expected: BackupSmbCredentialScope;
}>;
export type BackupSmbChallenge = Readonly<{
  contract: 'cos-backup-smb-challenge/v1';
  action: 'check' | 'release';
  sequence: number;
  nonce: string;
}>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, fields: string) => Object.keys(value).sort().join(',') === fields;
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function backupSmbOpenRequest(value: unknown): BackupSmbOpenRequest {
  if (
    !object(value) ||
    !keys(value, 'contract,expected,owner,roots') ||
    value.contract !== 'cos-backup-smb-open/v1' ||
    !object(value.owner) ||
    !keys(value.owner, 'gid,uid') ||
    !positive(value.owner.uid) ||
    !positive(value.owner.gid) ||
    !object(value.roots) ||
    !keys(value.roots, 'dataRoot,installationRoot,targetRoot') ||
    Object.values(value.roots).some(
      (root) =>
        typeof root !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(root) || path.resolve(root) !== root || root === '/',
    ) ||
    !object(value.expected) ||
    !keys(value.expected, 'credentialReference,filesystemUuid,minimumGeneration,targetDigest') ||
    !uuid(value.expected.filesystemUuid) ||
    !uuid(value.expected.credentialReference) ||
    typeof value.expected.targetDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.expected.targetDigest) ||
    !Number.isSafeInteger(value.expected.minimumGeneration) ||
    Number(value.expected.minimumGeneration) < 1
  )
    throw Error('backup_smb_probe_unavailable');
  return Object.freeze({
    ...value,
    owner: Object.freeze({ ...value.owner }),
    roots: Object.freeze({ ...value.roots }),
    expected: Object.freeze({ ...value.expected }),
  }) as BackupSmbOpenRequest;
}
export function backupSmbChallenge(value: unknown, sequence: number): BackupSmbChallenge {
  if (
    !object(value) ||
    !keys(value, 'action,contract,nonce,sequence') ||
    value.contract !== 'cos-backup-smb-challenge/v1' ||
    !['check', 'release'].includes(String(value.action)) ||
    value.sequence !== sequence ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > BACKUP_SMB_MAX_CHALLENGES ||
    !uuid(value.nonce)
  )
    throw Error('backup_smb_probe_unavailable');
  return Object.freeze({ ...value }) as BackupSmbChallenge;
}
/** Only public metadata crosses these pipes. Limit chunks and total bytes before JSON-line accumulation. */
export function backupSmbMessages(stream: Readable): AsyncGenerator<unknown> {
  async function* bounded() {
    let bytes = 0;
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk) || chunk.length > 8192 || (bytes += chunk.length) > 65536)
        throw Error('backup_smb_probe_unavailable');
      yield chunk;
    }
  }
  return runtimeTestMessages(bounded());
}
function ownerRole(owner: BackupSmbOpenRequest['owner']): void {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'arm64' ||
    process.getuid?.() !== owner.uid ||
    process.getgid?.() !== owner.gid ||
    process.getgroups?.().some((group) => group !== owner.gid)
  )
    throw Error('backup_smb_probe_unavailable');
}
/** The parent is the root process that actually spawned this child, never a caller-selected PID. */
function parentWitness(): () => void {
  const pid = process.ppid;
  const read = () => {
    if (process.platform !== 'linux' || process.arch !== 'arm64' || pid < 2 || process.ppid !== pid)
      throw Error('backup_smb_probe_unavailable');
    const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8'),
      stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    if (
      Buffer.byteLength(status) > 65536 ||
      Buffer.byteLength(stat) > 8192 ||
      !/^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(status)
    )
      throw Error('backup_smb_probe_unavailable');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (!/^[1-9][0-9]*$/.test(start ?? '')) throw Error('backup_smb_probe_unavailable');
    return start;
  };
  const start = read();
  return () => {
    if (read() !== start) throw Error('backup_smb_probe_unavailable');
  };
}
/** Code-only fixture seams; the installed command exposes no owner, parent or deadline override. */
export type BackupSmbProbeControls = {
  assertParent?(): void;
  assertOwner?(owner: BackupSmbOpenRequest['owner']): void;
  deadlineMs?: number;
};
export async function runBackupSmbCredentialProbe(
  input: Readable,
  output: Writable,
  controls: BackupSmbProbeControls = {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    verifyVaultMemory();
    const deadline = controls.deadlineMs ?? 30000;
    if (
      (input as Readable & { isTTY?: boolean }).isTTY ||
      (output as Writable & { isTTY?: boolean }).isTTY ||
      input.readableEncoding !== null ||
      !Number.isSafeInteger(deadline) ||
      deadline < 1 ||
      deadline > 30000
    )
      throw Error('invalid_probe_pipe');
    const until = Date.now() + deadline,
      parent = controls.assertParent ?? parentWitness(),
      owner = controls.assertOwner ?? ownerRole;
    const guard = () => {
      verifyVaultMemory();
      parent();
      if (Date.now() >= until) throw Error('probe_expired');
    };
    guard();
    timer = setTimeout(() => {
      input.destroy();
      output.destroy();
    }, deadline);
    const messages = backupSmbMessages(input);
    const first = await messages.next();
    guard();
    if (first.done) throw Error('missing_probe_request');
    const request = backupSmbOpenRequest(first.value);
    owner(request.owner);
    await withVaultSmbCredentials(request.roots, request.expected, async (lease) => {
      const current = () => {
        guard();
        owner(request.owner);
        lease.assertCurrent();
      };
      const reply = async (value: unknown) => {
        current();
        await writeRuntimeTestMessage(output, value);
        current();
      };
      current();
      const stat = fs.fstatSync(lease.fd);
      await reply({
        contract: 'cos-backup-smb-ready/v1',
        fd: lease.fd,
        filesystemUuid: lease.filesystemUuid,
        installationDigest: lease.installationDigest,
        file: {
          dev: stat.dev,
          ino: stat.ino,
          uid: stat.uid,
          gid: stat.gid,
          mode: stat.mode,
          nlink: stat.nlink,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        },
      });
      for (let sequence = 1; sequence <= BACKUP_SMB_MAX_CHALLENGES; sequence++) {
        const next = await messages.next();
        current();
        if (next.done) throw Error('probe_closed_without_release');
        const challenge = backupSmbChallenge(next.value, sequence);
        if (challenge.action === 'release') {
          // A successful release acknowledges the whole input, including any queued extra command.
          if (!(await messages.next()).done) throw Error('extra_probe_command');
          await reply({ contract: 'cos-backup-smb-released/v1', sequence, nonce: challenge.nonce });
          return;
        }
        await reply({ contract: 'cos-backup-smb-current/v1', sequence, nonce: challenge.nonce });
      }
      throw Error('probe_challenge_limit');
    });
    guard();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private owner and pipe diagnostics never leave this command.
    throw Error('backup_smb_probe_unavailable');
  } finally {
    if (timer) clearTimeout(timer);
    input.destroy();
  }
}
