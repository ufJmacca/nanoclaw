import { beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ vault: vi.fn(), access: vi.fn(), record: vi.fn(), memory: vi.fn(), kernel: vi.fn() }));
vi.mock('./vault-storage.js', () => ({ verifyVaultStorage: f.vault, withVaultDirectory: f.access }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./backup-queue.js', () => ({
  createVaultBackupQueue: () => ({ recordCredential: f.record }),
  BackupQueue: class {
    recordCredential = f.record;
  },
}));
import { createVaultCredentialJournal, withVaultCredentialJournal } from './backup-credential-journal.js';

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
    return { targetDigest: 'b'.repeat(64), volume: { filesystemUuid: 'synthetic-volume' } };
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

it('holds full journal topology for the owner lifetime while retaining every publication and current guard', async () => {
  const state = vi.fn();
  await withVaultCredentialJournal(roots, async (journal) => {
    const opened = f.vault.mock.calls.length;
    for (let index = 0; index < 10; index++) await journal(change, state);
    expect(f.vault.mock.calls.length).toBe(opened);
    expect(f.record).toHaveBeenCalledTimes(10);
    expect(state.mock.calls.length).toBeGreaterThanOrEqual(200);
    expect(f.kernel.mock.calls.length).toBeGreaterThanOrEqual(200);
  });
  expect(f.vault).toHaveBeenCalledTimes(3);
});

it.each(['state', 'kernel', 'memory'] as const)(
  'withdraws an already-held journal during awaited %s loss',
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
    await expect(withVaultCredentialJournal(roots, (journal) => journal(change, state))).rejects.toThrow();
    expect(published).toBe(false);
  },
);

it('retires each lent publication guard before the held owner closes and the journal after close', async () => {
  let retained!: () => void;
  let borrowed!: Parameters<Parameters<typeof withVaultCredentialJournal>[1]>[0];
  f.record.mockImplementation(async (_change, current) => {
    retained = current;
    current();
  });
  await withVaultCredentialJournal(roots, async (journal) => {
    borrowed = journal;
    await journal(change, () => {});
    expect(() => retained()).toThrow();
    await journal(change, () => {});
    expect(() => retained()).toThrow();
  });
  const calls = f.record.mock.calls.length;
  await expect(borrowed(change, () => {})).rejects.toThrow(/^backup_credential_journal_unavailable$/);
  expect(f.record.mock.calls.length).toBe(calls);
});
