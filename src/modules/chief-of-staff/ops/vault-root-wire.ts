import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { VaultProvisionIdentity } from './vault-provision.js';
import type { VaultAuthorityScope } from './vault-authority.js';
import { verifyVaultMemory } from './vault-memory.js';
export type VaultRootHeader = {
  contract: 'cos-vault-root-request/v1' | 'cos-vault-root-recovery-check-request/v1';
  configurationDigest: string;
  identity: VaultProvisionIdentity;
  scope: VaultAuthorityScope;
  authority: { socket: string; token: string };
};
export type VaultRootWireControls = { assertMemory?(): void; deadlineMs?: number };
const maximumHeader = 4096,
  maximumFrame = 4 + maximumHeader + 64;
function validate(value: unknown): asserts value is VaultRootHeader {
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const uuid = (value: unknown) =>
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'authority,configurationDigest,contract,identity,scope' ||
    !['cos-vault-root-request/v1', 'cos-vault-root-recovery-check-request/v1'].includes(String(value.contract)) ||
    !hash(value.configurationDigest)
  )
    throw Error('invalid_root_frame');
  const { identity, scope, authority } = value;
  if (
    !object(identity) ||
    Object.keys(identity).sort().join(',') !== 'filesystemUuid,luksUuid,operationId,recoveryReference,targetDigest' ||
    !hash(identity.targetDigest) ||
    [identity.operationId, identity.recoveryReference, identity.luksUuid, identity.filesystemUuid].some(
      (field) => !uuid(field),
    ) ||
    !object(scope) ||
    Object.keys(scope).sort().join(',') !== 'generation,operationId,targetDigest' ||
    !uuid(scope.operationId) ||
    scope.targetDigest !== identity.targetDigest ||
    !Number.isSafeInteger(scope.generation) ||
    Number(scope.generation) < 1 ||
    !object(authority) ||
    Object.keys(authority).sort().join(',') !== 'socket,token' ||
    !hash(authority.token) ||
    typeof authority.socket !== 'string' ||
    !path.isAbsolute(authority.socket) ||
    path.resolve(authority.socket) !== authority.socket ||
    /[\0\r\n]/.test(authority.socket) ||
    Buffer.byteLength(authority.socket) > 100
  )
    throw Error('invalid_root_frame');
}
/** Dedicated private pipe only. The reader consumes/zeros received chunks; the caller owns and must clear returned recovery bytes. */
export async function readVaultRootRequest(
  stream: Readable,
  controls: VaultRootWireControls = {},
): Promise<{ header: VaultRootHeader; recovery: Buffer }> {
  const memory = controls.assertMemory ?? verifyVaultMemory;
  let staging: Buffer | undefined, recovery: Buffer | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    memory();
    const deadline = controls.deadlineMs ?? 15000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 15000) throw Error('invalid_root_deadline');
    staging = Buffer.alloc(maximumFrame);
    timer = setTimeout(() => stream.destroy(Error('vault_root_transport_unavailable')), deadline);
    let length = 0,
      headerLength: number | undefined;
    for await (const incoming of stream) {
      try {
        memory();
        if (!Buffer.isBuffer(incoming) || length + incoming.length > maximumFrame) throw Error('root_frame_bounds');
        incoming.copy(staging, length);
        length += incoming.length;
        if (length >= 4 && headerLength === undefined) {
          headerLength = staging.readUInt32BE(0);
          if (headerLength < 1 || headerLength > maximumHeader) throw Error('root_header_bounds');
        }
        if (headerLength !== undefined && length > 4 + headerLength + 64) throw Error('root_frame_extra_bytes');
        memory();
      } finally {
        if (Buffer.isBuffer(incoming)) incoming.fill(0);
      }
    }
    memory();
    if (headerLength === undefined || length !== 4 + headerLength + 64) throw Error('root_frame_truncated');
    const header: unknown = JSON.parse(staging.subarray(4, 4 + headerLength).toString('utf8'));
    validate(header);
    recovery = Buffer.from(staging.subarray(4 + headerLength, length));
    memory();
    Object.defineProperty(header.authority, 'token', { value: header.authority.token, enumerable: false });
    Object.freeze(header.authority);
    Object.freeze(header.identity);
    Object.freeze(header.scope);
    Object.freeze(header);
    const result = { header } as { header: VaultRootHeader; recovery: Buffer };
    Object.defineProperty(result, 'recovery', { value: recovery, enumerable: false });
    return Object.freeze(result);
  } catch {
    recovery?.fill(0);
    stream.destroy();
    // eslint-disable-next-line preserve-caught-error -- No capability, recovery material, frame contents or private paths may enter diagnostics.
    throw Error('vault_root_transport_unavailable');
  } finally {
    staging?.fill(0);
    if (timer) clearTimeout(timer);
  }
}
/** The binary recovery key never becomes JSON, argv, environment or a file. Ownership transfers through the pipe's write callback. */
export async function writeVaultRootRequest(
  stream: Writable,
  header: VaultRootHeader,
  key: Buffer,
  controls: VaultRootWireControls = {},
): Promise<void> {
  const memory = controls.assertMemory ?? verifyVaultMemory;
  let prefix: Buffer | undefined, metadata: Buffer | undefined, recovery: Buffer | undefined;
  try {
    memory();
    validate(header);
    if (!Buffer.isBuffer(key) || key.length !== 64) throw Error('invalid_recovery_bytes');
    metadata = Buffer.from(JSON.stringify(header));
    if (metadata.length > maximumHeader) throw Error('root_header_bounds');
    prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(metadata.length);
    recovery = Buffer.from(key);
    for (const bytes of [prefix, metadata, recovery]) {
      memory();
      await new Promise<void>((resolve, reject) => stream.write(bytes, (error) => (error ? reject(error) : resolve())));
      memory();
    }
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private write diagnostics must not disclose recovery or capability data.
    throw Error('vault_root_transport_unavailable');
  } finally {
    prefix?.fill(0);
    metadata?.fill(0);
    recovery?.fill(0);
  }
}
