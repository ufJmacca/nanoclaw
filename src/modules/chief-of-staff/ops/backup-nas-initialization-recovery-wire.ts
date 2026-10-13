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
import {
  backupNasInitializationResource,
  backupNasInitializationRecoveryScope,
  type BackupNasInitializationResource,
} from './backup-nas-initialization-recovery-scope.js';
export { backupNasInitializationRecoveryScope } from './backup-nas-initialization-recovery-scope.js';
export type BackupNasInitializationRecoveryRequest = {
  contract: 'cos-backup-nas-recover-initialization-request/v1';
  configurationDigest: string;
  nas: BackupNasRootConfiguration;
  resource: BackupNasInitializationResource;
  scope: VaultAuthorityScope;
  authority: { socket: string; token: string };
};
export type BackupNasInitializationRecoveryWireControls = BackupNasPrivateFrameControls;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function validate(input: unknown, vault: VaultRootConfiguration): BackupNasInitializationRecoveryRequest {
  if (
    !object(input) ||
    Object.keys(input).sort().join(',') !== 'authority,configurationDigest,contract,nas,resource,scope' ||
    input.contract !== 'cos-backup-nas-recover-initialization-request/v1' ||
    input.configurationDigest !== digest(vault) ||
    !object(input.scope) ||
    Object.keys(input.scope).sort().join(',') !== 'generation,operationId,targetDigest' ||
    !object(input.authority) ||
    Object.getOwnPropertyNames(input.authority).sort().join(',') !== 'socket,token'
  )
    throw Error('invalid_recovery_request');
  const nas = backupNasRootConfiguration(input.nas, vault),
    resource = backupNasInitializationResource(input.resource),
    scope = backupNasInitializationRecoveryScope(
      vault,
      nas,
      resource,
      input.scope.operationId as string,
      input.scope.generation as number,
    ),
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
    throw Error('invalid_recovery_authority');
  return {
    contract: 'cos-backup-nas-recover-initialization-request/v1',
    configurationDigest: digest(vault),
    nas,
    resource,
    scope,
    authority: { socket: authority.socket, token: authority.token },
  };
}
export function backupNasInitializationRecoveryRequest(
  input: unknown,
  vault: VaultRootConfiguration,
): BackupNasInitializationRecoveryRequest {
  try {
    const result = validate(input, vaultRootConfiguration(vault));
    Object.defineProperty(result.authority, 'token', { value: result.authority.token, enumerable: false });
    Object.freeze(result.authority);
    return Object.freeze(result);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Request fields and live capabilities stay private.
    throw Error('backup_nas_initialization_recovery_transport_unavailable');
  }
}
export function readBackupNasInitializationRecoveryRequest(
  stream: Readable,
  input: VaultRootConfiguration,
  controls: BackupNasInitializationRecoveryWireControls = {},
): Promise<BackupNasInitializationRecoveryRequest> {
  return readBackupNasPrivateFrame(
    stream,
    () => {
      const vault = vaultRootConfiguration(input);
      return (value) => backupNasInitializationRecoveryRequest(value, vault);
    },
    'backup_nas_initialization_recovery_transport_unavailable',
    controls,
  );
}
export function writeBackupNasInitializationRecoveryRequest(
  stream: Writable,
  input: VaultRootConfiguration,
  request: BackupNasInitializationRecoveryRequest,
  controls: BackupNasInitializationRecoveryWireControls = {},
): Promise<void> {
  return writeBackupNasPrivateFrame(
    stream,
    () => validate(request, vaultRootConfiguration(input)),
    'backup_nas_initialization_recovery_transport_unavailable',
    controls,
  );
}
