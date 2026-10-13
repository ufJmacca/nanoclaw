import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';
import type { VaultAuthorityScope } from './vault-authority.js';
import {
  readBackupNasPrivateFrame,
  writeBackupNasPrivateFrame,
  type BackupNasPrivateFrameControls,
} from './backup-nas-private-frame.js';
export type BackupNasSetupRequest = {
  contract: 'cos-backup-nas-setup-request/v1';
  configurationDigest: string;
  nas: BackupNasRootConfiguration;
  scope: VaultAuthorityScope;
  authority: { socket: string; token: string };
};
export type BackupNasSetupWireControls = BackupNasPrivateFrameControls;
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
export function readBackupNasSetupRequest(
  stream: Readable,
  input: VaultRootConfiguration,
  controls: BackupNasSetupWireControls = {},
): Promise<BackupNasSetupRequest> {
  return readBackupNasPrivateFrame(
    stream,
    () => {
      const vault = vaultRootConfiguration(input);
      return (value) => backupNasSetupRequest(value, vault);
    },
    'backup_nas_setup_transport_unavailable',
    controls,
  );
}
export function writeBackupNasSetupRequest(
  stream: Writable,
  input: VaultRootConfiguration,
  request: BackupNasSetupRequest,
  controls: BackupNasSetupWireControls = {},
): Promise<void> {
  return writeBackupNasPrivateFrame(
    stream,
    () => validate(request, vaultRootConfiguration(input)),
    'backup_nas_setup_transport_unavailable',
    controls,
  );
}
