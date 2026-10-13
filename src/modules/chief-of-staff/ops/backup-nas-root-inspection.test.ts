import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasSetupScope } from './backup-nas-setup-wire.js';
import {
  runBackupNasRootInitializationInspection,
  type BackupNasRootInspectionControls,
} from './backup-nas-root-inspection.js';
afterEach(() => vi.restoreAllMocks());
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
  const request = {
    contract: 'cos-backup-nas-setup-request/v1' as const,
    configurationDigest: digest(vault),
    nas,
    scope: backupNasSetupScope(vault, nas, randomUUID(), 4),
    authority: { socket: '/home/fixture/s/proof.sock', token: 'f'.repeat(64) },
  };
  const resource = { kind: 'closed-underlay' as const, device: 17, inode: 23 };
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
    checkAuthority = vi.fn<NonNullable<BackupNasRootInspectionControls['checkAuthority']>>(async () => {
      expect(held).toBe(true);
    });
  const inspectResource = vi.fn<NonNullable<BackupNasRootInspectionControls['inspectResource']>>(
    async (_vault, _nas, controls) => {
      expect(held).toBe(true);
      await controls.assertAuthority();
      return resource;
    },
  );
  const controls = {
    assertMemory: memory,
    readConfiguration,
    withArtifact,
    readRequest,
    checkAuthority,
    inspectResource,
  };
  const stream = Readable.from([]),
    invoke = () => runBackupNasRootInitializationInspection(stream, controls as BackupNasRootInspectionControls);
  return {
    vault,
    nas,
    request,
    resource,
    controls,
    stream,
    invoke,
    readRequest,
    readConfiguration,
    checkAuthority,
    inspectResource,
    withArtifact,
    loseArtifact() {
      valid = false;
    },
  };
}
it('inspects the exact unclaimed underlay under held root code and repeated current setup permission, without returning a cleanup grant', async () => {
  const f = fixture(),
    result = await f.invoke();
  expect(process.getuid?.()).toBe(0);
  expect(result).toEqual({
    contract: 'cos-backup-nas-initialization-inspection-result/v1',
    status: 'observed',
    configurationDigest: digest(f.vault),
    nasDigest: digest(f.nas),
    artifactDigest: f.vault.artifact.digest,
    scopeDigest: digest(f.request.scope),
    resource: f.resource,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.resource)).toBe(true);
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
it.each(['memory', 'artifact', 'request', 'permission'])('denies %s before any resource inspection', async (reason) => {
  const f = fixture();
  if (reason === 'memory')
    f.controls.assertMemory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'artifact') f.loseArtifact();
  if (reason === 'request') f.readRequest.mockResolvedValue({ ...f.request, configurationDigest: '0'.repeat(64) });
  if (reason === 'permission') f.checkAuthority.mockRejectedValue(Error('PRIVATE_OWNER'));
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_inspection_unavailable$/);
  expect(f.inspectResource).not.toHaveBeenCalled();
  expect(f.stream.destroyed).toBe(true);
});
it.each(['resource-await', 'artifact-closure'])('refuses changed configuration during %s', async (reason) => {
  const f = fixture(),
    change = () =>
      f.readConfiguration.mockReturnValue(
        vaultRootConfiguration({ ...f.vault, authority: { operationId: randomUUID() } }),
      );
  if (reason === 'resource-await')
    f.inspectResource.mockImplementation(async () => {
      change();
      return f.resource;
    });
  else {
    const original = f.withArtifact.getMockImplementation()!;
    f.withArtifact.mockImplementation(async (...args) => {
      const result = await original(...args);
      change();
      return result;
    });
  }
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_inspection_unavailable$/);
});
it('refuses permission lost inside the held inspector', async () => {
  const f = fixture();
  f.inspectResource.mockImplementation(async (_v, _n, controls) => {
    f.checkAuthority.mockRejectedValue(Error('PRIVATE_REVOKED'));
    await controls.assertAuthority();
    return f.resource;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_inspection_unavailable$/);
});
it('refuses held code changed during inspection', async () => {
  const f = fixture();
  f.inspectResource.mockImplementation(async () => {
    f.loseArtifact();
    return f.resource;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_inspection_unavailable$/);
});
it.each([
  { kind: 'closed-underlay', device: 17, inode: 0 },
  { kind: 'closed-underlay', device: 17, inode: 23, path: '/tmp' },
  { kind: 'service-stage', device: 17, inode: 23 },
])('refuses malformed observation $kind', async (resource) => {
  const f = fixture();
  f.inspectResource.mockResolvedValue(resource as never);
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_inspection_unavailable$/);
});
it('refuses inspection completion at the actual wall-clock deadline', async () => {
  const f = fixture(),
    start = Date.now(),
    time = vi.spyOn(Date, 'now').mockReturnValue(start);
  f.inspectResource.mockImplementation(async () => {
    time.mockReturnValue(start + 30000);
    return f.resource;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_root_inspection_unavailable$/);
});
