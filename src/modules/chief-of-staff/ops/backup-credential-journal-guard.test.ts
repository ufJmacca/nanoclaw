import { beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ vault: vi.fn(), access: vi.fn(), record: vi.fn(), memory: vi.fn(), kernel: vi.fn() }));
vi.mock('./vault-storage.js', () => ({ verifyVaultStorage: f.vault, withVaultDirectory: f.access }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./backup-queue.js', () => ({ createVaultBackupQueue: () => ({ recordCredential: f.record }) }));
import { createVaultCredentialJournal } from './backup-credential-journal.js';

const roots = { targetRoot: '/synthetic/state', installationRoot: '/synthetic/install', dataRoot: '/synthetic/data' };
const change = {
  sourceKind: 'mail_reader' as const,
  sourceKey: 'a'.repeat(64),
  generation: 1,
  phase: 'ready' as const,
  files: [{ name: 'credential.json', bytes: Buffer.from('SYNTHETIC') }],
};

beforeEach(() => {
  for (const mock of Object.values(f)) mock.mockReset();
  f.vault.mockImplementation(() => {
    f.kernel();
    return { contract: 'synthetic-proof' };
  });
  f.access.mockImplementation(async (_roots, _area, operation, _inspect, memory) => {
    memory();
    f.vault();
    let active = true;
    const current = () => {
      if (!active) throw Error('vault_storage_unavailable');
      memory();
      f.kernel();
    };
    try {
      const result = await operation('/synthetic/held-directory', current);
      current();
      f.vault();
      memory();
      return result;
    } finally {
      active = false;
    }
  });
  f.record.mockImplementation(async (_change, current) => {
    for (let index = 0; index < 20; index++) {
      await Promise.resolve();
      current();
    }
  });
});

it('bounds full topology inspection independently of the number of credential publication guards', async () => {
  const state = vi.fn();
  await createVaultCredentialJournal(roots)(change, state);
  expect(f.record).toHaveBeenCalledWith(change, expect.any(Function));
  expect(state.mock.calls.length).toBeGreaterThanOrEqual(20);
  expect(f.kernel.mock.calls.length).toBeGreaterThanOrEqual(20);
  expect(f.vault).toHaveBeenCalledTimes(2);
});

it.each(['state', 'kernel', 'memory'] as const)(
  'withdraws every publication guard after awaited %s loss',
  async (kind) => {
    let available = true,
      published = false;
    const state = () => {
      if (kind === 'state' && !available) throw Error('PRIVATE_STATE');
    };
    f.kernel.mockImplementation(() => {
      if (kind === 'kernel' && !available) throw Error('PRIVATE_MOUNT');
    });
    f.memory.mockImplementation(() => {
      if (kind === 'memory' && !available) throw Error('PRIVATE_MEMORY');
    });
    f.record.mockImplementation(async (_change, current) => {
      current();
      await Promise.resolve();
      available = false;
      current();
      published = true;
    });
    await expect(createVaultCredentialJournal(roots)(change, state)).rejects.toThrow(
      /^backup_credential_journal_unavailable$/,
    );
    expect(published).toBe(false);
  },
);

it('retires the lent publication guard after the journal call settles', async () => {
  let retained!: () => void;
  f.record.mockImplementation(async (_change, current) => {
    retained = current;
    current();
  });
  await createVaultCredentialJournal(roots)(change, () => {});
  expect(() => retained()).toThrow();
});
