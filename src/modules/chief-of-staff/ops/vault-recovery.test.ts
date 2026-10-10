import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { checkVaultRecovery, type VaultRecoveryPorts } from './vault-recovery.js';
function fixture() {
  const identity = {
    operationId: randomUUID(),
    targetDigest: 'a'.repeat(64),
    recoveryReference: randomUUID(),
    luksUuid: randomUUID(),
    filesystemUuid: randomUUID(),
  };
  const events: string[] = [];
  let mounted = true;
  const journal = {
    contract: 'cos-vault-provision/v1' as const,
    identity,
    phase: 'complete' as const,
    step: 'units' as const,
  };
  const ports = {
    withLock: async <T>(operation: () => Promise<T>) => operation(),
    assertAuthority: vi.fn(async () => {}),
    assertMemory: vi.fn(() => {}),
    readJournal: vi.fn(() => journal),
    inspectRecovery: vi.fn(async () => (mounted ? ('mounted' as const) : ('closed' as const))),
    closeStorage: vi.fn(async () => {
      events.push('close');
      mounted = false;
    }),
    openRecovery: vi.fn(async () => {
      events.push('recovery-open');
    }),
    verifyRecoveryCanary: vi.fn(async () => {
      events.push('private-readonly-canary');
    }),
    closeRecovery: vi.fn(async () => {
      events.push('recovery-close');
    }),
    verifyCanary: vi.fn(async () => {
      events.push('canary');
    }),
    startStorage: vi.fn(async () => {
      events.push('normal-start');
      mounted = true;
    }),
  } satisfies VaultRecoveryPorts;
  return {
    identity,
    journal,
    ports,
    events,
    setClosed: () => {
      mounted = false;
    },
  };
}
it('closes the verified vault before recovery unlock, verifies the canary, and checks normal unlock before success', async () => {
  const f = fixture();
  expect(await checkVaultRecovery(f.identity, f.ports)).toEqual({
    status: 'ready',
    volumeBytes: 1073741824,
    identityDigest: digest(f.identity),
  });
  expect(f.events).toEqual([
    'canary',
    'close',
    'recovery-open',
    'private-readonly-canary',
    'recovery-close',
    'normal-start',
    'canary',
  ]);
});
it('can resume safely from a previously closed claimed vault without recreating any provisioned resource', async () => {
  const f = fixture();
  f.setClosed();
  await expect(checkVaultRecovery(f.identity, f.ports)).resolves.toMatchObject({ status: 'ready' });
  expect(f.events[0]).toBe('close');
});
it('checks the recovery canary away from mounts bound to the inactive normal unlock service', async () => {
  const f = fixture();
  const mountStorage = vi.fn(async () => {
    throw Error('NORMAL_UNLOCK_INACTIVE');
  });
  const recovery = {
    ...f.ports,
    mountStorage,
  };
  await expect(checkVaultRecovery(f.identity, recovery)).resolves.toMatchObject({ status: 'ready' });
  expect(mountStorage).not.toHaveBeenCalled();
  expect(f.events).toEqual([
    'canary',
    'close',
    'recovery-open',
    'private-readonly-canary',
    'recovery-close',
    'normal-start',
    'canary',
  ]);
});
it.each(['foreign-journal', 'incomplete', 'wrong-key', 'memory', 'canary', 'withdrawal', 'normal-start', 'not-closed'])(
  'denies %s without reporting a recovery receipt',
  async (reason) => {
    const f = fixture();
    if (reason === 'foreign-journal') f.journal.identity = { ...f.identity, luksUuid: randomUUID() };
    if (reason === 'incomplete') f.ports.readJournal.mockReturnValue({ ...f.journal, phase: 'applied' } as never);
    if (reason === 'wrong-key') f.ports.inspectRecovery.mockRejectedValue(Error('PRIVATE_KEY'));
    if (reason === 'memory')
      f.ports.assertMemory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    if (reason === 'canary') f.ports.verifyCanary.mockRejectedValue(Error('PRIVATE_CANARY'));
    if (reason === 'withdrawal')
      f.ports.openRecovery.mockImplementation(async () => {
        f.ports.assertAuthority.mockRejectedValue(Error('PRIVATE_LEASE'));
      });
    if (reason === 'normal-start') f.ports.startStorage.mockRejectedValue(Error('PRIVATE_UNIT'));
    if (reason === 'not-closed') f.ports.inspectRecovery.mockResolvedValue('mounted');
    await expect(checkVaultRecovery(f.identity, f.ports)).rejects.toThrow('vault_recovery_unavailable');
    if (['foreign-journal', 'incomplete', 'wrong-key', 'memory', 'canary'].includes(reason))
      expect(f.ports.closeStorage).not.toHaveBeenCalled();
    if (reason === 'withdrawal') {
      expect(f.ports.verifyRecoveryCanary).not.toHaveBeenCalled();
      expect(f.ports.startStorage).not.toHaveBeenCalled();
    }
  },
);
