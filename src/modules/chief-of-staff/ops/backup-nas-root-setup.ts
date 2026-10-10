import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { readVaultRootConfiguration, vaultRootConfiguration } from './vault-root-config.js';
import { withVaultRootArtifact } from './vault-root-artifact.js';
import { backupNasSetupRequest, readBackupNasSetupRequest } from './backup-nas-setup-wire.js';
import { checkVaultAuthority } from './vault-authority.js';
import { installBackupNasRootConfiguration } from './backup-nas-config-install.js';
import { prepareBackupNasUnderlay } from './backup-nas-underlay.js';
import { installBackupNasOnDemandService } from './backup-nas-service-install.js';
import { backupNasMountJournal } from './backup-nas-mount-state.js';
import { backupNasMountService } from './backup-nas-units.js';
import { verifyVaultMemory } from './vault-memory.js';
export type BackupNasRootSetupControls = {
  assertMemory?(): void;
  readConfiguration?: typeof readVaultRootConfiguration;
  withArtifact?: typeof withVaultRootArtifact;
  readRequest?: typeof readBackupNasSetupRequest;
  checkAuthority?: typeof checkVaultAuthority;
  installConfiguration?: typeof installBackupNasRootConfiguration;
  prepareUnderlay?: typeof prepareBackupNasUnderlay;
  installService?: typeof installBackupNasOnDemandService;
};
/** Fixed installed metadata route, distinct from both provisioning and ordinary
 * service execution. Actual root/memory protection, held sealed code and a fresh
 * owner/native permission surround each installer. It never mounts a NAS share.
 */
export async function runBackupNasRootSetup(
  stream: Readable,
  controls: BackupNasRootSetupControls = {},
): Promise<Record<string, unknown>> {
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory,
      until = Date.now() + 60000;
    const role = () => {
      memory();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0 || Date.now() >= until)
        throw Error('root_setup_unavailable');
    };
    role();
    const readConfiguration = controls.readConfiguration ?? readVaultRootConfiguration,
      vault = vaultRootConfiguration(readConfiguration()),
      configurationDigest = digest(vault);
    const currentConfiguration = () => {
      role();
      if (digest(vaultRootConfiguration(readConfiguration())) !== configurationDigest)
        throw Error('setup_configuration_changed');
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
      const nas = request.nas,
        nasDigest = digest(nas),
        unitDigest = createHash('sha256')
          .update(backupNasMountService({ artifactDigest: vault.artifact.digest }).contents)
          .digest('hex');
      const assertAuthority = async () => {
        trusted();
        await (controls.checkAuthority ?? checkVaultAuthority)(request.authority, request.scope, vault.owner.uid);
        trusted();
      };
      const installControls = { assertAuthority, assertMemory: memory };
      await assertAuthority();
      const installed = await (controls.installConfiguration ?? installBackupNasRootConfiguration)(
        vault,
        nas,
        installControls,
      );
      trusted();
      if (digest(installed) !== nasDigest) throw Error('setup_configuration_result_conflict');
      await assertAuthority();
      const underlay = backupNasMountJournal(
        await (controls.prepareUnderlay ?? prepareBackupNasUnderlay)(vault, nas, installControls),
        {
          configurationDigest: nasDigest,
          bindingDigest: digest({ host: nas.host, share: 'nanoclaw-cos-backups', mount: '/var/lib/nanoclaw-cos/nas' }),
        },
      );
      trusted();
      if (underlay.phase !== 'closed') throw Error('setup_closed_underlay_required');
      await assertAuthority();
      // The installer retains its own file claims through its final native await.
      // Do not introduce a new await after its verified completion and released file descriptors.
      const service = await (controls.installService ?? installBackupNasOnDemandService)(vault, nas, installControls);
      trusted();
      if (
        !service ||
        typeof service !== 'object' ||
        Array.isArray(service) ||
        Object.keys(service).sort().join(',') !== 'artifactDigest,configurationDigest,contract,status,unitDigest' ||
        service.contract !== 'cos-backup-nas-service-installation-result/v1' ||
        service.status !== 'installed' ||
        service.configurationDigest !== nasDigest ||
        service.artifactDigest !== vault.artifact.digest ||
        service.unitDigest !== unitDigest
      )
        throw Error('setup_service_result_conflict');
      return Object.freeze({
        contract: 'cos-backup-nas-setup-result/v1',
        status: 'configured',
        configurationDigest,
        nasDigest,
        artifactDigest: vault.artifact.digest,
        unitDigest,
        scopeDigest: digest(request.scope),
      });
    });
    currentConfiguration();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Owner capabilities, private NAS metadata, root paths and manager diagnostics never enter the result.
    throw Error('backup_nas_root_setup_unavailable');
  } finally {
    stream.destroy();
  }
}
