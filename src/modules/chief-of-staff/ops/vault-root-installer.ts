import path from 'node:path';
import type { Readable } from 'node:stream';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { verifyVaultRootArtifact } from './vault-root-artifact.js';
import { installVaultRoot } from './vault-root-install.js';
import { checkVaultAuthority } from './vault-authority.js';
import { readVaultInstallRequest } from './vault-install-wire.js';
import { verifyVaultMemory } from './vault-memory.js';
/** The request cannot select a source package, executable, destination or root command. */
export function vaultStagedRoot(input: VaultRootConfiguration, releaseId: string) {
  const config = vaultRootConfiguration(input);
  if (!new RegExp('^release-' + config.artifact.sourceCommit.slice(0, 12) + '-[0-9]{14}$').test(releaseId))
    throw Error('vault_root_installation_unavailable');
  return path.join(
    path.dirname(config.owner.targetRoot),
    'releases',
    releaseId,
    'payload/vault-artifacts',
    config.artifact.digest,
  );
}
export type VaultRootInstallerControls = {
  assertMemory?(): void;
  assertRole?(): void;
  invocation?: { executable: string; entrypoint: string };
  readRequest?: typeof readVaultInstallRequest;
  verifyArtifact?: (config: VaultRootConfiguration, controls: Parameters<typeof verifyVaultRootArtifact>[1]) => void;
  checkAuthority?: typeof checkVaultAuthority;
  install?: typeof installVaultRoot;
};
/** Fixed staged entrypoint. It handles capability metadata only; provisioning recovery uses its separate binary pipe. */
export async function runVaultRootInstaller(stream: Readable, controls: VaultRootInstallerControls = {}) {
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory,
      role =
        controls.assertRole ??
        (() => {
          if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
            throw Error('root_process_required');
        }),
      guard = () => {
        memory();
        role();
      };
    guard();
    const request = await (controls.readRequest ?? readVaultInstallRequest)(stream, { assertMemory: guard }),
      config = vaultRootConfiguration(request.configuration),
      sourceRoot = vaultStagedRoot(config, request.releaseId),
      invocation = controls.invocation ?? { executable: process.execPath, entrypoint: process.argv[1] },
      scope = Object.freeze({
        operationId: config.authority.operationId,
        targetDigest: config.identity.targetDigest,
        generation: config.target.minimumGeneration,
      });
    if (invocation.executable !== sourceRoot + '/node' || invocation.entrypoint !== sourceRoot + '/gateway.mjs')
      throw Error('staged_installer_binding_conflict');
    const artifact = () => {
      guard();
      (controls.verifyArtifact ?? verifyVaultRootArtifact)(config, {
        root: sourceRoot,
        ownerUid: config.owner.uid,
        executable: invocation.executable,
        entrypoint: invocation.entrypoint,
        assertMemory: memory,
        assertRole: role,
      });
    };
    const assertAuthority = async () => {
      artifact();
      await (controls.checkAuthority ?? checkVaultAuthority)(request.authority, scope, config.owner.uid);
      artifact();
    };
    await assertAuthority();
    const result = await (controls.install ?? installVaultRoot)(
      { configuration: config, sourceRoot },
      {
        assertAuthority,
        assertMemory: memory,
        assertRole: role,
      },
    );
    await assertAuthority();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Staged source, private configuration and capability diagnostics remain private.
    throw Error('vault_root_installation_unavailable');
  }
}
