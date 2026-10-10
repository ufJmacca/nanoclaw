import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import type { TargetState } from './target-state.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { runVaultInstallAdmin, vaultInstallInvocation } from './vault-owner-install.js';
import type { VaultRootConfiguration } from './vault-root-config.js';
import type { VaultInstallRequest } from './vault-install-wire.js';
function fixture() {
  const release = fixtureVaultRelease();
  release.releaseId = 'release-aaaaaaaaaaaa-20261008000000';
  const nonce = randomUUID(),
    operationId = randomUUID(),
    root = '/home/fixture/.config/nanoclaw-cos/state',
    target: TargetState = {
      version: 1,
      lifecycle: 'protected',
      releaseId: release.releaseId,
      generation: 3,
      maintenance: true,
      maintenanceId: nonce,
      binding: {
        hostFingerprint: 'a'.repeat(64),
        databaseFingerprint: 'b'.repeat(64),
        service: 'fixture.service',
        installationRoot: '/home/fixture/app',
        dataRoot: '/home/fixture/app/data',
      },
    },
    proof = {
      scope: { operationId, targetDigest: digest(target.binding), generation: 3 },
      authority: { socket: '/home/fixture/private/proof.sock', token: 'f'.repeat(64), close: vi.fn(async () => {}) },
      check: vi.fn(async () => {}),
    };
  const input = {
    root,
    target,
    release,
    payloadRoot: '/home/fixture/.config/nanoclaw-cos/releases/' + release.releaseId + '/payload',
    maintenance: { owner: 'operations-' + operationId, nonce, purpose: 'deployment' as const, generation: 3 },
    native: {} as never,
    hostLease: {} as never,
    check: vi.fn(async () => {}),
  };
  let previous: VaultRootConfiguration | undefined;
  const controls = {
    assertOwner: vi.fn(() => {}),
    assertMemory: vi.fn(() => {}),
    owner: { uid: 1000, gid: 1000, home: '/home/fixture' },
    readTarget: vi.fn(() => target),
    readConfiguration: vi.fn(() => previous),
    saveConfiguration: vi.fn((value: VaultRootConfiguration) => {
      previous = value;
    }),
    openAuthority: vi.fn(async () => proof),
    invoke: vi.fn(
      async (request: VaultInstallRequest): Promise<unknown> => ({
        contract: 'cos-vault-root-installation-result/v1',
        status: 'installed',
        configurationDigest: digest(request.configuration),
        identityDigest: vaultRootStateDigest(request.configuration),
        artifactDigest: request.configuration.artifact.digest,
      }),
    ),
  };
  return { input, controls, proof };
}
it('persists stable metadata before opening the live root capability, sends no recovery key and always closes the proof', async () => {
  const f = fixture(),
    result = await runVaultInstallAdmin(f.input, f.controls);
  expect(result.status).toBe('installed');
  expect(f.controls.saveConfiguration).toHaveBeenCalledOnce();
  expect(f.controls.saveConfiguration.mock.invocationCallOrder[0]).toBeLessThan(
    f.controls.openAuthority.mock.invocationCallOrder[0],
  );
  expect(f.controls.invoke.mock.calls[0]![0].configuration.identity.operationId).not.toBe(f.proof.scope.operationId);
  expect(JSON.stringify(result)).not.toContain(f.proof.authority.token);
  expect(f.proof.authority.close).toHaveBeenCalledOnce();
  await runVaultInstallAdmin(f.input, f.controls);
  expect(f.controls.saveConfiguration).toHaveBeenCalledOnce();
});
it.each(['memory', 'owner', 'quiescence', 'target', 'payload', 'root-receipt', 'lost-proof', 'cleanup'])(
  'denies %s without granting any provisioning authority',
  async (reason) => {
    const f = fixture();
    if (reason === 'memory')
      f.controls.assertMemory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    if (reason === 'owner')
      f.controls.assertOwner.mockImplementation(() => {
        throw Error('PRIVATE_OWNER');
      });
    if (reason === 'quiescence') f.input.check.mockRejectedValue(Error('PRIVATE_LEASE'));
    if (reason === 'target')
      f.controls.readTarget.mockReturnValue({ ...f.input.target, lifecycle: 'implementation_disposable' });
    if (reason === 'payload') f.input.payloadRoot = '/home/fixture/foreign';
    if (reason === 'root-receipt') f.controls.invoke.mockResolvedValue({ status: 'installed' });
    if (reason === 'lost-proof') f.proof.check.mockRejectedValue(Error('PRIVATE_PROOF'));
    if (reason === 'cleanup') f.proof.authority.close.mockRejectedValue(Error('PRIVATE_SOCKET_PATH'));
    await expect(runVaultInstallAdmin(f.input, f.controls)).rejects.toThrow('vault_owner_installation_unavailable');
    if (['memory', 'owner', 'quiescence', 'target', 'payload'].includes(reason)) {
      expect(f.controls.saveConfiguration).not.toHaveBeenCalled();
      expect(f.controls.invoke).not.toHaveBeenCalled();
    }
    if (['root-receipt', 'lost-proof'].includes(reason)) expect(f.proof.authority.close).toHaveBeenCalledOnce();
  },
);
it('invokes one fixed staged sealed command with memory limits and clean environment', async () => {
  const f = fixture();
  await runVaultInstallAdmin(f.input, f.controls);
  const request = f.controls.invoke.mock.calls[0]![0],
    command = vaultInstallInvocation(request.configuration, request.releaseId);
  expect(command.tool).toBe('/usr/bin/sudo');
  expect(command.args.slice(-3)).toEqual([
    f.input.payloadRoot + '/vault-artifacts/' + request.configuration.artifact.digest + '/node',
    f.input.payloadRoot + '/vault-artifacts/' + request.configuration.artifact.digest + '/gateway.mjs',
    '--install',
  ]);
  expect(command.args).toContain('--property=LimitCORE=0');
  expect(command.args).toContain('--property=MemorySwapMax=0');
  expect(Object.keys(command.env).sort()).toEqual(['LANG', 'LC_ALL', 'PATH']);
  expect(command.args.join(' ')).not.toContain(f.proof.authority.token);
});
