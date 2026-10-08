import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { runVaultRootGateway } from './vault-root-gateway.js';
import type { VaultRootHeader } from './vault-root-wire.js';
import type { VaultProvisionPorts } from './vault-provision.js';
import type { VaultProvisionIdentity } from './vault-provision.js';
import type { VaultRootControls, VaultRootInput, VaultRootPaths } from './vault-root-effects.js';
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
  const header: VaultRootHeader = {
    contract: 'cos-vault-root-request/v1',
    configurationDigest: digest(config),
    identity: { ...config.identity },
    scope: { operationId: config.authority.operationId, targetDigest: config.identity.targetDigest, generation: 3 },
    authority: { socket: '/home/fixture/private/proof.sock', token: 'f'.repeat(64) },
  };
  const recovery = Buffer.alloc(64, 47),
    events: string[] = [];
  const controls = {
    initializeState: vi.fn(async () => {}),
    assertMemory() {
      events.push('memory');
    },
    assertRole() {
      events.push('role');
    },
    readConfiguration: vi.fn(() => {
      events.push('configuration');
      return config;
    }),
    verifyArtifact: vi.fn(() => {
      events.push('artifact');
    }),
    readRequest: vi.fn(async () => {
      events.push('secret-read');
      return { header, recovery };
    }),
    checkAuthority: vi.fn(async () => {
      events.push('owner-proof');
    }),
    createEffects: vi.fn(
      (
        _paths: VaultRootPaths,
        _identity: VaultProvisionIdentity,
        _input: VaultRootInput,
        _key: Buffer,
        guards: VaultRootControls,
      ) => {
        events.push('effects');
        return { assertAuthority: guards.assertAuthority } as VaultProvisionPorts;
      },
    ),
    provision: vi.fn(async (_identity: VaultProvisionIdentity, ports: VaultProvisionPorts) => {
      await ports.assertAuthority();
      events.push('provision');
      await ports.assertAuthority();
      return { status: 'ready', volumeBytes: 1073741824, identityDigest: digest(config.identity) };
    }),
  };
  return { config, header, recovery, events, controls, stream: Readable.from([]) };
}
it('checks trusted config and sealed bytes before reading recovery, rechecks live owner authority, and clears recovery', async () => {
  const f = fixture();
  const receipt = await runVaultRootGateway(f.stream, f.controls);
  expect(f.events.slice(0, 5)).toEqual(['memory', 'role', 'configuration', 'artifact', 'secret-read']);
  expect(f.controls.checkAuthority).toHaveBeenCalledWith(f.header.authority, f.header.scope, 1000);
  expect(f.controls.createEffects.mock.calls[0]?.[0]).toMatchObject({
    volume: '/var/lib/nanoclaw-cos/vault.luks',
    mapper: 'nanoclaw-cos-vault',
  });
  expect(f.controls.createEffects.mock.calls[0]?.[2]).toEqual({
    userId: 1000,
    groupId: 1000,
    service: 'fixture.service',
    calendarRoot: '/home/fixture/state/calendar',
  });
  expect(f.controls.verifyArtifact.mock.calls.length).toBeGreaterThan(3);
  expect(f.recovery.every((byte) => byte === 0)).toBe(true);
  expect(receipt).toEqual({
    contract: 'cos-vault-root-result/v1',
    status: 'ready',
    volumeBytes: 1073741824,
    identityDigest: digest(f.config.identity),
    sourceCommit: f.config.artifact.sourceCommit,
    sourceTree: f.config.artifact.sourceTree,
    artifactDigest: f.config.artifact.digest,
  });
  expect(JSON.stringify(receipt)).not.toContain(f.header.authority.token);
});
it.each(['configuration', 'identity', 'operation', 'resource-operation', 'target', 'generation'])(
  'denies request %s mismatch before constructing effects and clears recovery',
  async (reason) => {
    const f = fixture();
    if (reason === 'configuration') f.header.configurationDigest = '0'.repeat(64);
    if (reason === 'identity') f.header.identity.filesystemUuid = randomUUID();
    if (reason === 'operation') f.header.scope.operationId = randomUUID();
    if (reason === 'resource-operation') f.header.scope.operationId = f.config.identity.operationId;
    if (reason === 'target') f.header.scope.targetDigest = '0'.repeat(64);
    if (reason === 'generation') f.header.scope.generation = 2;
    await expect(runVaultRootGateway(f.stream, f.controls)).rejects.toThrow('vault_root_gateway_unavailable');
    expect(f.controls.createEffects).not.toHaveBeenCalled();
    expect(f.recovery.every((byte) => byte === 0)).toBe(true);
  },
);
it.each(['memory', 'role', 'artifact'])('denies initial %s failure before receiving a recovery key', async (reason) => {
  const f = fixture();
  if (reason === 'memory')
    f.controls.assertMemory = () => {
      throw Error('PRIVATE_FAILURE');
    };
  if (reason === 'role')
    f.controls.assertRole = () => {
      throw Error('PRIVATE_FAILURE');
    };
  if (reason === 'artifact')
    f.controls.verifyArtifact.mockImplementation(() => {
      throw Error('PRIVATE_FAILURE');
    });
  await expect(runVaultRootGateway(f.stream, f.controls)).rejects.toThrow('vault_root_gateway_unavailable');
  expect(f.controls.readRequest).not.toHaveBeenCalled();
  expect(f.controls.createEffects).not.toHaveBeenCalled();
});
it.each(['owner', 'config-change', 'artifact-change', 'provision', 'bad-receipt'])(
  'fails closed for %s after recovery receipt and clears owned bytes',
  async (reason) => {
    const f = fixture();
    if (reason === 'owner') f.controls.checkAuthority.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
    if (reason === 'config-change')
      f.controls.readConfiguration
        .mockReturnValueOnce(f.config)
        .mockImplementation(() => ({ ...f.config, target: { ...f.config.target, minimumGeneration: 4 } }));
    if (reason === 'artifact-change')
      f.controls.verifyArtifact
        .mockImplementationOnce(() => {})
        .mockImplementation(() => {
          throw Error('PRIVATE_ARTIFACT');
        });
    if (reason === 'provision') f.controls.provision.mockRejectedValue(Error('PRIVATE_ENGINE'));
    if (reason === 'bad-receipt')
      f.controls.provision.mockResolvedValue({
        status: 'ready',
        volumeBytes: 0,
        identityDigest: digest(f.config.identity),
      });
    await expect(runVaultRootGateway(f.stream, f.controls)).rejects.toThrow('vault_root_gateway_unavailable');
    expect(f.recovery.every((byte) => byte === 0)).toBe(true);
  },
);
it('stops when the live owner withdraws authority after effects are constructed', async () => {
  const f = fixture();
  f.controls.checkAuthority
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(Error('PRIVATE_REVOKED'));
  await expect(runVaultRootGateway(f.stream, f.controls)).rejects.toThrow('vault_root_gateway_unavailable');
  expect(f.controls.createEffects).toHaveBeenCalledOnce();
  expect(f.events).not.toContain('provision');
  expect(f.recovery.every((byte) => byte === 0)).toBe(true);
});
