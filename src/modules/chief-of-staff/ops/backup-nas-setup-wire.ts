import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';
import type { VaultAuthorityScope } from './vault-authority.js';
import { verifyVaultMemory } from './vault-memory.js';
export type BackupNasSetupRequest = {
  contract: 'cos-backup-nas-setup-request/v1';
  configurationDigest: string;
  nas: BackupNasRootConfiguration;
  scope: VaultAuthorityScope;
  authority: { socket: string; token: string };
};
export type BackupNasSetupWireControls = { assertMemory?(): void; deadlineMs?: number };
const maximum = 4096;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
/** Domain separation makes the live setup permission unusable for vault provisioning
 * or another NAS selection. A stored result never constitutes this live capability.
 */
export function backupNasSetupScope(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  operationId: string,
  generation: number,
): Readonly<VaultAuthorityScope> {
  try {
    const vault = vaultRootConfiguration(input),
      nas = backupNasRootConfiguration(selected, vault);
    if (!uuid(operationId) || !Number.isSafeInteger(generation) || generation < vault.target.minimumGeneration)
      throw Error('invalid_setup_scope');
    return Object.freeze({
      operationId,
      generation,
      targetDigest: digest({
        contract: 'cos-backup-nas-setup-authority/v1',
        configurationDigest: digest(vault),
        nasDigest: digest(nas),
      }),
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private NAS and owner bindings never enter errors.
    throw Error('backup_nas_setup_scope_unavailable');
  }
}
function validate(input: unknown, vault: VaultRootConfiguration): BackupNasSetupRequest {
  if (
    !object(input) ||
    Object.keys(input).sort().join(',') !== 'authority,configurationDigest,contract,nas,scope' ||
    input.contract !== 'cos-backup-nas-setup-request/v1' ||
    input.configurationDigest !== digest(vault) ||
    !object(input.scope) ||
    Object.keys(input.scope).sort().join(',') !== 'generation,operationId,targetDigest' ||
    !object(input.authority) ||
    Object.getOwnPropertyNames(input.authority).sort().join(',') !== 'socket,token'
  )
    throw Error('invalid_setup_request');
  const nas = backupNasRootConfiguration(input.nas, vault),
    scope = backupNasSetupScope(vault, nas, input.scope.operationId as string, input.scope.generation as number),
    authority = input.authority;
  if (
    digest(scope) !== digest(input.scope) ||
    typeof authority.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(authority.token) ||
    typeof authority.socket !== 'string' ||
    !path.isAbsolute(authority.socket) ||
    path.resolve(authority.socket) !== authority.socket ||
    /[\0\r\n]/.test(authority.socket) ||
    Buffer.byteLength(authority.socket) > 100
  )
    throw Error('invalid_setup_authority');
  return {
    contract: 'cos-backup-nas-setup-request/v1',
    configurationDigest: digest(vault),
    nas,
    scope,
    authority: { socket: authority.socket, token: authority.token },
  };
}
export function backupNasSetupRequest(input: unknown, vault: VaultRootConfiguration): BackupNasSetupRequest {
  try {
    const result = validate(input, vaultRootConfiguration(vault));
    Object.defineProperty(result.authority, 'token', { value: result.authority.token, enumerable: false });
    Object.freeze(result.authority);
    return Object.freeze(result);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Request fields and live capabilities stay private.
    throw Error('backup_nas_setup_transport_unavailable');
  }
}
/** Metadata only: an exact length-prefixed frame followed by EOF on a private pipe.
 * Every input/frame buffer is cleared. No credentials or root selectors are admitted.
 */
export async function readBackupNasSetupRequest(
  stream: Readable,
  input: VaultRootConfiguration,
  controls: BackupNasSetupWireControls = {},
): Promise<BackupNasSetupRequest> {
  let staging: Buffer | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    const vault = vaultRootConfiguration(input),
      deadline = controls.deadlineMs ?? 15000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 15000) throw Error('invalid_deadline');
    staging = Buffer.alloc(4 + maximum);
    timer = setTimeout(() => stream.destroy(Error('backup_nas_setup_transport_unavailable')), deadline);
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
    const result = backupNasSetupRequest(JSON.parse(staging.subarray(4, length).toString('utf8')), vault);
    memory();
    return result;
  } catch {
    stream.destroy();
    // eslint-disable-next-line preserve-caught-error -- Private capabilities and selected NAS metadata are never transport diagnostics.
    throw Error('backup_nas_setup_transport_unavailable');
  } finally {
    staging?.fill(0);
    if (timer) clearTimeout(timer);
  }
}
export async function writeBackupNasSetupRequest(
  stream: Writable,
  input: VaultRootConfiguration,
  request: BackupNasSetupRequest,
  controls: BackupNasSetupWireControls = {},
): Promise<void> {
  let frame: Buffer | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    const value = validate(request, vaultRootConfiguration(input)),
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
    // eslint-disable-next-line preserve-caught-error -- Neither pipe errors nor private request bytes enter diagnostics.
    throw Error('backup_nas_setup_transport_unavailable');
  } finally {
    frame?.fill(0);
  }
}
