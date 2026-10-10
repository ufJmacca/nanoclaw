import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { verifyVaultMemory } from './vault-memory.js';
export type VaultInstallRequest = {
  contract: 'cos-vault-root-install-request/v1';
  releaseId: string;
  configuration: VaultRootConfiguration;
  authority: { socket: string; token: string };
};
type Controls = { assertMemory?(): void; deadlineMs?: number };
const maximum = 16384;
function validate(input: unknown): VaultInstallRequest {
  const value = input as VaultInstallRequest;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'authority,configuration,contract,releaseId' ||
    value.contract !== 'cos-vault-root-install-request/v1' ||
    typeof value.releaseId !== 'string' ||
    !/^release-[a-zA-Z0-9_-]{1,120}$/.test(value.releaseId) ||
    !value.authority ||
    typeof value.authority !== 'object' ||
    Array.isArray(value.authority) ||
    Object.keys(value.authority).sort().join(',') !== 'socket,token' ||
    typeof value.authority.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.authority.token) ||
    typeof value.authority.socket !== 'string' ||
    !path.isAbsolute(value.authority.socket) ||
    path.resolve(value.authority.socket) !== value.authority.socket ||
    /[\0\r\n]/.test(value.authority.socket) ||
    Buffer.byteLength(value.authority.socket) > 100
  )
    throw Error('invalid_install_request');
  return { ...value, configuration: vaultRootConfiguration(value.configuration), authority: { ...value.authority } };
}
/** No recovery material is needed to install code/configuration. The live capability still uses a zeroed private pipe. */
export async function readVaultInstallRequest(stream: Readable, controls: Controls = {}): Promise<VaultInstallRequest> {
  let staging: Buffer | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    const deadline = controls.deadlineMs ?? 15000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 15000) throw Error('invalid_deadline');
    staging = Buffer.alloc(4 + maximum);
    timer = setTimeout(() => stream.destroy(Error('vault_install_transport_unavailable')), deadline);
    let length = 0,
      headerLength: number | undefined;
    for await (const bytes of stream) {
      try {
        memory();
        if (!Buffer.isBuffer(bytes) || length + bytes.length > staging.length) throw Error('frame_bounds');
        bytes.copy(staging, length);
        length += bytes.length;
        if (length >= 4 && headerLength === undefined) {
          headerLength = staging.readUInt32BE(0);
          if (headerLength < 1 || headerLength > maximum) throw Error('metadata_bounds');
        }
        if (headerLength !== undefined && length > 4 + headerLength) throw Error('extra_metadata');
        memory();
      } finally {
        if (Buffer.isBuffer(bytes)) bytes.fill(0);
      }
    }
    memory();
    if (headerLength === undefined || length !== 4 + headerLength) throw Error('truncated_metadata');
    const result = validate(JSON.parse(staging.subarray(4, length).toString('utf8')));
    memory();
    Object.defineProperty(result.authority, 'token', { value: result.authority.token, enumerable: false });
    Object.freeze(result.authority);
    return Object.freeze(result);
  } catch {
    stream.destroy();
    // eslint-disable-next-line preserve-caught-error -- Neither private target metadata nor owner capabilities are transport diagnostics.
    throw Error('vault_install_transport_unavailable');
  } finally {
    staging?.fill(0);
    if (timer) clearTimeout(timer);
  }
}
export async function writeVaultInstallRequest(stream: Writable, input: VaultInstallRequest, controls: Controls = {}) {
  let frame: Buffer | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    const value = validate(input),
      metadata = Buffer.from(JSON.stringify(value));
    try {
      if (metadata.length < 1 || metadata.length > maximum) throw Error('metadata_bounds');
      frame = Buffer.alloc(4 + metadata.length);
      frame.writeUInt32BE(metadata.length);
      metadata.copy(frame, 4);
    } finally {
      metadata.fill(0);
    }
    memory();
    await new Promise<void>((resolve, reject) => stream.write(frame!, (error) => (error ? reject(error) : resolve())));
    memory();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Pipe failures must never disclose the request or private capability.
    throw Error('vault_install_transport_unavailable');
  } finally {
    frame?.fill(0);
  }
}
