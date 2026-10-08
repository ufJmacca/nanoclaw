import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { runVaultProvisionAdmin, vaultRootInvocation } from './vault-owner-admin.js';
import type { VaultRootHeader } from './vault-root-wire.js';
function fixture() {
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const config = vaultRootConfiguration({
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
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const authority = { socket: '/home/fixture/private/proof.sock', token: 'f'.repeat(64), close: vi.fn(async () => {}) };
  const proof = {
    authority,
    scope: { operationId: config.authority.operationId, targetDigest: config.identity.targetDigest, generation: 3 },
    check: vi.fn(async () => {}),
  };
  const recovery = Buffer.alloc(64, 29);
  const receipt = {
    contract: 'cos-vault-root-result/v1',
    status: 'ready',
    volumeBytes: 1073741824,
    identityDigest: digest(config.identity),
    sourceCommit: config.artifact.sourceCommit,
    sourceTree: config.artifact.sourceTree,
    artifactDigest: config.artifact.digest,
  };
  const controls = {
    assertMemory: vi.fn(() => {}),
    readConfiguration: vi.fn(() => config),
    openAuthority: vi.fn(async () => proof),
    readRecovery: vi.fn(async () => recovery),
    invoke: vi.fn(async (_header: VaultRootHeader, _key: Buffer) => receipt),
    configureStorage: vi.fn(async (_roots: unknown, _vaultRoot: string) => {}),
  };
  return {
    config,
    authority,
    proof,
    recovery,
    receipt,
    controls,
    input: {
      root: config.owner.targetRoot,
      maintenance: {} as never,
      native: {} as never,
      hostLease: {} as never,
      check: async () => {},
      stream: Readable.from([]),
    },
  };
}
it('binds the private root request to the actual owner proof and clears recovery after verified receipt', async () => {
  const f = fixture(),
    result = await runVaultProvisionAdmin(f.input, f.controls);
  expect(result).toEqual(f.receipt);
  expect(f.controls.invoke).toHaveBeenCalledOnce();
  const [header, key] = f.controls.invoke.mock.calls[0]!;
  expect(header).toEqual({
    contract: 'cos-vault-root-request/v1',
    configurationDigest: digest(f.config),
    identity: f.config.identity,
    scope: f.proof.scope,
    authority: { socket: f.authority.socket, token: f.authority.token },
  });
  expect(key).toBe(f.recovery);
  expect(f.proof.check.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(f.authority.close).toHaveBeenCalledOnce();
  expect(f.recovery.every((byte) => byte === 0)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.authority.token);
});
it('publishes the verified mounted storage policy before acknowledging provisioning, under the live owner lease', async () => {
  const f = fixture();
  f.controls.configureStorage.mockImplementation(async (roots, vaultRoot) => {
    expect(f.controls.invoke).toHaveBeenCalledOnce();
    expect(f.authority.close).not.toHaveBeenCalled();
    expect(f.recovery.every((byte) => byte === 0)).toBe(true);
    expect(roots).toEqual({
      targetRoot: f.config.owner.targetRoot,
      installationRoot: f.config.target.binding.installationRoot,
      dataRoot: f.config.target.binding.dataRoot,
    });
    expect(vaultRoot).toBe('/var/lib/nanoclaw-cos/vault');
  });
  await expect(runVaultProvisionAdmin(f.input, f.controls)).resolves.toEqual(f.receipt);
  expect(f.controls.configureStorage).toHaveBeenCalledOnce();
  expect(f.proof.check.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(f.authority.close).toHaveBeenCalledOnce();
});
it('keeps provisioning unavailable when mounted-storage verification or policy publication fails', async () => {
  const f = fixture();
  f.controls.configureStorage.mockRejectedValue(Error('PRIVATE_MOUNT_CHANGED'));
  await expect(runVaultProvisionAdmin(f.input, f.controls)).rejects.toThrow('vault_owner_provision_unavailable');
  expect(f.controls.invoke).toHaveBeenCalledOnce();
  expect(f.controls.configureStorage).toHaveBeenCalledOnce();
  expect(f.authority.close).toHaveBeenCalledOnce();
  expect(f.recovery.every((byte) => byte === 0)).toBe(true);
});
it('denies completion when owner authority is withdrawn during storage policy publication', async () => {
  const f = fixture();
  f.controls.configureStorage.mockImplementation(async () => {
    f.proof.check.mockRejectedValue(Error('PRIVATE_REVOKED'));
  });
  await expect(runVaultProvisionAdmin(f.input, f.controls)).rejects.toThrow('vault_owner_provision_unavailable');
  expect(f.controls.configureStorage).toHaveBeenCalledOnce();
  expect(f.authority.close).toHaveBeenCalledOnce();
  expect(f.recovery.every((byte) => byte === 0)).toBe(true);
});
it.each(['memory', 'authority', 'request', 'invoke', 'receipt', 'withdrawal', 'cleanup'])(
  'closes owner authority and refuses %s failure',
  async (reason) => {
    const f = fixture();
    if (reason === 'memory')
      f.controls.assertMemory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    if (reason === 'authority') f.controls.openAuthority.mockRejectedValue(Error('PRIVATE_LEASE'));
    if (reason === 'request') f.controls.readRecovery.mockRejectedValue(Error('PRIVATE_RECOVERY'));
    if (reason === 'invoke') f.controls.invoke.mockRejectedValue(Error('PRIVATE_ROOT'));
    if (reason === 'receipt') f.controls.invoke.mockResolvedValue({ ...f.receipt, artifactDigest: '0'.repeat(64) });
    if (reason === 'withdrawal')
      f.proof.check.mockResolvedValueOnce(undefined).mockRejectedValue(Error('PRIVATE_REVOKED'));
    if (reason === 'cleanup') f.authority.close.mockRejectedValue(Error('PRIVATE_CLEANUP'));
    await expect(runVaultProvisionAdmin(f.input, f.controls)).rejects.toThrow('vault_owner_provision_unavailable');
    if (reason !== 'cleanup') expect(f.controls.configureStorage).not.toHaveBeenCalled();
    if (f.controls.readRecovery.mock.results[0]?.type === 'return' && reason !== 'request')
      expect(f.recovery.every((byte) => byte === 0)).toBe(true);
    if (!['memory', 'authority'].includes(reason)) expect(f.authority.close).toHaveBeenCalledOnce();
  },
);
it('derives only the scoped root unit and sealed command, without credential-bearing environment or arguments', () => {
  const f = fixture(),
    invocation = vaultRootInvocation(f.config);
  expect(invocation.tool).toBe('/usr/bin/sudo');
  expect(invocation.args).toContain('--property=LimitCORE=0');
  expect(invocation.args).toContain('--property=MemorySwapMax=0');
  expect(invocation.args.slice(-2)).toEqual([
    '/opt/nanoclaw-cos/vault/' + f.config.artifact.digest + '/node',
    '/opt/nanoclaw-cos/vault/' + f.config.artifact.digest + '/gateway.mjs',
  ]);
  expect(invocation.env).toEqual({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' });
  expect(invocation.args).toContain('/usr/bin/env');
  expect(invocation.args).toContain('-i');
  expect(JSON.stringify(invocation)).not.toContain(f.authority.token);
});
