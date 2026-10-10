import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { runVaultRootInstaller, vaultStagedRoot } from './vault-root-installer.js';
import type { installVaultRoot } from './vault-root-install.js';
function fixture() {
  const release = fixtureVaultRelease(),
    binding = {
      hostFingerprint: 'a'.repeat(64),
      databaseFingerprint: 'b'.repeat(64),
      service: 'fixture.service',
      installationRoot: '/home/fixture/app',
      dataRoot: '/home/fixture/app/data',
    },
    configuration = vaultRootConfiguration({
      contract: 'cos-vault-root-config/v2',
      authority: { operationId: randomUUID() },
      identity: {
        operationId: randomUUID(),
        targetDigest: digest(binding),
        recoveryReference: randomUUID(),
        luksUuid: randomUUID(),
        filesystemUuid: randomUUID(),
      },
      target: { binding, lifecycle: 'protected', minimumGeneration: 3 },
      owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/.config/nanoclaw-cos/state' },
      artifact: {
        sourceCommit: release.source.commit,
        sourceTree: release.source.tree,
        digest: release.vaultArtifact!.digest,
      },
    }),
    request = {
      contract: 'cos-vault-root-install-request/v1' as const,
      releaseId: 'release-aaaaaaaaaaaa-20261008000000',
      configuration,
      authority: { socket: '/home/fixture/private/proof.sock', token: 'f'.repeat(64) },
    };
  const sourceRoot =
    '/home/fixture/.config/nanoclaw-cos/releases/' +
    request.releaseId +
    '/payload/vault-artifacts/' +
    configuration.artifact.digest;
  const controls = {
    assertMemory: vi.fn(() => {}),
    assertRole: vi.fn(() => {}),
    invocation: { executable: sourceRoot + '/node', entrypoint: sourceRoot + '/gateway.mjs' },
    readRequest: vi.fn(async () => request),
    verifyArtifact: vi.fn(() => {}),
    checkAuthority: vi.fn(async () => {}),
    install: vi.fn(
      async (_input: Parameters<typeof installVaultRoot>[0], guards: Parameters<typeof installVaultRoot>[1]) => {
        await guards.assertAuthority();
        return {
          contract: 'cos-vault-root-installation-result/v1' as const,
          status: 'installed' as const,
          configurationDigest: digest(configuration),
          identityDigest: vaultRootStateDigest(configuration),
          artifactDigest: configuration.artifact.digest,
        };
      },
    ),
  };
  return { request, sourceRoot, controls, stream: Readable.from([]) };
}
it('installs only from the exact staged sealed runtime and keeps the owner proof live through effects', async () => {
  const f = fixture(),
    result = await runVaultRootInstaller(f.stream, f.controls);
  expect(vaultStagedRoot(f.request.configuration, f.request.releaseId)).toBe(f.sourceRoot);
  expect(result.status).toBe('installed');
  expect(f.controls.checkAuthority).toHaveBeenCalledWith(
    f.request.authority,
    {
      operationId: f.request.configuration.authority.operationId,
      targetDigest: f.request.configuration.identity.targetDigest,
      generation: 3,
    },
    1000,
  );
  expect(f.controls.verifyArtifact.mock.calls.length).toBeGreaterThan(3);
  expect(JSON.stringify(result)).not.toContain(f.request.authority.token);
});
it.each(['runtime', 'entrypoint', 'release', 'proof', 'artifact', 'memory'])(
  'denies %s before any installation effects',
  async (reason) => {
    const f = fixture();
    if (reason === 'runtime') f.controls.invocation.executable = '/usr/bin/node';
    if (reason === 'entrypoint') f.controls.invocation.entrypoint = '/tmp/foreign.mjs';
    if (reason === 'release') f.request.releaseId = 'release-bbbbbbbbbbbb-20261008000000';
    if (reason === 'proof') f.controls.checkAuthority.mockRejectedValue(Error('PRIVATE_PROOF'));
    if (reason === 'artifact')
      f.controls.verifyArtifact.mockImplementation(() => {
        throw Error('PRIVATE_ARTIFACT');
      });
    if (reason === 'memory')
      f.controls.assertMemory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    await expect(runVaultRootInstaller(f.stream, f.controls)).rejects.toThrow('vault_root_installation_unavailable');
    expect(f.controls.install).not.toHaveBeenCalled();
  },
);
it('stops installation if the staged bytes change across a live proof await', async () => {
  const f = fixture();
  f.controls.checkAuthority.mockImplementationOnce(async () => {
    f.controls.verifyArtifact.mockImplementation(() => {
      throw Error('PRIVATE_CHANGED_SOURCE');
    });
  });
  await expect(runVaultRootInstaller(f.stream, f.controls)).rejects.toThrow('vault_root_installation_unavailable');
  expect(f.controls.install).not.toHaveBeenCalled();
});
