import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasSetupScope } from './backup-nas-setup-wire.js';
import { backupNasRecoveryScope, type BackupNasRecoveryRequest } from './backup-nas-recovery-wire.js';
import {
  backupNasMountJournal,
  type BackupNasMountJournal,
  type BackupNasMountObservation,
} from './backup-nas-mount-state.js';
import {
  runBackupNasRootRecovery,
  verifyBackupNasRecoveryServiceIdle,
  type BackupNasRootRecoveryControls,
} from './backup-nas-root-recovery.js';
const unit = 'nanoclaw-cos-backup-mount.service';
const manager = () => ({
  Id: unit,
  LoadState: 'loaded',
  ActiveState: 'inactive',
  SubState: 'dead',
  MainPID: '0',
  Job: '',
  UnitFileState: 'static',
  FragmentPath: '/etc/systemd/system/' + unit,
  DropInPaths: '',
  NeedDaemonReload: 'no',
});
const text = (props: Record<string, string>) =>
  Object.entries(props)
    .map(([key, value]) => key + '=' + value + '\n')
    .join('');
it.each(['inactive', 'failed'])('admits only an idle %s fixed service without changing its state', (state) => {
  const value = manager();
  if (state === 'failed') {
    value.ActiveState = 'failed';
    value.SubState = 'failed';
  }
  expect(() => verifyBackupNasRecoveryServiceIdle(text(value))).not.toThrow();
});
it.each([
  'Id',
  'LoadState',
  'ActiveState',
  'SubState',
  'MainPID',
  'Job',
  'UnitFileState',
  'FragmentPath',
  'DropInPaths',
  'NeedDaemonReload',
  'duplicate',
  'extra',
  'oversized',
])('refuses manager %s before native recovery can proceed', (reason) => {
  const value = manager(),
    replacements: Record<string, string> = {
      Id: 'foreign.service',
      LoadState: 'not-found',
      ActiveState: 'active',
      SubState: 'running',
      MainPID: '42',
      Job: '12',
      UnitFileState: 'enabled',
      FragmentPath: '/tmp/' + unit,
      DropInPaths: '/tmp/override.conf',
      NeedDaemonReload: 'yes',
    };
  if (reason in replacements) value[reason as keyof typeof value] = replacements[reason];
  let output = text(value);
  if (reason === 'duplicate') output += 'MainPID=0\n';
  if (reason === 'extra') output += 'PrivateValue=never-returned\n';
  if (reason === 'oversized') output = 'a'.repeat(4097);
  expect(() => verifyBackupNasRecoveryServiceIdle(output)).toThrow(/^backup_nas_recovery_service_unavailable$/);
});
function fixture(phase: BackupNasMountJournal['phase'] = 'mounting') {
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
  const mount = { id: 55, device: 61, inode: 71, bindingDigest: scope.bindingDigest },
    underlay = { device: 17, inode: 23 };
  let journal = backupNasMountJournal(
    {
      contract: 'cos-backup-nas-mount-state/v1',
      configurationDigest: digest(nas),
      phase,
      underlay,
      attemptId: phase === 'closed' ? null : randomUUID(),
      mount: phase === 'mounting' || phase === 'closed' ? null : mount,
    },
    scope,
  );
  let actual: BackupNasMountObservation =
    phase === 'closed' ? { state: 'closed', underlay } : { state: 'mounted', mount };
  const request: BackupNasRecoveryRequest = {
    contract: 'cos-backup-nas-recover-unmount-request/v1',
    configurationDigest: digest(vault),
    nas,
    scope: backupNasRecoveryScope(vault, nas, randomUUID(), 4),
    authority: { socket: '/home/fixture/state/vault-authority/' + randomUUID() + '/proof.sock', token: 'f'.repeat(64) },
  };
  let held = false,
    artifactValid = true;
  const writes: string[] = [];
  const artifact = {
    assertCurrent() {
      expect(held).toBe(true);
      if (!artifactValid) throw Error('PRIVATE_ARTIFACT_CHANGED');
    },
  };
  const memory = vi.fn(),
    readConfiguration = vi.fn(() => vault),
    readNasConfiguration = vi.fn(() => nas),
    readRequest = vi.fn(async () => request),
    assertServiceIdle = vi.fn(),
    checkAuthority = vi.fn<NonNullable<BackupNasRootRecoveryControls['checkAuthority']>>(async () => {
      expect(held).toBe(true);
    });
  const withArtifact = vi.fn(async (_vault, operation) => {
    held = true;
    try {
      const result = await operation(artifact);
      artifact.assertCurrent();
      return result;
    } finally {
      held = false;
    }
  });
  const withJournal = vi.fn(async (_vault, _nas, operation, supplied) => {
    await supplied.assertAuthority();
    const current = async () => supplied.assertAuthority();
    const result = await operation({
      scope,
      assertCurrent: current,
      readJournal: () => journal,
      writeJournal: async (value: BackupNasMountJournal) => {
        await current();
        journal = backupNasMountJournal(value, scope);
        writes.push(journal.phase);
        await current();
      },
    });
    await current();
    return result;
  });
  const observe = vi.fn(() => actual),
    unmount = vi.fn(async (claim, lease, destination) => {
      await lease.assertCurrent();
      destination('before', claim);
      actual = { state: 'closed', underlay };
      await lease.assertCurrent();
      destination('after', claim);
    });
  const controls = {
    assertMemory: memory,
    readConfiguration,
    readNasConfiguration,
    readRequest,
    withArtifact,
    withJournal,
    observe,
    unmount,
    assertServiceIdle,
    checkAuthority,
  } as BackupNasRootRecoveryControls;
  return {
    vault,
    nas,
    request,
    mount,
    writes,
    controls,
    memory,
    readConfiguration,
    readNasConfiguration,
    readRequest,
    withArtifact,
    withJournal,
    observe,
    unmount,
    assertServiceIdle,
    checkAuthority,
    invoke: () => runBackupNasRootRecovery(Readable.from([]), controls),
    journal: () => journal,
    actual: () => actual,
    setActual: (value: BackupNasMountObservation) => {
      actual = value;
    },
    loseArtifact: () => {
      artifactValid = false;
    },
  };
}
it('recovers the independently observed unrecorded effect, closes only its exact mount and preserves journal intent until closure is verified', async () => {
  const f = fixture(),
    result = await f.invoke();
  expect(process.getuid?.()).toBe(0);
  expect(f.writes).toEqual(['mounted', 'unmounting', 'closed']);
  expect(f.unmount).toHaveBeenCalledOnce();
  expect(f.unmount.mock.calls[0][0]).toEqual(f.mount);
  expect(result).toEqual({
    contract: 'cos-backup-nas-recover-unmount-result/v1',
    status: 'closed',
    configurationDigest: digest(f.vault),
    nasDigest: digest(f.nas),
    artifactDigest: f.vault.artifact.digest,
    scopeDigest: digest(f.request.scope),
  });
  expect(
    f.checkAuthority.mock.calls.every(
      ([authority, scope, uid]) =>
        authority.token === f.request.authority.token && digest(scope) === digest(f.request.scope) && uid === 1000,
    ),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.nas.host);
  expect(JSON.stringify(result)).not.toContain(f.request.authority.token);
});
it.each(['closed', 'mounted', 'unmounting'] as const)(
  'reconciles %s only under a fresh recovery permission',
  async (phase) => {
    const f = fixture(phase);
    expect((await f.invoke()).status).toBe('closed');
    expect(f.checkAuthority).toHaveBeenCalled();
    expect(f.unmount).toHaveBeenCalledTimes(phase === 'closed' ? 0 : 1);
  },
);
it.each([
  'setup-permission',
  'vault-permission',
  'different-nas',
  'changed-source',
  'root-selector',
  'memory',
  'artifact',
  'revoked-owner',
  'service-busy',
])('refuses initial %s before any unmount or journal write', async (reason) => {
  const f = fixture();
  if (reason === 'setup-permission')
    f.request.scope = backupNasSetupScope(f.vault, f.nas, f.request.scope.operationId, 4);
  if (reason === 'vault-permission')
    f.request.scope = { ...f.request.scope, targetDigest: f.vault.identity.targetDigest };
  if (reason === 'different-nas') f.request.nas = { ...f.nas, host: '192.168.56.13' };
  if (reason === 'changed-source') f.request.configurationDigest = '0'.repeat(64);
  if (reason === 'root-selector') (f.request as unknown as Record<string, unknown>).root = '/tmp/foreign';
  if (reason === 'memory')
    f.memory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'artifact') f.loseArtifact();
  if (reason === 'revoked-owner') f.checkAuthority.mockRejectedValue(Error('PRIVATE_OWNER_REVOKED'));
  if (reason === 'service-busy')
    f.assertServiceIdle.mockImplementation(() => {
      throw Error('PRIVATE_SERVICE_BUSY');
    });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_recovery_unavailable$/);
  expect(f.unmount).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});
it('leaves a busy unmount intent for a fresh retry rather than acknowledging or forgetting the effect', async () => {
  const f = fixture(),
    original = f.unmount.getMockImplementation()!;
  f.unmount.mockRejectedValueOnce(Error('PRIVATE_MOUNT_BUSY'));
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_recovery_unavailable$/);
  expect(f.journal().phase).toBe('unmounting');
  expect(f.actual().state).toBe('mounted');
  f.request.scope = backupNasRecoveryScope(f.vault, f.nas, randomUUID(), 5);
  f.unmount.mockImplementation(original);
  expect((await f.invoke()).status).toBe('closed');
  expect(f.writes).toEqual(['mounted', 'unmounting', 'closed']);
});
it('refuses an unclaimed or changed mount even with valid native maintenance', async () => {
  const f = fixture('closed');
  f.setActual({ state: 'mounted', mount: f.mount });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_recovery_unavailable$/);
  expect(f.unmount).not.toHaveBeenCalled();
  const changed = fixture('mounted');
  changed.setActual({ state: 'mounted', mount: { ...changed.mount, id: 56 } });
  await expect(changed.invoke()).rejects.toThrow(/^backup_nas_root_recovery_unavailable$/);
  expect(changed.unmount).not.toHaveBeenCalled();
});
it.each(['nas-configuration', 'vault-configuration', 'artifact', 'owner', 'manager'])(
  'denies changes to %s across unmount and retains uncertain journal intent',
  async (reason) => {
    const f = fixture(),
      original = f.unmount.getMockImplementation()!;
    f.unmount.mockImplementation(async (...args) => {
      await original(...args);
      if (reason === 'nas-configuration') f.readNasConfiguration.mockReturnValue({ ...f.nas, host: '192.168.56.13' });
      if (reason === 'vault-configuration')
        f.readConfiguration.mockReturnValue({ ...f.vault, artifact: { ...f.vault.artifact, digest: '9'.repeat(64) } });
      if (reason === 'artifact') f.loseArtifact();
      if (reason === 'owner') f.checkAuthority.mockRejectedValue(Error('PRIVATE_REVOKED'));
      if (reason === 'manager')
        f.assertServiceIdle.mockImplementation(() => {
          throw Error('PRIVATE_MANAGER_CHANGED');
        });
    });
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_recovery_unavailable$/);
    expect(f.journal().phase).toBe('unmounting');
    expect(f.actual().state).toBe('closed');
  },
);
it('denies changed source during final journal cleanup after the physical connection has closed', async () => {
  const f = fixture(),
    original = f.withJournal.getMockImplementation()!;
  f.withJournal.mockImplementation(async (...args) => {
    const result = await original(...args);
    f.readConfiguration.mockReturnValue({ ...f.vault, artifact: { ...f.vault.artifact, digest: '9'.repeat(64) } });
    return result;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_recovery_unavailable$/);
  expect(f.journal().phase).toBe('closed');
});
it('denies the real wall-clock deadline before any effect despite a returned permission response', async () => {
  const f = fixture(),
    start = Date.now(),
    time = vi.spyOn(Date, 'now').mockReturnValue(start);
  try {
    f.checkAuthority.mockImplementation(async () => {
      time.mockReturnValue(start + 30000);
    });
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_recovery_unavailable$/);
    expect(f.unmount).not.toHaveBeenCalled();
  } finally {
    time.mockRestore();
  }
});
