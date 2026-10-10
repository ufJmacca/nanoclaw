import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import {
  backupNasInitializationRetirementJournal,
  transitionBackupNasInitializationRetirement,
  type BackupNasInitializationRetirementPorts,
} from './backup-nas-initialization-retirement-state.js';
function fixture(kind: 'closed-underlay' | 'configuration-stage' | 'service-stage' = 'closed-underlay') {
  const resource =
    kind === 'closed-underlay'
      ? { kind, device: 17, inode: 23 }
      : { kind, device: 17, inode: 23, stageId: randomUUID(), contentDigest: 'c'.repeat(64) };
  const scope = { nasDigest: 'a'.repeat(64), vaultStateDigest: 'b'.repeat(64), resource };
  const events: string[] = [];
  let journal: unknown = null,
    present = true,
    allowed = true;
  const ports = {
    assertAuthority: vi.fn(async () => {
      events.push('authority');
      if (!allowed) throw Error('PRIVATE_REVOKED');
    }),
    readJournal: vi.fn(async () => journal),
    writeJournal: vi.fn<BackupNasInitializationRetirementPorts['writeJournal']>(async (value) => {
      events.push(value.phase);
      journal = value;
    }),
    observe: vi.fn<BackupNasInitializationRetirementPorts['observe']>(async () =>
      present ? { state: 'present', resource } : { state: 'absent' },
    ),
    retire: vi.fn(async () => {
      events.push('effect');
      present = false;
    }),
  };
  const record = (phase: 'retiring' | 'retired') => ({
    contract: 'cos-backup-nas-initialization-retirement/v1',
    nasDigest: scope.nasDigest,
    vaultStateDigest: scope.vaultStateDigest,
    resource,
    phase,
  });
  const invoke = () => transitionBackupNasInitializationRetirement(scope, ports);
  return {
    resource,
    scope,
    events,
    ports,
    record,
    invoke,
    getJournal: () => journal,
    setJournal(value: unknown) {
      journal = value;
    },
    setPresent(value: boolean) {
      present = value;
    },
    revoke() {
      allowed = false;
    },
  };
}
it.each(['closed-underlay', 'configuration-stage', 'service-stage'] as const)(
  'persists exact %s intent before one fixed effect and verifies its durable completion',
  async (kind) => {
    const f = fixture(kind),
      result = await f.invoke();
    expect(result).toEqual({
      contract: 'cos-backup-nas-initialization-retirement-result/v1',
      status: 'retired',
      nasDigest: f.scope.nasDigest,
      vaultStateDigest: f.scope.vaultStateDigest,
      resourceDigest: digest(f.resource),
    });
    expect(f.events.indexOf('retiring')).toBeLessThan(f.events.indexOf('effect'));
    expect(f.events.indexOf('effect')).toBeLessThan(f.events.indexOf('retired'));
    expect(f.ports.retire).toHaveBeenCalledExactlyOnceWith();
    expect(f.getJournal()).toEqual(f.record('retired'));
    expect(Object.isFrozen(result)).toBe(true);
  },
);
it('denies missing resources without an existing durable retirement intent', async () => {
  const f = fixture();
  f.setPresent(false);
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_retirement_unavailable$/);
  expect(f.ports.retire).not.toHaveBeenCalled();
  expect(f.ports.writeJournal).not.toHaveBeenCalled();
});
it.each(['retiring', 'retired'] as const)(
  'reconciles %s absence with fresh permission without replaying the effect',
  async (phase) => {
    const f = fixture();
    f.setPresent(false);
    f.setJournal(f.record(phase));
    await expect(f.invoke()).resolves.toMatchObject({ status: 'retired' });
    expect(f.ports.retire).not.toHaveBeenCalled();
    expect(f.getJournal()).toEqual(f.record('retired'));
    expect(f.ports.assertAuthority.mock.calls.length).toBeGreaterThan(2);
  },
);
it('retries a durable intent only while the same exact resource is still present', async () => {
  const f = fixture();
  f.setJournal(f.record('retiring'));
  await expect(f.invoke()).resolves.toMatchObject({ status: 'retired' });
  expect(f.ports.retire).toHaveBeenCalledOnce();
});
it('refuses a resource present after recorded completion', async () => {
  const f = fixture();
  f.setJournal(f.record('retired'));
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_retirement_unavailable$/);
  expect(f.ports.retire).not.toHaveBeenCalled();
});
it.each(['nas', 'vault', 'inode', 'kind', 'phase', 'authority', 'path'])(
  'refuses foreign %s journal material without effects',
  async (reason) => {
    const f = fixture(),
      record: Record<string, unknown> = f.record('retiring');
    if (reason === 'nas') record.nasDigest = 'd'.repeat(64);
    if (reason === 'vault') record.vaultStateDigest = 'd'.repeat(64);
    if (reason === 'inode') record.resource = { ...f.resource, inode: 24 };
    if (reason === 'kind')
      record.resource = {
        kind: 'configuration-stage',
        device: 17,
        inode: 23,
        stageId: randomUUID(),
        contentDigest: 'c'.repeat(64),
      };
    if (reason === 'phase') record.phase = 'authorized';
    if (reason === 'authority') record.authority = { token: 'PRIVATE' };
    if (reason === 'path') record.path = '/tmp';
    f.setJournal(record);
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_retirement_unavailable$/);
    expect(f.ports.retire).not.toHaveBeenCalled();
    expect(f.ports.writeJournal).not.toHaveBeenCalled();
  },
);
it.each(['intent-write', 'before-effect', 'during-effect', 'completion-write'])(
  'keeps durable retry state when permission is lost at %s',
  async (reason) => {
    const f = fixture(),
      originalWrite = f.ports.writeJournal.getMockImplementation()!,
      originalRetire = f.ports.retire.getMockImplementation()!;
    if (reason === 'intent-write')
      f.ports.writeJournal.mockImplementation(async (value) => {
        await originalWrite(value);
        f.revoke();
      });
    if (reason === 'before-effect') {
      let observed = 0;
      const original = f.ports.observe.getMockImplementation()!;
      f.ports.observe.mockImplementation(async () => {
        const value = await original();
        if (++observed === 2) f.revoke();
        return value;
      });
    }
    if (reason === 'during-effect')
      f.ports.retire.mockImplementation(async () => {
        await originalRetire();
        f.revoke();
      });
    if (reason === 'completion-write')
      f.ports.writeJournal.mockImplementation(async (value) => {
        await originalWrite(value);
        if (value.phase === 'retired') f.revoke();
      });
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_retirement_unavailable$/);
    expect(f.getJournal()).toEqual(f.record(reason === 'completion-write' ? 'retired' : 'retiring'));
    if (['intent-write', 'before-effect'].includes(reason)) expect(f.ports.retire).not.toHaveBeenCalled();
    else expect(f.ports.retire).toHaveBeenCalledOnce();
  },
);
it('does not act if the intent writer fails its durable publication', async () => {
  const f = fixture();
  f.ports.writeJournal.mockRejectedValue(Error('PRIVATE_FSYNC'));
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_retirement_unavailable$/);
  expect(f.ports.retire).not.toHaveBeenCalled();
});
it('refuses an effect that returns without removing the selected resource', async () => {
  const f = fixture();
  f.ports.retire.mockResolvedValue();
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_retirement_unavailable$/);
  expect(f.getJournal()).toEqual(f.record('retiring'));
});
it('refuses a journal replaced during the effect', async () => {
  const f = fixture(),
    original = f.ports.retire.getMockImplementation()!;
  f.ports.retire.mockImplementation(async () => {
    await original();
    f.setJournal({ ...f.record('retiring'), resource: { ...f.resource, inode: 24 } });
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_retirement_unavailable$/);
  expect(f.ports.writeJournal.mock.calls).toHaveLength(1);
});
it('snapshots the input resource before awaited permission so caller mutation cannot widen the effect', async () => {
  const f = fixture(),
    original = f.ports.assertAuthority.getMockImplementation()!;
  f.ports.assertAuthority.mockImplementationOnce(async () => {
    await original();
    f.scope.resource.inode = 24;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_retirement_unavailable$/);
  expect(f.ports.retire).not.toHaveBeenCalled();
});
it('strictly freezes journal snapshots and refuses hidden selectors', () => {
  const f = fixture('service-stage'),
    input = f.record('retiring'),
    result = backupNasInitializationRetirementJournal(input, f.scope);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.resource)).toBe(true);
  input.resource.inode = 24;
  expect(result.resource.inode).toBe(23);
  const hidden = f.record('retiring');
  Object.defineProperty(hidden, 'path', { value: '/tmp' });
  expect(() => backupNasInitializationRetirementJournal(hidden, f.scope)).toThrow(
    /^backup_nas_initialization_retirement_unavailable$/,
  );
});
