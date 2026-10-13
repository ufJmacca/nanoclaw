import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';
export type BackupNasInitializationResource =
  | Readonly<{ kind: 'closed-underlay'; device: number; inode: number }>
  | Readonly<{
      kind: 'configuration-stage' | 'service-stage';
      stageId: string;
      device: number;
      inode: number;
      contentDigest: string;
    }>;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
/** An observation selects one fixed helper namespace, never a caller path or effect.
 * This parser is not ownership proof. Recovery must independently hold and verify
 * these exact kernel identities and content, with fresh native permission.
 */
export function backupNasInitializationResource(value: unknown): BackupNasInitializationResource {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_resource');
    const record = value as Record<string, unknown>,
      keys = Reflect.ownKeys(record).sort().join(','),
      { kind, device, inode, stageId, contentDigest } = record;
    if (!positive(device) || !positive(inode)) throw Error('invalid_kernel_identity');
    if (kind === 'closed-underlay') {
      if (keys !== 'device,inode,kind') throw Error('underlay_fields');
      return Object.freeze({ kind, device, inode });
    }
    if (
      (kind !== 'configuration-stage' && kind !== 'service-stage') ||
      keys !== 'contentDigest,device,inode,kind,stageId' ||
      !uuid(stageId) ||
      typeof contentDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(contentDigest)
    )
      throw Error('invalid_stage');
    return Object.freeze({
      kind,
      stageId,
      device,
      inode,
      contentDigest,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Resource metadata remains inside the private administration boundary.
    throw Error('backup_nas_initialization_resource_unavailable');
  }
}
/** Separate from setup and recorded-unmount permission. Captured inode, namespace,
 * stage identity and content bind this capability to one observed resource. No
 * installed route uses it until root observation and live owner admission connect.
 */
export function backupNasInitializationRecoveryScope(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  observed: BackupNasInitializationResource,
  operationId: string,
  generation: number,
): Readonly<{ operationId: string; generation: number; targetDigest: string }> {
  try {
    const vault = vaultRootConfiguration(input),
      nas = backupNasRootConfiguration(selected, vault),
      resource = backupNasInitializationResource(observed);
    if (!uuid(operationId) || !positive(generation) || generation < vault.target.minimumGeneration)
      throw Error('invalid_fresh_operation');
    return Object.freeze({
      operationId,
      generation,
      targetDigest: digest({
        contract: 'cos-backup-nas-recover-initialization-authority/v1',
        configurationDigest: digest(vault),
        nasDigest: digest(nas),
        resourceDigest: digest(resource),
      }),
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- A resource observation or prior receipt cannot supply recovery authority.
    throw Error('backup_nas_initialization_recovery_scope_unavailable');
  }
}
