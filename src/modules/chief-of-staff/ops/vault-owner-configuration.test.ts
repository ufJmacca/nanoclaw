import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import type { TargetState } from './target-state.js';
import { vaultOwnerConfiguration } from './vault-owner-configuration.js';
function fixture() {
  const release = fixtureVaultRelease(),
    operationId = randomUUID(),
    nonce = randomUUID(),
    binding = {
      hostFingerprint: 'a'.repeat(64),
      databaseFingerprint: 'b'.repeat(64),
      service: 'fixture.service',
      installationRoot: '/home/fixture/app',
      dataRoot: '/home/fixture/app/data',
    },
    target: TargetState = {
      version: 1,
      binding,
      lifecycle: 'protected',
      generation: 3,
      maintenance: true,
      maintenanceId: nonce,
      releaseId: release.releaseId,
    };
  return {
    release,
    target,
    maintenance: { owner: 'operations-' + operationId, purpose: 'deployment' as const, generation: 3, nonce },
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/.config/nanoclaw-cos/state' },
  };
}
function backupUpgrade(slice: 'G02' | 'G03' | 'G04' = 'G02') {
  const input = fixture(),
    previous = vaultOwnerConfiguration(input),
    nonce = randomUUID(),
    release = fixtureVaultRelease(slice);
  release.source.commit = 'e'.repeat(40);
  release.source.tree = 'f'.repeat(40);
  release.releaseId = 'release-backup-fixture';
  release.previousReleaseIds = [input.release.releaseId];
  release.vaultArtifact!.seal.sourceCommit = release.source.commit;
  release.vaultArtifact!.seal.sourceTree = release.source.tree;
  release.vaultArtifact!.digest = digest(release.vaultArtifact!.seal);
  for (const check of Object.values(release.checks)) check.sourceCommit = release.source.commit;
  return {
    ...input,
    previous,
    release,
    target: { ...input.target, releaseId: release.releaseId, generation: 4, maintenanceId: nonce },
    maintenance: { ...input.maintenance, owner: 'operations-' + randomUUID(), generation: 4, nonce },
  };
}
it('G02 upgrades the sealed helper under new maintenance authority while preserving the existing vault', () => {
  const input = backupUpgrade(),
    config = vaultOwnerConfiguration(input);
  expect(config.identity).toEqual(input.previous.identity);
  expect(config.owner).toEqual(input.previous.owner);
  expect(config.target.binding).toEqual(input.previous.target.binding);
  expect(config.authority.operationId).toBe(input.maintenance.owner.slice(11));
  expect(config.authority.operationId).not.toBe(input.previous.authority.operationId);
  expect(config.target.minimumGeneration).toBe(4);
  expect(config.artifact).toEqual({
    sourceCommit: input.release.source.commit,
    sourceTree: input.release.source.tree,
    digest: input.release.vaultArtifact!.digest,
  });
  expect(vaultOwnerConfiguration({ ...input, previous: config })).toEqual(config);
});
it('G02 refuses to create a fresh vault when the existing configuration is absent', () => {
  const { previous: _previous, ...input } = backupUpgrade();
  expect(() => vaultOwnerConfiguration(input)).toThrow('vault_owner_configuration_unavailable');
});
it.each(['G03', 'G04'] as const)(
  '%s advances only the sealed helper and current lease while preserving every existing vault identity',
  (slice) => {
    const input = backupUpgrade(slice),
      config = vaultOwnerConfiguration(input);
    expect(config.identity).toEqual(input.previous.identity);
    expect(config.owner).toEqual(input.previous.owner);
    expect(config.artifact.digest).toBe(input.release.vaultArtifact!.digest);
    expect(config.target.minimumGeneration).toBe(input.maintenance.generation);
    const { previous: _previous, ...missing } = input;
    expect(() => vaultOwnerConfiguration(missing)).toThrow('vault_owner_configuration_unavailable');
    expect(() =>
      vaultOwnerConfiguration({ ...input, maintenance: { ...input.maintenance, nonce: randomUUID() } }),
    ).toThrow('vault_owner_configuration_unavailable');
  },
);
it.each(['owner', 'binding', 'generation', 'reused-operation', 'backup-gate', 'artifact'])(
  'G02 refuses a conflicting %s upgrade',
  (reason) => {
    const input = backupUpgrade();
    if (reason === 'owner') input.owner.gid++;
    if (reason === 'binding') input.target.binding.hostFingerprint = '9'.repeat(64);
    if (reason === 'generation') {
      input.target.generation = 3;
      input.maintenance.generation = 3;
    }
    if (reason === 'reused-operation') input.maintenance.owner = 'operations-' + input.previous.authority.operationId;
    if (reason === 'backup-gate') delete input.release.checks.backup_recovery;
    if (reason === 'artifact') input.release.vaultArtifact!.digest = '0'.repeat(64);
    expect(() => vaultOwnerConfiguration(input)).toThrow('vault_owner_configuration_unavailable');
  },
);
it('creates source-bound metadata with a permanent resource ID distinct from the checked maintenance operation', () => {
  const input = fixture(),
    config = vaultOwnerConfiguration(input);
  expect(config.authority.operationId).toBe(input.maintenance.owner.slice(11));
  expect(config.identity.operationId).not.toBe(config.authority.operationId);
  expect(config.identity.targetDigest).toBe(digest(input.target.binding));
  expect(config.artifact.digest).toBe(input.release.vaultArtifact!.digest);
  expect(JSON.stringify(config)).not.toContain('keyBytes');
});
it('keeps every resource UUID and recovery reference on replay and a fresh leased operation', () => {
  const input = fixture(),
    first = vaultOwnerConfiguration(input);
  expect(vaultOwnerConfiguration({ ...input, previous: first })).toEqual(first);
  const nonce = randomUUID(),
    next = vaultOwnerConfiguration({
      ...input,
      previous: first,
      target: { ...input.target, generation: 4, maintenanceId: nonce },
      maintenance: { ...input.maintenance, owner: 'operations-' + randomUUID(), generation: 4, nonce },
    });
  expect(next.identity).toEqual(first.identity);
  expect(next.authority.operationId).not.toBe(first.authority.operationId);
});
it.each(['slice', 'disposable', 'release', 'unheld', 'generation', 'nonce', 'owner', 'binding', 'reused-operation'])(
  'denies %s configuration authority',
  (reason) => {
    const input = fixture(),
      first = vaultOwnerConfiguration(input);
    if (reason === 'slice') input.release.slice = 'S11';
    if (reason === 'disposable') input.target.lifecycle = 'implementation_disposable';
    if (reason === 'release') input.target.releaseId = 'release-foreign';
    if (reason === 'unheld') input.target.maintenance = false;
    if (reason === 'generation') input.maintenance.generation = 2;
    if (reason === 'nonce') input.maintenance.nonce = randomUUID();
    if (reason === 'owner') input.owner.uid = 0;
    if (reason === 'binding') input.target.binding.databaseFingerprint = '9'.repeat(64);
    if (reason === 'reused-operation') {
      input.target.generation = 4;
      input.maintenance.generation = 4;
    }
    expect(() => vaultOwnerConfiguration({ ...input, previous: first })).toThrow(
      'vault_owner_configuration_unavailable',
    );
  },
);
