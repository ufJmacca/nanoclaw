import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import {
  inspectBackupNasInitialization,
  type BackupNasInitializationInspectionControls,
} from './backup-nas-initialization-inspection.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(kind: 'configuration-stage' | 'closed-underlay' | 'service-stage' = 'closed-underlay') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-inspect-'));
  roots.push(root);
  const paths = {
    configRoot: root + '/config',
    controlRoot: root + '/config/control',
    storageRoot: root + '/storage',
    mount: root + '/storage/nas',
    systemUnits: root + '/units',
  };
  for (const [name, mode] of [
    ['configRoot', 0o700],
    ['controlRoot', 0o700],
    ['storageRoot', 0o711],
    ['systemUnits', 0o755],
  ] as const)
    fs.mkdirSync(paths[name], { mode });
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
  const resource =
    kind === 'closed-underlay'
      ? { kind, device: 17, inode: 23 }
      : { kind, device: 17, inode: 23, stageId: randomUUID(), contentDigest: 'f'.repeat(64) };
  if (kind === 'configuration-stage')
    fs.writeFileSync(paths.configRoot + '/.backup-nas.' + randomUUID() + '.tmp', 'FIXTURE', { mode: 0o600 });
  if (kind === 'service-stage') {
    fs.writeFileSync(paths.controlRoot + '/nas-mount.json', 'CLAIM_FIXTURE', { mode: 0o600 });
    fs.writeFileSync(paths.systemUnits + '/.nanoclaw-cos-backup-mount.' + randomUUID() + '.tmp', 'FIXTURE', {
      mode: 0o644,
    });
  }
  const observe = async (
    _vault: typeof vault,
    _nas: Parameters<NonNullable<BackupNasInitializationInspectionControls['underlay']>>[1],
    controls: Pick<BackupNasInitializationInspectionControls, 'assertAuthority'>,
  ) => {
    await controls.assertAuthority();
    return resource;
  };
  const configurationStage =
      vi.fn<NonNullable<BackupNasInitializationInspectionControls['configurationStage']>>(observe),
    underlay = vi.fn<NonNullable<BackupNasInitializationInspectionControls['underlay']>>(observe),
    serviceStage = vi.fn<NonNullable<BackupNasInitializationInspectionControls['serviceStage']>>(observe);
  const controls = {
    paths,
    assertMemory: vi.fn(),
    assertAuthority: vi.fn(async () => {}),
    configurationStage,
    underlay,
    serviceStage,
  };
  const invoke = () => inspectBackupNasInitialization(vault, nas, controls);
  return { paths, vault, nas, resource, controls, configurationStage, underlay, serviceStage, invoke };
}
it.each(['configuration-stage', 'closed-underlay', 'service-stage'] as const)(
  'chooses only the fixed %s inspection without accepting an input resource selector',
  async (kind) => {
    const f = fixture(kind),
      result = await f.invoke();
    expect(result).toEqual(f.resource);
    expect(Object.isFrozen(result)).toBe(true);
    const selected =
      kind === 'configuration-stage' ? f.configurationStage : kind === 'closed-underlay' ? f.underlay : f.serviceStage;
    expect(selected).toHaveBeenCalledOnce();
    for (const fn of [f.configurationStage, f.underlay, f.serviceStage])
      if (fn !== selected) expect(fn).not.toHaveBeenCalled();
    expect(f.controls.assertAuthority.mock.calls.length).toBeGreaterThanOrEqual(2);
  },
);
it('inspects first-install configuration staging before an unclaimed underlay', async () => {
  const f = fixture('configuration-stage');
  fs.mkdirSync(f.paths.mount, { mode: 0 });
  await f.invoke();
  expect(f.configurationStage).toHaveBeenCalledOnce();
  expect(f.underlay).not.toHaveBeenCalled();
});
it('refuses a claimed namespace without any unclaimed resource', async () => {
  const f = fixture();
  fs.writeFileSync(f.paths.controlRoot + '/nas-mount.json', 'KEEP', { mode: 0o600 });
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_inspection_unavailable$/);
  expect(f.underlay).not.toHaveBeenCalled();
});
it.each(['memory', 'permission', 'parent-mode', 'parent-owner', 'control-path', 'bounds', 'wrong-resource-kind'])(
  'refuses %s before acknowledging any observation',
  async (reason) => {
    const f = fixture();
    if (reason === 'memory')
      f.controls.assertMemory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    if (reason === 'permission') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_NATIVE'));
    if (reason === 'parent-mode') fs.chmodSync(f.paths.configRoot, 0o755);
    if (reason === 'parent-owner') fs.chownSync(f.paths.systemUnits, 1000, 1000);
    if (reason === 'control-path') f.controls.paths.controlRoot = f.paths.storageRoot;
    if (reason === 'bounds')
      for (let i = 0; i < 129; i++) fs.writeFileSync(f.paths.configRoot + '/fixture-' + i, 'KEEP', { mode: 0o600 });
    if (reason === 'wrong-resource-kind')
      f.underlay.mockResolvedValue({
        kind: 'configuration-stage',
        stageId: randomUUID(),
        device: 17,
        inode: 23,
        contentDigest: 'f'.repeat(64),
      });
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_inspection_unavailable$/);
  },
);
it.each(['parent-inode', 'new-priority-stage', 'new-mount-claim'])(
  'refuses %s changed across the held child inspection',
  async (reason) => {
    const f = fixture();
    f.underlay.mockImplementation(async () => {
      if (reason === 'parent-inode') {
        fs.renameSync(f.paths.systemUnits, f.paths.systemUnits + '.old');
        fs.mkdirSync(f.paths.systemUnits, { mode: 0o755 });
      }
      if (reason === 'new-priority-stage')
        fs.writeFileSync(f.paths.configRoot + '/.backup-nas.' + randomUUID() + '.tmp', 'KEEP', { mode: 0o600 });
      if (reason === 'new-mount-claim')
        fs.writeFileSync(f.paths.controlRoot + '/nas-mount.json', 'KEEP', { mode: 0o600 });
      return f.resource;
    });
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_inspection_unavailable$/);
  },
);
