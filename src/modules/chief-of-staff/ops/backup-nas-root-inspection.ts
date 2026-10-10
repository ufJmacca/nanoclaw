import type { Readable } from 'node:stream';
import { digest } from '../domain/contracts.js';
import { readVaultRootConfiguration, vaultRootConfiguration } from './vault-root-config.js';
import { withVaultRootArtifact } from './vault-root-artifact.js';
import { backupNasSetupRequest, readBackupNasSetupRequest } from './backup-nas-setup-wire.js';
import { checkVaultAuthority } from './vault-authority.js';
import { inspectBackupNasUnclaimedUnderlay } from './backup-nas-underlay.js';
import {
  backupNasInitializationResource,
  type BackupNasInitializationResource,
} from './backup-nas-initialization-recovery-scope.js';
import { verifyVaultMemory } from './vault-memory.js';
export type BackupNasRootInspectionControls = {
  assertMemory?(): void;
  readConfiguration?: typeof readVaultRootConfiguration;
  withArtifact?: typeof withVaultRootArtifact;
  readRequest?: typeof readBackupNasSetupRequest;
  checkAuthority?: typeof checkVaultAuthority;
  inspectResource?: typeof inspectBackupNasUnclaimedUnderlay;
};
export type BackupNasInitializationInspectionResult = Readonly<{
  contract: 'cos-backup-nas-initialization-inspection-result/v1';
  status: 'observed';
  configurationDigest: string;
  nasDigest: string;
  artifactDigest: string;
  scopeDigest: string;
  resource: BackupNasInitializationResource;
}>;
/** Fixed read-only route. Setup permission admits inspection, never resource
 * adoption or retirement. The owner must verify this receipt and obtain a new
 * resource-bound grant; root recovery independently rechecks the resource then.
 * Configuration/service-stage observation will be connected separately.
 */
export async function runBackupNasRootInitializationInspection(
  stream: Readable,
  controls: BackupNasRootInspectionControls = {},
): Promise<BackupNasInitializationInspectionResult> {
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory,
      until = Date.now() + 30000;
    const role = () => {
      memory();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0 || Date.now() >= until)
        throw Error('root_inspection_unavailable');
    };
    role();
    const readConfiguration = controls.readConfiguration ?? readVaultRootConfiguration,
      vault = vaultRootConfiguration(readConfiguration()),
      configurationDigest = digest(vault);
    const currentConfiguration = () => {
      role();
      if (digest(vaultRootConfiguration(readConfiguration())) !== configurationDigest)
        throw Error('inspection_configuration_changed');
    };
    const result = await (controls.withArtifact ?? withVaultRootArtifact)(vault, async (artifact) => {
      const trusted = () => {
        currentConfiguration();
        artifact.assertCurrent();
        role();
      };
      trusted();
      const request = backupNasSetupRequest(
        await (controls.readRequest ?? readBackupNasSetupRequest)(stream, vault, { assertMemory: trusted }),
        vault,
      );
      trusted();
      const assertAuthority = async () => {
        trusted();
        await (controls.checkAuthority ?? checkVaultAuthority)(request.authority, request.scope, vault.owner.uid);
        trusted();
      };
      await assertAuthority();
      const resource = backupNasInitializationResource(
        await (controls.inspectResource ?? inspectBackupNasUnclaimedUnderlay)(vault, request.nas, {
          assertAuthority,
          assertMemory: memory,
        }),
      );
      // The inspector holds resources through its final native closure. Only
      // synchronous checks follow; the receipt grants no ownership or effects.
      trusted();
      return Object.freeze({
        contract: 'cos-backup-nas-initialization-inspection-result/v1' as const,
        status: 'observed' as const,
        configurationDigest,
        nasDigest: digest(request.nas),
        artifactDigest: vault.artifact.digest,
        scopeDigest: digest(request.scope),
        resource,
      });
    });
    currentConfiguration();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private owner capabilities, NAS metadata and resource diagnostics never enter output.
    throw Error('backup_nas_root_inspection_unavailable');
  } finally {
    stream.destroy();
  }
}
