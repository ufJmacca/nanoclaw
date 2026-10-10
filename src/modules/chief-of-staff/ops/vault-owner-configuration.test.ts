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
