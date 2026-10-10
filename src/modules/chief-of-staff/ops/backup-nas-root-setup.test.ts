import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasMountService } from './backup-nas-units.js';
import { backupNasSetupScope, type BackupNasSetupRequest } from './backup-nas-setup-wire.js';
import { runBackupNasRootSetup, type BackupNasRootSetupControls } from './backup-nas-root-setup.js';
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
    },
    scope = backupNasSetupScope(vault, nas, randomUUID(), 4);
  const request: BackupNasSetupRequest = {
    contract: 'cos-backup-nas-setup-request/v1',
    configurationDigest: digest(vault),
    nas,
    scope,
    authority: { socket: '/home/fixture/state/vault-authority/' + randomUUID() + '/proof.sock', token: 'f'.repeat(64) },
  };
  const journal = {
    contract: 'cos-backup-nas-mount-state/v1' as const,
    configurationDigest: digest(nas),
    underlay: { device: 17, inode: 23 },
    phase: 'closed' as const,
    attemptId: null,
    mount: null,
  };
  const unitDigest = createHash('sha256')
      .update(backupNasMountService({ artifactDigest: vault.artifact.digest }).contents)
      .digest('hex'),
    events: string[] = [];
  let held = false,
    valid = true;
  const memory = vi.fn(),
    readConfiguration = vi.fn(() => vault),
    readRequest = vi.fn(async () => request),
    checkAuthority = vi.fn<NonNullable<BackupNasRootSetupControls['checkAuthority']>>(async () => {
      expect(held).toBe(true);
    });
  const artifact = {
    assertCurrent() {
      expect(held).toBe(true);
      if (!valid) throw Error('PRIVATE_ARTIFACT_CHANGED');
    },
  };
  const withArtifact = vi.fn(async (_vault, operation) => {
    events.push('artifact-enter');
    held = true;
    try {
      const result = await operation(artifact);
      artifact.assertCurrent();
      return result;
    } finally {
      events.push('artifact-exit');
      held = false;
    }
  });
  const installConfiguration = vi.fn(async (_vault, _nas, controls) => {
    events.push('configuration');
    await controls.assertAuthority();
    return nas;
  });
  const prepareUnderlay = vi.fn(async (_vault, _nas, controls) => {
    events.push('underlay');
    await controls.assertAuthority();
    return journal;
  });
  const installService = vi.fn(async (_vault, _nas, controls) => {
    events.push('service');
    await controls.assertAuthority();
    return {
      contract: 'cos-backup-nas-service-installation-result/v1',
      status: 'installed',
      configurationDigest: digest(nas),
      artifactDigest: vault.artifact.digest,
      unitDigest,
    };
  });
  const controls = {
    assertMemory: memory,
    readConfiguration,
    readRequest,
    checkAuthority,
    withArtifact,
    installConfiguration,
    prepareUnderlay,
    installService,
  } as BackupNasRootSetupControls;
  const invoke = () => runBackupNasRootSetup(Readable.from([]), controls);
  return {
    vault,
    nas,
    request,
    journal,
    scope,
    unitDigest,
    events,
    controls,
    memory,
    readConfiguration,
    readRequest,
    checkAuthority,
    withArtifact,
    installConfiguration,
    prepareUnderlay,
    installService,
    invoke,
    loseArtifact() {
      valid = false;
    },
  };
}
it('connects configuration, claimed closed underlay and on-demand service under one held artifact and fresh NAS-specific owner proof', async () => {
  const f = fixture(),
    result = await f.invoke();
  expect(process.getuid?.()).toBe(0);
  expect(f.events).toEqual(['artifact-enter', 'configuration', 'underlay', 'service', 'artifact-exit']);
  expect(
    f.checkAuthority.mock.calls.every(
      ([authority, scope, uid]) =>
        authority.socket === f.request.authority.socket &&
        authority.token === f.request.authority.token &&
        digest(scope) === digest(f.scope) &&
        uid === f.vault.owner.uid,
    ),
  ).toBe(true);
  expect(result).toEqual({
    contract: 'cos-backup-nas-setup-result/v1',
    status: 'configured',
    configurationDigest: digest(f.vault),
    nasDigest: digest(f.nas),
    artifactDigest: f.vault.artifact.digest,
    unitDigest: f.unitDigest,
    scopeDigest: digest(f.scope),
  });
  expect(JSON.stringify(result)).not.toContain(f.nas.host);
  expect(JSON.stringify(result)).not.toContain(f.request.authority.token);
});
it.each(['vault-only', 'nas', 'configuration', 'scope-extra', 'root-selector', 'memory', 'artifact', 'owner'])(
  'denies initial %s before any root configuration effect',
  async (reason) => {
    const f = fixture(),
      request = JSON.parse(JSON.stringify(f.request));
    if (reason === 'vault-only') request.scope.targetDigest = f.vault.identity.targetDigest;
    if (reason === 'nas') request.nas.credentialReference = randomUUID();
    if (reason === 'configuration') request.configurationDigest = '0'.repeat(64);
    if (reason === 'scope-extra') request.scope.proof = 'stored-proof';
    if (reason === 'root-selector') request.root = '/tmp/foreign';
    f.readRequest.mockResolvedValue(request);
    if (reason === 'memory')
      f.memory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    if (reason === 'artifact') f.loseArtifact();
    if (reason === 'owner') f.checkAuthority.mockRejectedValue(Error('PRIVATE_NATIVE_PROOF'));
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_setup_unavailable$/);
    expect(f.installConfiguration).not.toHaveBeenCalled();
    expect(f.prepareUnderlay).not.toHaveBeenCalled();
    expect(f.installService).not.toHaveBeenCalled();
  },
);
it.each(['configuration-await', 'underlay-await', 'service-await', 'artifact-cleanup'])(
  'denies changed installed configuration during %s without a success receipt',
  async (reason) => {
    const f = fixture(),
      changed = () =>
        f.readConfiguration.mockReturnValue(
          vaultRootConfiguration({ ...f.vault, artifact: { ...f.vault.artifact, digest: '9'.repeat(64) } }),
        );
    if (reason === 'configuration-await')
      f.installConfiguration.mockImplementation(async (_v, _n, controls) => {
        changed();
        await controls.assertAuthority();
        return f.nas;
      });
    if (reason === 'underlay-await')
      f.prepareUnderlay.mockImplementation(async (_v, _n, controls) => {
        changed();
        await controls.assertAuthority();
        return f.journal;
      });
    if (reason === 'service-await')
      f.installService.mockImplementation(async (_v, _n, controls) => {
        changed();
        await controls.assertAuthority();
        throw Error('unexpected_success');
      });
    if (reason === 'artifact-cleanup') {
      const original = f.withArtifact.getMockImplementation()!;
      f.withArtifact.mockImplementation(async (...args) => {
        const result = await original(...args);
        changed();
        return result;
      });
    }
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_setup_unavailable$/);
    if (reason === 'configuration-await') expect(f.prepareUnderlay).not.toHaveBeenCalled();
    if (reason === 'configuration-await' || reason === 'underlay-await')
      expect(f.installService).not.toHaveBeenCalled();
  },
);
it.each(['configuration', 'underlay', 'service'])(
  'rejects conflicting %s completion rather than acknowledging setup',
  async (reason) => {
    const f = fixture();
    if (reason === 'configuration') f.installConfiguration.mockResolvedValue({ ...f.nas, host: '192.168.56.13' });
    if (reason === 'underlay')
      f.prepareUnderlay.mockResolvedValue({ ...f.journal, configurationDigest: '0'.repeat(64) });
    if (reason === 'service')
      f.installService.mockResolvedValue({
        contract: 'cos-backup-nas-service-installation-result/v1',
        status: 'installed',
        configurationDigest: digest(f.nas),
        artifactDigest: f.vault.artifact.digest,
        unitDigest: '0'.repeat(64),
      });
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_setup_unavailable$/);
    if (reason === 'configuration') expect(f.prepareUnderlay).not.toHaveBeenCalled();
    if (reason !== 'service') expect(f.installService).not.toHaveBeenCalled();
  },
);
it('denies stale native authority between separate installer phases', async () => {
  const f = fixture();
  f.installConfiguration.mockImplementation(async () => {
    f.checkAuthority.mockRejectedValue(Error('PRIVATE_REVOKED_NATIVE'));
    return f.nas;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_setup_unavailable$/);
  expect(f.prepareUnderlay).not.toHaveBeenCalled();
});
it('denies setup after its real wall-clock deadline even when the native response returns', async () => {
  const f = fixture(),
    originalNow = Date.now,
    start = originalNow();
  const time = vi.spyOn(Date, 'now').mockReturnValue(start);
  try {
    f.checkAuthority.mockImplementation(async () => {
      time.mockReturnValue(start + 60000);
    });
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_setup_unavailable$/);
    expect(f.installConfiguration).not.toHaveBeenCalled();
  } finally {
    time.mockRestore();
  }
});
