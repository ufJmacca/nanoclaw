import type { Readable } from 'node:stream';
import { digest } from '../domain/contracts.js';
import { VAULT_BYTES } from './vault-admission.js';
import { checkVaultAuthority } from './vault-authority.js';
import { readVaultRootConfiguration, fixedVaultRootPaths } from './vault-root-config.js';
import { verifyVaultRootArtifact } from './vault-root-artifact.js';
import { createVaultRootEffects } from './vault-root-effects.js';
import { readVaultRootRequest } from './vault-root-wire.js';
import { provisionVault } from './vault-provision.js';
import { verifyVaultMemory } from './vault-memory.js';
/** Test composition seams are not exposed by the installed command, configuration or environment. */
export type VaultRootGatewayControls = {
  assertMemory?(): void;
  assertRole?(): void;
  readConfiguration?: typeof readVaultRootConfiguration;
  verifyArtifact?: (input: Parameters<typeof verifyVaultRootArtifact>[0]) => void;
  readRequest?: typeof readVaultRootRequest;
  checkAuthority?: typeof checkVaultAuthority;
  createEffects?: typeof createVaultRootEffects;
  provision?: typeof provisionVault;
};
/** Fixed root gateway. The owner proof must remain live through every root effect and final receipt. */
export async function runVaultRootGateway(stream: Readable, controls: VaultRootGatewayControls = {}) {
  let recovery: Buffer | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    const role =
      controls.assertRole ??
      (() => {
        if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
          throw Error('root_process_required');
      });
    const guard = () => {
      memory();
      role();
    };
    guard();
    const readConfig = controls.readConfiguration ?? readVaultRootConfiguration,
      verifyArtifact = controls.verifyArtifact ?? verifyVaultRootArtifact,
      config = readConfig(),
      configurationDigest = digest(config);
    verifyArtifact(config);
    const request = await (controls.readRequest ?? readVaultRootRequest)(stream, { assertMemory: guard });
    recovery = request.recovery;
    guard();
    const { header } = request;
    if (
      header.configurationDigest !== configurationDigest ||
      digest(header.identity) !== digest(config.identity) ||
      header.scope.operationId !== config.identity.operationId ||
      header.scope.targetDigest !== config.identity.targetDigest ||
      !Number.isSafeInteger(header.scope.generation) ||
      header.scope.generation < config.target.minimumGeneration
    )
      throw Error('root_request_scope_conflict');
    const assertArtifact = () => {
      guard();
      const current = readConfig();
      if (digest(current) !== configurationDigest) throw Error('root_configuration_changed');
      verifyArtifact(current);
    };
    const assertAuthority = async () => {
      assertArtifact();
      await (controls.checkAuthority ?? checkVaultAuthority)(header.authority, header.scope, config.owner.uid);
      assertArtifact();
    };
    await assertAuthority();
    const ports = (controls.createEffects ?? createVaultRootEffects)(
      fixedVaultRootPaths(config),
      config.identity,
      {
        userId: config.owner.uid,
        groupId: config.owner.gid,
        service: config.target.binding.service,
        calendarRoot: config.owner.targetRoot + '/calendar',
      },
      recovery,
      { assertAuthority, assertMemory: memory, assertRole: role },
    );
    const result = await (controls.provision ?? provisionVault)(config.identity, ports);
    await assertAuthority();
    if (
      result.status !== 'ready' ||
      result.volumeBytes !== VAULT_BYTES ||
      result.identityDigest !== digest(config.identity)
    )
      throw Error('root_result_unverified');
    return Object.freeze({
      contract: 'cos-vault-root-result/v1',
      status: 'ready',
      volumeBytes: VAULT_BYTES,
      identityDigest: digest(config.identity),
      sourceCommit: config.artifact.sourceCommit,
      sourceTree: config.artifact.sourceTree,
      artifactDigest: config.artifact.digest,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Root paths, capabilities, recovery and utility diagnostics stay private.
    throw Error('vault_root_gateway_unavailable');
  } finally {
    recovery?.fill(0);
  }
}
