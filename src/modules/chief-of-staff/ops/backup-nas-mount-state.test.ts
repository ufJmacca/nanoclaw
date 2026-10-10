import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import {
  transitionBackupNasMount,
  backupNasMountJournal,
  type BackupNasMountJournal,
  type BackupNasMountObservation,
} from './backup-nas-mount-state.js';
function fixture() {
  const scope = { configurationDigest: 'a'.repeat(64), bindingDigest: 'b'.repeat(64) };
  const underlay = { device: 100, inode: 1234 };
  const mount = { id: 52, device: 101, inode: 1, bindingDigest: scope.bindingDigest };
  let record: BackupNasMountJournal = {
    contract: 'cos-backup-nas-mount-state/v1',
    configurationDigest: scope.configurationDigest,
    underlay,
    phase: 'closed',
    attemptId: null,
    mount: null,
  };
  let observation: BackupNasMountObservation = { state: 'closed', underlay };
  const writes: BackupNasMountJournal[] = [];
  const ports = {
    assertAuthority: vi.fn(async () => {}),
    assertRecoveryAuthority: vi.fn(async (): Promise<void> => {
      throw Error('RECOVERY_NOT_AUTHORIZED');
    }),
    readJournal: vi.fn(async () => structuredClone(record)),
    writeJournal: vi.fn(async (next: BackupNasMountJournal) => {
      record = structuredClone(next);
      writes.push(structuredClone(next));
    }),
    observe: vi.fn(async () => structuredClone(observation)),
    mount: vi.fn(async () => {
      observation = { state: 'mounted', mount };
    }),
    unmount: vi.fn(async (_mount: Readonly<typeof mount>) => {
      observation = { state: 'closed', underlay };
    }),
  };
  return {
    scope,
    underlay,
    mount,
    ports,
    writes,
    record: () => record,
    setRecord: (value: BackupNasMountJournal) => {
      record = value;
    },
    observation: () => observation,
    setObservation: (value: BackupNasMountObservation) => {
      observation = value;
    },
  };
}
it('records intent before mounting and acknowledges only the independent current mount proof', async () => {
  const s = fixture();
  s.ports.mount.mockImplementation(async () => {
    expect(s.record()).toMatchObject({ phase: 'mounting', mount: null, attemptId: expect.any(String) });
    s.setObservation({ state: 'mounted', mount: s.mount });
  });
  const result = await transitionBackupNasMount('mount', s.scope, s.ports);
  expect(result).toEqual({
    contract: 'cos-backup-nas-mount-result/v1',
    status: 'mounted',
    configurationDigest: s.scope.configurationDigest,
    mountId: 52,
  });
  expect(s.writes.map((value) => value.phase)).toEqual(['mounting', 'mounted']);
  expect(s.record().mount).toEqual(s.mount);
  expect(s.ports.assertAuthority.mock.calls.length).toBeGreaterThan(4);
  expect(s.ports.assertRecoveryAuthority).not.toHaveBeenCalled();
});
it.each([
  { configurationDigest: 'foreign' },
  { bindingDigest: 'foreign' },
  { bindingDigest: undefined },
  { command: '/bin/sh' },
])('refuses a journal parsed under an invalid scope %j', (patch) => {
  const s = fixture(),
    scope = { ...s.scope, ...patch };
  expect(() =>
    backupNasMountJournal({ ...s.record(), configurationDigest: scope.configurationDigest }, scope as never),
  ).toThrow(/^backup_nas_mount_state_unavailable$/);
});
it('holds observed primitives across awaited authority checks rather than borrowing mutable proof objects', async () => {
  const s = fixture(),
    borrowed = { state: 'mounted' as const, mount: { ...s.mount } };
  s.setRecord({ ...s.record(), phase: 'mounted', attemptId: randomUUID(), mount: s.mount });
  s.setObservation({ state: 'mounted', mount: s.mount });
  let returned = false;
  s.ports.observe.mockImplementationOnce(async () => {
    returned = true;
    return borrowed;
  });
  s.ports.assertAuthority.mockImplementation(async () => {
    if (returned) borrowed.mount.id = 53;
  });
  await expect(transitionBackupNasMount('mount', s.scope, s.ports)).resolves.toMatchObject({
    status: 'mounted',
    mountId: 52,
  });
  expect(s.ports.mount).not.toHaveBeenCalled();
});
it('is idempotent only for the exact already-recorded kernel mount', async () => {
  const s = fixture();
  await transitionBackupNasMount('mount', s.scope, s.ports);
  s.ports.mount.mockClear();
  const count = s.writes.length;
  await transitionBackupNasMount('mount', s.scope, s.ports);
  expect(s.ports.mount).not.toHaveBeenCalled();
  expect(s.writes.length).toBe(count);
});
it('persists unmount intent, passes the exact claimed mount, and verifies the closed underlay before completion', async () => {
  const s = fixture();
  await transitionBackupNasMount('mount', s.scope, s.ports);
  s.writes.length = 0;
  s.ports.unmount.mockImplementation(async (mount) => {
    expect(mount).toEqual(s.mount);
    expect(s.record().phase).toBe('unmounting');
    s.setObservation({ state: 'closed', underlay: s.underlay });
  });
  await expect(transitionBackupNasMount('unmount', s.scope, s.ports)).resolves.toMatchObject({ status: 'closed' });
  expect(s.writes.map((value) => value.phase)).toEqual(['unmounting', 'closed']);
  expect(s.record()).toMatchObject({ mount: null, attemptId: null });
});
it('resumes an interrupted intent with no mount while preserving its operation identity', async () => {
  const s = fixture(),
    attemptId = randomUUID();
  s.setRecord({ ...s.record(), phase: 'mounting', attemptId });
  await transitionBackupNasMount('mount', s.scope, s.ports);
  expect(s.record().attemptId).toBe(attemptId);
  expect(s.ports.mount).toHaveBeenCalledTimes(1);
});
it('requires fresh recovery authority before reconciling a mount whose effect was not recorded', async () => {
  const s = fixture();
  s.setRecord({ ...s.record(), phase: 'mounting', attemptId: randomUUID() });
  s.setObservation({ state: 'mounted', mount: s.mount });
  await expect(transitionBackupNasMount('mount', s.scope, s.ports)).rejects.toThrow(
    /^backup_nas_mount_state_unavailable$/,
  );
  expect(s.ports.mount).not.toHaveBeenCalled();
  expect(s.ports.unmount).not.toHaveBeenCalled();
  expect(s.writes).toHaveLength(0);
  s.ports.assertRecoveryAuthority.mockResolvedValue(undefined);
  await expect(transitionBackupNasMount('mount', s.scope, s.ports)).resolves.toMatchObject({
    status: 'mounted',
    mountId: 52,
  });
  expect(s.ports.mount).not.toHaveBeenCalled();
  expect(s.record().mount).toEqual(s.mount);
});
it('records a disappeared mount as closed before a newly admitted connection attempt', async () => {
  const s = fixture();
  await transitionBackupNasMount('mount', s.scope, s.ports);
  const previous = s.record().attemptId;
  s.setObservation({ state: 'closed', underlay: s.underlay });
  s.writes.length = 0;
  await transitionBackupNasMount('mount', s.scope, s.ports);
  expect(s.writes.map((value) => value.phase)).toEqual(['closed', 'mounting', 'mounted']);
  expect(s.record().attemptId).not.toBe(previous);
});
it('finishes an interrupted unmount only after verifying the original closed underlay', async () => {
  const s = fixture();
  s.setRecord({ ...s.record(), phase: 'unmounting', mount: s.mount, attemptId: randomUUID() });
  await transitionBackupNasMount('unmount', s.scope, s.ports);
  expect(s.ports.unmount).not.toHaveBeenCalled();
  expect(s.record().phase).toBe('closed');
});
it.each([
  'configuration',
  'underlay',
  'binding',
  'mount-id',
  'unclaimed-mount',
  'journal-extra',
  'journal-phase',
  'journal-missing',
  'journal-claim',
  'authority',
  'action',
])('refuses %s before any OS effect', async (reason) => {
  const s = fixture();
  let action: 'mount' | 'unmount' = 'mount';
  if (reason === 'configuration') s.setRecord({ ...s.record(), configurationDigest: 'c'.repeat(64) });
  if (reason === 'underlay') s.setObservation({ state: 'closed', underlay: { ...s.underlay, inode: 999 } });
  if (reason === 'binding')
    s.setObservation({ state: 'mounted', mount: { ...s.mount, bindingDigest: 'c'.repeat(64) } });
  if (reason === 'mount-id') {
    s.setRecord({ ...s.record(), phase: 'mounted', attemptId: randomUUID(), mount: s.mount });
    s.setObservation({ state: 'mounted', mount: { ...s.mount, id: 53 } });
  }
  if (reason === 'unclaimed-mount') s.setObservation({ state: 'mounted', mount: s.mount });
  if (reason === 'journal-extra') s.setRecord({ ...s.record(), command: '/bin/sh' } as never);
  if (reason === 'journal-phase') s.setRecord({ ...s.record(), phase: 'foreign' } as never);
  if (reason === 'journal-missing') s.ports.readJournal.mockResolvedValue(null as never);
  if (reason === 'journal-claim') s.setRecord({ ...s.record(), phase: 'mounted', mount: null, attemptId: null });
  if (reason === 'authority') s.ports.assertAuthority.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
  if (reason === 'action') action = 'foreign' as never;
  await expect(transitionBackupNasMount(action, s.scope, s.ports)).rejects.toThrow(
    /^backup_nas_mount_state_unavailable$/,
  );
  expect(s.ports.mount).not.toHaveBeenCalled();
  expect(s.ports.unmount).not.toHaveBeenCalled();
});
it.each([
  'mount-failed',
  'missing-mount',
  'post-authority',
  'changed-journal',
  'changed-underlay',
  'foreign-after-mount',
  'write-failed',
])('retains closed failure semantics for %s after mount intent', async (reason) => {
  const s = fixture();
  s.ports.mount.mockImplementation(async () => {
    if (reason === 'mount-failed') throw Error('PRIVATE_MOUNT');
    if (reason !== 'missing-mount') s.setObservation({ state: 'mounted', mount: s.mount });
    if (reason === 'post-authority') s.ports.assertAuthority.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
    if (reason === 'changed-journal') s.setRecord({ ...s.record(), attemptId: randomUUID() });
    if (reason === 'changed-underlay') s.setObservation({ state: 'closed', underlay: { ...s.underlay, inode: 999 } });
    if (reason === 'foreign-after-mount')
      s.setObservation({ state: 'mounted', mount: { ...s.mount, bindingDigest: 'c'.repeat(64) } });
    if (reason === 'write-failed') s.ports.writeJournal.mockRejectedValue(Error('PRIVATE_WRITE'));
  });
  await expect(transitionBackupNasMount('mount', s.scope, s.ports)).rejects.toThrow(
    /^backup_nas_mount_state_unavailable$/,
  );
  expect(s.record().phase).toBe('mounting');
});
it.each(['busy', 'still-mounted', 'foreign-mount', 'underlay', 'changed-journal'])(
  'never completes unmount when %s remains uncertain',
  async (reason) => {
    const s = fixture();
    await transitionBackupNasMount('mount', s.scope, s.ports);
    s.ports.unmount.mockImplementation(async () => {
      if (reason === 'busy') throw Error('PRIVATE_BUSY');
      if (reason === 'still-mounted') return;
      if (reason === 'foreign-mount') s.setObservation({ state: 'mounted', mount: { ...s.mount, id: 53 } });
      if (reason === 'underlay') s.setObservation({ state: 'closed', underlay: { ...s.underlay, inode: 999 } });
      if (reason === 'changed-journal') {
        s.setObservation({ state: 'closed', underlay: s.underlay });
        s.setRecord({ ...s.record(), configurationDigest: 'c'.repeat(64) });
      }
    });
    await expect(transitionBackupNasMount('unmount', s.scope, s.ports)).rejects.toThrow(
      /^backup_nas_mount_state_unavailable$/,
    );
    expect(s.record().phase).toBe('unmounting');
  },
);
it('refuses kernel-proof changes during recovery even when maintenance authority is valid', async () => {
  const s = fixture();
  s.setRecord({ ...s.record(), phase: 'mounting', attemptId: randomUUID() });
  s.setObservation({ state: 'mounted', mount: s.mount });
  s.ports.assertRecoveryAuthority.mockImplementation(async () => {
    s.setObservation({ state: 'mounted', mount: { ...s.mount, id: 53 } });
  });
  const original = digest(s.record());
  await expect(transitionBackupNasMount('mount', s.scope, s.ports)).rejects.toThrow(
    /^backup_nas_mount_state_unavailable$/,
  );
  expect(digest(s.record())).toBe(original);
});
