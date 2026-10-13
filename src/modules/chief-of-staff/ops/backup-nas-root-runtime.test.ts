import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  readVault: vi.fn(),
  readNas: vi.fn(),
  artifact: vi.fn(),
  artifactScope: vi.fn(),
  memory: vi.fn(),
  credential: vi.fn(),
  rootJournal: vi.fn(),
  observe: vi.fn(),
  mount: vi.fn(),
  unmount: vi.fn(),
}));
vi.mock('./vault-root-config.js', async (original) => ({
  ...(await original<object>()),
  readVaultRootConfiguration: f.readVault,
}));
vi.mock('./backup-nas-root-config.js', async (original) => ({
  ...(await original<object>()),
  readBackupNasRootConfiguration: f.readNas,
}));
vi.mock('./vault-root-artifact.js', () => ({
  verifyVaultRootArtifact: f.artifact,
  withVaultRootArtifact: f.artifactScope,
}));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./backup-smb-root-lease.js', () => ({ withRootBackupSmbCredentials: f.credential }));
vi.mock('./backup-nas-root-journal.js', () => ({ withBackupNasRootJournal: f.rootJournal }));
vi.mock('./backup-nas-kernel.js', () => ({ observeBackupNasMount: f.observe }));
vi.mock('./backup-nas-mount-process.js', () => ({ executeBackupNasMount: f.mount }));
vi.mock('./backup-nas-unmount-process.js', () => ({ executeBackupNasUnmount: f.unmount }));
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { type BackupNasMountJournal, type BackupNasMountObservation } from './backup-nas-mount-state.js';
import { runBackupNasRootMount } from './backup-nas-root-runtime.js';
afterEach(() => {
  for (const fn of Object.values(f)) fn.mockReset();
});
function fixture(mounted = false, interrupted = false) {
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const vault = vaultRootConfiguration({
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
  const nas = {
    contract: 'cos-backup-nas-root-config/v1' as const,
    host: '192.168.56.12',
    credentialReference: randomUUID(),
    vaultStateDigest: vaultRootStateDigest(vault),
  };
  const scope = {
    configurationDigest: digest(nas),
    bindingDigest: digest({ host: nas.host, share: 'nanoclaw-cos-backups', mount: '/var/lib/nanoclaw-cos/nas' }),
  };
  const underlay = { device: 17, inode: 23 },
    claim = { id: 42, device: 44, inode: 45, bindingDigest: scope.bindingDigest };
  let journal: BackupNasMountJournal = {
    contract: 'cos-backup-nas-mount-state/v1',
    configurationDigest: scope.configurationDigest,
    underlay,
    phase: interrupted ? 'mounting' : mounted ? 'mounted' : 'closed',
    attemptId: mounted || interrupted ? randomUUID() : null,
    mount: mounted && !interrupted ? claim : null,
  };
  let actual: BackupNasMountObservation = mounted ? { state: 'mounted', mount: claim } : { state: 'closed', underlay };
  const abort = new AbortController();
  const credential = { fd: 42, signal: abort.signal, assertCurrent: vi.fn(async () => {}) },
    saved: BackupNasMountJournal[] = [];
  let writerHeld = false,
    artifactHeld = false;
  f.artifactScope.mockImplementation(async (config, operation) => {
    f.artifact(config);
    artifactHeld = true;
    try {
      return await operation({
        assertCurrent: () => {
          expect(artifactHeld).toBe(true);
          f.artifact(config);
        },
      });
    } finally {
      artifactHeld = false;
    }
  });
  f.readVault.mockReturnValue(vault);
  f.readNas.mockReturnValue(nas);
  f.credential.mockImplementation(async (_vault, _reference, operation) => operation(credential));
  f.rootJournal.mockImplementation(async (_vault, _nas, operation, controls) => {
    await controls.assertAuthority();
    writerHeld = true;
    try {
      return await operation({
        scope,
        assertCurrent: controls.assertAuthority,
        readJournal: () => journal,
        writeJournal: async (next: BackupNasMountJournal) => {
          await controls.assertAuthority();
          journal = next;
          saved.push(next);
        },
      });
    } finally {
      writerHeld = false;
    }
  });
  f.observe.mockImplementation(() => actual);
  f.mount.mockImplementation(async (_input, lease, destination) => {
    expect(artifactHeld).toBe(true);
    expect(writerHeld).toBe(true);
    expect(lease).toBe(credential);
    destination('before');
    actual = { state: 'mounted', mount: claim };
    destination('after');
  });
  f.unmount.mockImplementation(async (_claim, _lease, destination) => {
    expect(artifactHeld).toBe(true);
    expect(writerHeld).toBe(true);
    destination('before', claim);
    actual = { state: 'closed', underlay };
    destination('after', claim);
  });
  return {
    vault,
    nas,
    scope,
    underlay,
    claim,
    credential,
    saved,
    journal: () => journal,
    foreignInstance: () => {
      actual = { state: 'mounted', mount: { ...claim, id: claim.id + 1 } };
    },
  };
}
it('composes the fixed root metadata, sealed helper, live owner descriptor, journal writer and independent kernel admission', async () => {
  const s = fixture();
  expect(process.getuid?.()).toBe(0);
  expect(await runBackupNasRootMount('mount')).toEqual({
    contract: 'cos-backup-nas-mount-result/v1',
    status: 'mounted',
    configurationDigest: s.scope.configurationDigest,
    mountId: s.claim.id,
  });
  expect(f.credential).toHaveBeenCalledWith(s.vault, s.nas.credentialReference, expect.any(Function));
  expect(f.mount).toHaveBeenCalledWith(
    { host: s.nas.host, userId: 1000, groupId: 1000 },
    s.credential,
    expect.any(Function),
  );
  expect(s.saved.map((value) => value.phase)).toEqual(['mounting', 'mounted']);
  expect(s.credential.assertCurrent.mock.calls.length).toBeGreaterThan(32);
  expect(f.artifact).toHaveBeenCalledWith(s.vault);
  expect(f.artifactScope).toHaveBeenCalledTimes(1);
});
it('disconnects a recorded exact instance under current root authority without opening an owner credential', async () => {
  const s = fixture(true);
  expect(await runBackupNasRootMount('unmount')).toEqual({
    contract: 'cos-backup-nas-mount-result/v1',
    status: 'closed',
    configurationDigest: s.scope.configurationDigest,
  });
  expect(f.credential).not.toHaveBeenCalled();
  expect(f.mount).not.toHaveBeenCalled();
  expect(f.unmount).toHaveBeenCalledWith(
    s.claim,
    expect.objectContaining({ signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) }),
    expect.any(Function),
  );
  expect(s.saved.map((value) => value.phase)).toEqual(['unmounting', 'closed']);
});
it.each(['memory', 'vault', 'nas', 'artifact', 'invalid-action'])(
  'denies initial %s before any credential or mount operation',
  async (reason) => {
    fixture();
    if (reason === 'memory')
      f.memory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    if (reason === 'vault')
      f.readVault.mockImplementation(() => {
        throw Error('PRIVATE_ROOT_CONFIG');
      });
    if (reason === 'nas')
      f.readNas.mockImplementation(() => {
        throw Error('PRIVATE_NAS_CONFIG');
      });
    if (reason === 'artifact')
      f.artifact.mockImplementation(() => {
        throw Error('PRIVATE_ARTIFACT');
      });
    await expect(runBackupNasRootMount(reason === 'invalid-action' ? ('foreign' as 'mount') : 'mount')).rejects.toThrow(
      /^backup_nas_root_mount_unavailable$/,
    );
    expect(f.credential).not.toHaveBeenCalled();
    expect(f.mount).not.toHaveBeenCalled();
    expect(f.unmount).not.toHaveBeenCalled();
  },
);
it.each(['vault-update', 'nas-update', 'owner-lease', 'kernel-instance'])(
  'denies %s at composition boundaries before an unmount or mount effect',
  async (reason) => {
    const s = fixture(reason === 'kernel-instance');
    if (reason === 'vault-update')
      s.credential.assertCurrent.mockImplementation(async () => {
        f.readVault.mockReturnValue({ ...s.vault, artifact: { ...s.vault.artifact, sourceCommit: 'f'.repeat(40) } });
      });
    if (reason === 'nas-update')
      s.credential.assertCurrent.mockImplementation(async () => {
        f.readNas.mockReturnValue({ ...s.nas, credentialReference: randomUUID() });
      });
    if (reason === 'owner-lease') s.credential.assertCurrent.mockRejectedValue(Error('PRIVATE_CREDENTIAL_LEASE'));
    if (reason === 'kernel-instance') s.foreignInstance();
    await expect(runBackupNasRootMount(reason === 'kernel-instance' ? 'unmount' : 'mount')).rejects.toThrow(
      /^backup_nas_root_mount_unavailable$/,
    );
    expect(f.mount).not.toHaveBeenCalled();
    expect(f.unmount).not.toHaveBeenCalled();
  },
);
it('never treats the ordinary service invocation as fresh native maintenance for an unrecorded mount', async () => {
  const s = fixture(true, true);
  await expect(runBackupNasRootMount('mount')).rejects.toThrow(/^backup_nas_root_mount_unavailable$/);
  expect(s.saved).toEqual([]);
  expect(f.mount).not.toHaveBeenCalled();
  expect(f.unmount).not.toHaveBeenCalled();
});
it('keeps an already verified owned mount idempotent while still requiring the live owner credential lease', async () => {
  const s = fixture(true);
  expect((await runBackupNasRootMount('mount')).status).toBe('mounted');
  expect(f.credential).toHaveBeenCalledTimes(1);
  expect(s.credential.assertCurrent).toHaveBeenCalled();
  expect(f.mount).not.toHaveBeenCalled();
  expect(f.unmount).not.toHaveBeenCalled();
  expect(s.saved).toEqual([]);
});
it('rejects an uncertain utility result and preserves the durable mounting intent', async () => {
  const s = fixture();
  f.mount.mockRejectedValue(Error('PRIVATE_MOUNT_DIAGNOSTIC'));
  await expect(runBackupNasRootMount('mount')).rejects.toThrow(/^backup_nas_root_mount_unavailable$/);
  expect(s.journal().phase).toBe('mounting');
  expect(s.saved.map((value) => value.phase)).toEqual(['mounting']);
});
