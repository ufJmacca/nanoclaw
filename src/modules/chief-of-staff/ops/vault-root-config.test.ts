import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration, fixedVaultRootPaths } from './vault-root-config.js';
function fixture() {
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'nanoclaw-fixture.service',
    installationRoot: '/home/fixture/nanoclaw',
    dataRoot: '/home/fixture/nanoclaw/data',
  };
  return {
    contract: 'cos-vault-root-config/v2',
    authority: { operationId: randomUUID() },
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: 1 },
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/.config/nanoclaw-cos/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  };
}
it('binds a fresh operation independently of the permanent volume identity', () => {
  const input = fixture(),
    operationId = randomUUID();
  const value = vaultRootConfiguration({
    ...input,
    contract: 'cos-vault-root-config/v2',
    authority: { operationId },
  });
  expect(value.authority.operationId).toBe(operationId);
  expect(value.identity.operationId).toBe(input.identity.operationId);
  expect(Object.isFrozen(value.authority)).toBe(true);
});
it('binds root configuration to the protected target and derives only fixed programme storage paths', () => {
  const input = fixture(),
    value = vaultRootConfiguration(input);
  expect(fixedVaultRootPaths(value)).toEqual({
    stateRoot: '/etc/nanoclaw-cos/control',
    volume: '/var/lib/nanoclaw-cos/vault.luks',
    bootKey: '/etc/nanoclaw-cos/vault.key',
    mapper: 'nanoclaw-cos-vault',
    vaultRoot: '/var/lib/nanoclaw-cos/vault',
    calendarRoot: input.owner.targetRoot + '/calendar',
    systemUnits: '/etc/systemd/system',
    ownerUnits: input.owner.home + '/.config/systemd/user',
  });
  input.owner.targetRoot = '/home/fixture/foreign';
  expect(value.owner.targetRoot).toBe('/home/fixture/.config/nanoclaw-cos/state');
  expect(Object.isFrozen(value.identity)).toBe(true);
  expect(Object.isFrozen(value.target.binding)).toBe(true);
});
it.each([
  'extra-root-command',
  'root-owner',
  'bad-group',
  'foreign-home',
  'escaped-state',
  'home-state',
  'unprotected',
  'bad-generation',
  'foreign-binding',
  'foreign-service',
  'relative-data',
  'bad-uuid',
  'bad-operation',
  'legacy-config',
  'mutable-source',
  'bad-artifact',
])('refuses %s without accepting caller-selected root commands or resource paths', (reason) => {
  const value = fixture();
  if (reason === 'extra-root-command')
    Object.assign(value, { command: 'PRIVATE_COMMAND', volume: '/dev/private-partition' });
  if (reason === 'root-owner') value.owner.uid = 0;
  if (reason === 'bad-group') value.owner.gid = -1;
  if (reason === 'foreign-home') value.owner.home = '/root';
  if (reason === 'escaped-state') value.owner.targetRoot = '/home/fixture/../foreign/state';
  if (reason === 'home-state') value.owner.targetRoot = value.owner.home;
  if (reason === 'unprotected') value.target.lifecycle = 'implementation_disposable';
  if (reason === 'bad-generation') value.target.minimumGeneration = 0;
  if (reason === 'foreign-binding') value.identity.targetDigest = 'f'.repeat(64);
  if (reason === 'foreign-service') value.target.binding.service = 'foreign\nExecStart=/bin/sh';
  if (reason === 'relative-data') value.target.binding.dataRoot = 'private/data';
  if (reason === 'bad-uuid') Object.assign(value.identity, { luksUuid: 'PRIVATE_UUID' });
  if (reason === 'bad-operation') Object.assign(value.authority, { operationId: 'PRIVATE_OPERATION' });
  if (reason === 'legacy-config') value.contract = 'cos-vault-root-config/v1';
  if (reason === 'mutable-source') value.artifact.sourceCommit = 'main';
  if (reason === 'bad-artifact') value.artifact.digest = 'PRIVATE_DIGEST';
  expect(() => vaultRootConfiguration(value)).toThrow('vault_root_configuration_unavailable');
});
