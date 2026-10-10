import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasInitializationRecoveryScope } from './backup-nas-initialization-recovery-wire.js';
import {
  runBackupNasRootInitializationRecovery,
  verifyBackupNasInitializationServiceIdle,
  type BackupNasRootInitializationRecoveryControls,
} from './backup-nas-root-initialization-recovery.js';
afterEach(() => vi.restoreAllMocks());
function manager(loaded = false, changes: Record<string, string> = {}) {
  return Object.entries({
    Id: 'nanoclaw-cos-backup-mount.service',
    LoadState: loaded ? 'loaded' : 'not-found',
    ActiveState: 'inactive',
    SubState: 'dead',
    MainPID: '0',
    Job: '',
    UnitFileState: loaded ? 'static' : '',
    FragmentPath: loaded ? '/etc/systemd/system/nanoclaw-cos-backup-mount.service' : '',
    DropInPaths: '',
    NeedDaemonReload: 'no',
    ...changes,
  })
    .map(([key, value]) => key + '=' + value + '\n')
    .join('');
}
it.each([
  manager(),
  manager(false, { UnitFileState: 'not-found', Job: '0' }),
  manager(true),
  manager(true, { ActiveState: 'failed', SubState: 'failed' }),
])('admits only idle loaded or absent fixed services', (output) =>
  expect(() => verifyBackupNasInitializationServiceIdle(output)).not.toThrow(),
);
it.each([
  manager(false, { Id: 'foreign.service' }),
  manager(false, { ActiveState: 'active' }),
  manager(false, { SubState: 'start' }),
  manager(false, { MainPID: '7' }),
  manager(false, { Job: '14' }),
  manager(false, { UnitFileState: 'enabled' }),
  manager(false, { FragmentPath: '/tmp/unit' }),
  manager(false, { DropInPaths: '/tmp/dropin' }),
  manager(false, { NeedDaemonReload: 'yes' }),
  manager(false, { LoadState: 'error' }),
  manager(true, { MainPID: '7' }),
  manager(true, { FragmentPath: '/tmp/unit' }),
  manager() + 'Job=14\n',
  manager() + 'Extra=yes\n',
  manager().trimEnd(),
  'x'.repeat(4097),
  undefined,
])('refuses uncertain or foreign initialization manager observations', (output) => {
  expect(() => verifyBackupNasInitializationServiceIdle(output)).toThrow(
    /^backup_nas_initialization_service_unavailable$/,
  );
});
function fixture() {
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
  const resource = { kind: 'closed-underlay' as const, device: 17, inode: 23 };
  const receipt = {
    contract: 'cos-backup-nas-initialization-retirement-result/v1' as const,
    status: 'retired' as const,
    nasDigest: digest(nas),
    vaultStateDigest: vaultRootStateDigest(vault),
    resourceDigest: digest(resource),
  };
  const request = {
    contract: 'cos-backup-nas-recover-initialization-request/v1' as const,
    configurationDigest: digest(vault),
    nas,
    resource,
    scope: backupNasInitializationRecoveryScope(vault, nas, resource, randomUUID(), 4),
    authority: { socket: '/home/fixture/s/proof.sock', token: 'f'.repeat(64) },
  };
  let held = false,
    valid = true;
  const readConfiguration = vi.fn(() => vault),
    memory = vi.fn();
  const artifact = {
    assertCurrent() {
      expect(held).toBe(true);
      if (!valid) throw Error('PRIVATE_CODE_CHANGED');
    },
  };
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
  const readRequest = vi.fn(async () => request),
    checkAuthority = vi.fn<NonNullable<BackupNasRootInitializationRecoveryControls['checkAuthority']>>(async () => {
      expect(held).toBe(true);
    });
  const retireResource = vi.fn<NonNullable<BackupNasRootInitializationRecoveryControls['retireResource']>>(
    async (_vault, _nas, _resource, controls) => {
      expect(held).toBe(true);
      await controls.assertAuthority();
      return receipt;
    },
  );
  const controls = {
    assertMemory: memory,
    readConfiguration,
    assertServiceIdle: vi.fn(),
    withArtifact,
    readRequest,
    checkAuthority,
    retireResource,
  };
  const stream = Readable.from([]),
    invoke = () =>
      runBackupNasRootInitializationRecovery(stream, controls as BackupNasRootInitializationRecoveryControls);
  return {
    vault,
    nas,
    request,
    resource,
    receipt,
    controls,
    stream,
    invoke,
    readRequest,
    readConfiguration,
    checkAuthority,
    retireResource,
    withArtifact,
    loseArtifact() {
      valid = false;
    },
  };
}
it('recovers only the exact resource under held root code, idle manager and repeated resource-specific permission', async () => {
  const f = fixture(),
    result = await f.invoke();
  expect(process.getuid?.()).toBe(0);
  expect(result).toEqual({
    contract: 'cos-backup-nas-initialization-recovery-result/v1',
    status: 'retired',
    configurationDigest: digest(f.vault),
    nasDigest: digest(f.nas),
    artifactDigest: f.vault.artifact.digest,
    scopeDigest: digest(f.request.scope),
    vaultStateDigest: vaultRootStateDigest(f.vault),
    resourceDigest: digest(f.resource),
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(f.controls.assertServiceIdle.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(f.checkAuthority.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(
    f.checkAuthority.mock.calls.every(
      ([authority, scope, uid]) =>
        authority.token === f.request.authority.token && digest(scope) === digest(f.request.scope) && uid === 1000,
    ),
  ).toBe(true);
  expect(f.stream.destroyed).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.request.authority.token);
});
it.each(['memory', 'artifact', 'request', 'permission', 'manager'])(
  'denies %s before any resource inspection',
  async (reason) => {
    const f = fixture();
    if (reason === 'manager')
      f.controls.assertServiceIdle.mockImplementation(() => {
        throw Error('PRIVATE_MANAGER');
      });
    if (reason === 'memory')
      f.controls.assertMemory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    if (reason === 'artifact') f.loseArtifact();
    if (reason === 'request') f.readRequest.mockResolvedValue({ ...f.request, configurationDigest: '0'.repeat(64) });
    if (reason === 'permission') f.checkAuthority.mockRejectedValue(Error('PRIVATE_OWNER'));
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_initialization_recovery_unavailable$/);
    expect(f.retireResource).not.toHaveBeenCalled();
    expect(f.stream.destroyed).toBe(true);
  },
);
it.each(['resource-await', 'artifact-closure'])('refuses changed configuration during %s', async (reason) => {
  const f = fixture(),
    change = () =>
      f.readConfiguration.mockReturnValue(
        vaultRootConfiguration({ ...f.vault, authority: { operationId: randomUUID() } }),
      );
  if (reason === 'resource-await')
    f.retireResource.mockImplementation(async () => {
      change();
      return f.receipt;
    });
  else {
    const original = f.withArtifact.getMockImplementation()!;
    f.withArtifact.mockImplementation(async (...args) => {
      const result = await original(...args);
      change();
      return result;
    });
  }
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_initialization_recovery_unavailable$/);
});
it('refuses permission lost inside the held inspector', async () => {
  const f = fixture();
  f.retireResource.mockImplementation(async (_v, _n, _resource, controls) => {
    f.checkAuthority.mockRejectedValue(Error('PRIVATE_REVOKED'));
    await controls.assertAuthority();
    return f.receipt;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_initialization_recovery_unavailable$/);
});
it('refuses held code changed during inspection', async () => {
  const f = fixture();
  f.retireResource.mockImplementation(async () => {
    f.loseArtifact();
    return f.receipt;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_initialization_recovery_unavailable$/);
});
it.each(['status', 'scope', 'resource', 'extra'])('refuses malformed retirement receipt %s', async (reason) => {
  const f = fixture();
  const value =
    reason === 'status'
      ? { ...f.receipt, status: 'pending' }
      : reason === 'scope'
        ? { ...f.receipt, nasDigest: '0'.repeat(64) }
        : reason === 'resource'
          ? { ...f.receipt, resourceDigest: '0'.repeat(64) }
          : { ...f.receipt, path: '/tmp' };
  f.retireResource.mockResolvedValue(value as never);
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_initialization_recovery_unavailable$/);
});
it('denies setup permission substituted for the resource-specific purpose before retirement', async () => {
  const f = fixture();
  f.readRequest.mockResolvedValue({
    ...f.request,
    scope: { ...f.request.scope, targetDigest: f.vault.identity.targetDigest },
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_initialization_recovery_unavailable$/);
  expect(f.retireResource).not.toHaveBeenCalled();
});
it('denies manager state changed during the retirement boundary', async () => {
  const f = fixture();
  f.retireResource.mockImplementation(async () => {
    f.controls.assertServiceIdle.mockImplementation(() => {
      throw Error('PRIVATE_JOB');
    });
    return f.receipt;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_initialization_recovery_unavailable$/);
});
it('refuses inspection completion at the actual wall-clock deadline', async () => {
  const f = fixture(),
    start = Date.now(),
    time = vi.spyOn(Date, 'now').mockReturnValue(start);
  f.retireResource.mockImplementation(async () => {
    time.mockReturnValue(start + 30000);
    return f.receipt;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_initialization_recovery_unavailable$/);
});
