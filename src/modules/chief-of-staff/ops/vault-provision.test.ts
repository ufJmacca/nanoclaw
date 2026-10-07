import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { VAULT_BYTES, VAULT_FREE_FLOOR } from './vault-admission.js';
import {
  provisionVault,
  VAULT_PROVISION_STEPS,
  type VaultProvisionJournal,
  type VaultProvisionStep,
  type VaultProvisionPorts,
  type VaultProvisionIdentity,
} from './vault-provision.js';
function fixture() {
  const identity: VaultProvisionIdentity = {
    operationId: randomUUID(),
    targetDigest: 'a'.repeat(64),
    recoveryReference: randomUUID(),
    luksUuid: randomUUID(),
    filesystemUuid: randomUUID(),
  };
  let journal: VaultProvisionJournal | null = null,
    free = 4 * VAULT_BYTES,
    locked = false;
  const existing = new Set<VaultProvisionStep>();
  const applied: VaultProvisionStep[] = [],
    writes: VaultProvisionJournal[] = [];
  const ports: VaultProvisionPorts = {
    async withLock(operation) {
      if (locked) throw Error('locked');
      locked = true;
      try {
        return await operation();
      } finally {
        locked = false;
      }
    },
    async assertAuthority() {
      expect(locked).toBe(true);
    },
    assertMemory() {
      expect(locked).toBe(true);
    },
    async preflight() {
      return {
        platform: 'linux',
        architecture: 'arm64',
        lifecycle: 'protected',
        maintenanceHeld: true,
        hostLeaseHeld: true,
        privilegedAccess: true,
        availableBytes: free,
        utilityInstallationBytes: 0,
        volumePresent: false,
        mountPresent: false,
        credentialsPresent: false,
      };
    },
    availableBytes() {
      return free;
    },
    readJournal() {
      return journal && structuredClone(journal);
    },
    writeJournal(record) {
      expect(locked).toBe(true);
      writes.push(structuredClone(record));
      journal = structuredClone(record);
    },
    async inspect(step) {
      return existing.has(step) ? 'matching' : 'absent';
    },
    async apply(step) {
      expect(journal).toMatchObject({ step, phase: 'intent' });
      applied.push(step);
      existing.add(step);
      if (step === 'allocate') free -= VAULT_BYTES;
    },
  };
  return {
    identity,
    ports,
    existing,
    applied,
    writes,
    setFree(n: number) {
      free = n;
    },
    setJournal(j: VaultProvisionJournal) {
      journal = j;
    },
  };
}
it('persists intent before every bounded step and verifies completion under its own lock', async () => {
  const f = fixture();
  expect(await provisionVault(f.identity, f.ports)).toMatchObject({ status: 'ready', volumeBytes: VAULT_BYTES });
  expect(f.applied).toEqual([...VAULT_PROVISION_STEPS]);
  expect(f.writes.at(-1)).toMatchObject({ step: 'units', phase: 'complete' });
  const writes = f.writes.length;
  await provisionVault(f.identity, f.ports);
  expect(f.applied).toHaveLength(VAULT_PROVISION_STEPS.length);
  expect(f.writes).toHaveLength(writes);
});
it.each(['luks', 'filesystem'] as const)('reconciles a lost %s reply without replaying a format', async (step) => {
  const f = fixture(),
    apply = f.ports.apply;
  let interrupted = false;
  f.ports.apply = async (current, identity) => {
    await apply(current, identity);
    if (current === step && !interrupted) {
      interrupted = true;
      throw Error('PRIVATE_INTERRUPTION');
    }
  };
  await expect(provisionVault(f.identity, f.ports)).rejects.toThrow('vault_provisioning_unavailable');
  expect(await provisionVault(f.identity, f.ports)).toMatchObject({ status: 'ready' });
  expect(f.applied.filter((s) => s === step)).toHaveLength(1);
});
it.each(['luks', 'filesystem'] as const)('denies an unresolved %s intent instead of formatting again', async (step) => {
  const f = fixture(),
    apply = f.ports.apply;
  f.ports.apply = async (current, identity) => {
    if (current === step) throw Error('PRIVATE_INTERRUPTION');
    await apply(current, identity);
  };
  await expect(provisionVault(f.identity, f.ports)).rejects.toThrow('vault_provisioning_unavailable');
  f.ports.apply = apply;
  await expect(provisionVault(f.identity, f.ports)).rejects.toThrow('vault_provisioning_unavailable');
  expect(f.applied).not.toContain(step);
});
it('denies insufficient initial or resumed capacity and leaves unrelated files alone', async () => {
  const f = fixture();
  f.setFree(VAULT_BYTES + VAULT_FREE_FLOOR - 1);
  await expect(provisionVault(f.identity, f.ports)).rejects.toThrow('vault_provisioning_unavailable');
  expect(f.writes).toEqual([]);
  f.setFree(4 * VAULT_BYTES);
  const apply = f.ports.apply;
  f.ports.apply = async (step, identity) => {
    await apply(step, identity);
    if (step === 'allocate') throw Error('interrupted');
  };
  await expect(provisionVault(f.identity, f.ports)).rejects.toThrow('vault_provisioning_unavailable');
  f.setFree(VAULT_FREE_FLOOR - 1);
  f.ports.apply = apply;
  await expect(provisionVault(f.identity, f.ports)).rejects.toThrow('vault_provisioning_unavailable');
  expect(f.applied).toEqual(['utilities', 'keys', 'allocate']);
});
it.each(['identity', 'journal', 'authority', 'memory', 'conflict', 'false-success', 'complete-loss'])(
  'fails closed on %s with a fixed private error',
  async (reason) => {
    const f = fixture();
    if (reason === 'identity') f.identity.operationId = '../../PRIVATE_CANARY';
    if (reason === 'journal')
      f.setJournal({
        contract: 'cos-vault-provision/v1',
        identity: { ...f.identity, recoveryReference: randomUUID() },
        step: 'luks',
        phase: 'applied',
      });
    if (reason === 'authority')
      f.ports.assertAuthority = async () => {
        throw Error('PRIVATE_AUTHORITY');
      };
    if (reason === 'memory')
      f.ports.assertMemory = () => {
        throw Error('PRIVATE_MEMORY');
      };
    if (reason === 'conflict') f.ports.inspect = async () => 'conflict';
    if (reason === 'false-success') f.ports.apply = async () => {};
    if (reason === 'complete-loss') {
      await provisionVault(f.identity, f.ports);
      f.existing.delete('mount');
    }
    await expect(provisionVault(f.identity, f.ports)).rejects.toThrow('vault_provisioning_unavailable');
  },
);
