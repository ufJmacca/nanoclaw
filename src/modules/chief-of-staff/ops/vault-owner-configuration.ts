import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import type { TargetState } from './target-state.js';
import type { MaintenanceLease } from './maintenance.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
/** Non-secret metadata only. The caller must hold and recheck actual owner/host/maintenance authority before persisting. */
export function vaultOwnerConfiguration(input: {
  release: ReleaseManifest;
  target: TargetState;
  maintenance: MaintenanceLease;
  owner: VaultRootConfiguration['owner'];
  previous?: VaultRootConfiguration;
}): VaultRootConfiguration {
  try {
    const release = validateReleaseManifest(input.release),
      { target, maintenance, owner } = input,
      operationId = maintenance.owner.slice('operations-'.length),
      uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if (
      release.slice !== 'G01' ||
      !release.vaultArtifact ||
      target.lifecycle !== 'protected' ||
      target.releaseId !== release.releaseId ||
      !target.maintenance ||
      target.generation !== maintenance.generation ||
      target.maintenanceId !== maintenance.nonce ||
      !uuid.test(maintenance.nonce) ||
      maintenance.purpose !== 'deployment' ||
      maintenance.owner !== 'operations-' + operationId ||
      !uuid.test(operationId)
    )
      throw Error('owner_configuration_scope_conflict');
    const previous = input.previous ? vaultRootConfiguration(input.previous) : undefined;
    if (
      previous &&
      (digest(previous.owner) !== digest(owner) ||
        previous.identity.targetDigest !== digest(target.binding) ||
        previous.target.minimumGeneration > maintenance.generation ||
        (previous.authority.operationId === operationId &&
          (previous.target.minimumGeneration !== maintenance.generation ||
            previous.artifact.sourceCommit !== release.source.commit ||
            previous.artifact.sourceTree !== release.source.tree ||
            previous.artifact.digest !== release.vaultArtifact.digest)) ||
        (previous.authority.operationId !== operationId && previous.target.minimumGeneration >= maintenance.generation))
    )
      throw Error('owner_configuration_replay_conflict');
    return vaultRootConfiguration({
      contract: 'cos-vault-root-config/v2',
      authority: { operationId },
      identity: previous?.identity ?? {
        operationId: randomUUID(),
        targetDigest: digest(target.binding),
        recoveryReference: randomUUID(),
        luksUuid: randomUUID(),
        filesystemUuid: randomUUID(),
      },
      target: { binding: target.binding, lifecycle: 'protected', minimumGeneration: maintenance.generation },
      owner,
      artifact: {
        sourceCommit: release.source.commit,
        sourceTree: release.source.tree,
        digest: release.vaultArtifact.digest,
      },
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private owner paths and lease metadata are not configuration diagnostics.
    throw Error('vault_owner_configuration_unavailable');
  }
}
