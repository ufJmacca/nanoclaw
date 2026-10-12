import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
const f = vi.hoisted(() => ({
  vault: vi.fn(),
  access: vi.fn(),
  memory: vi.fn(),
  target: vi.fn(),
  binary: vi.fn(),
  share: vi.fn(),
  password: vi.fn(),
  capacity: vi.fn(),
  initializer: vi.fn(),
  create: vi.fn(),
  identify: vi.fn(),
}));
vi.mock('./vault-storage.js', () => ({ verifyVaultStorage: f.vault, withVaultDirectory: f.access }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./target-identity.js', () => ({ localTarget: f.target }));
vi.mock('./restic-artifact.js', async (original) => ({
  ...(await original<typeof import('./restic-artifact.js')>()),
  withVerifiedResticBinary: f.binary,
}));
vi.mock('./backup-password.js', () => ({ withVaultResticPassword: f.password }));
vi.mock('./backup-capacity.js', () => ({ readBackupCapacity: f.capacity }));
vi.mock('./backup-restic-initialize.js', () => ({ BackupResticInitializer: f.initializer }));
vi.mock('./backup-nas-access.js', () => ({
  withSignedBackupShare: f.share,
  withPinnedBackupRepository: async <T>(
    share: { fd: number; assertCurrent(): void },
    work: (scope: { fd: number; assertCurrent(): void }) => Promise<T>,
  ) => {
    share.assertCurrent();
    const name = '/proc/self/fd/' + share.fd + '/restic',
      fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW),
      before = fs.fstatSync(fd);
    try {
      return await work({
        fd,
        assertCurrent() {
          share.assertCurrent();
          const stat = fs.lstatSync(name);
          if (stat.ino !== before.ino || stat.dev !== before.dev) throw Error('FIXTURE_REPOSITORY_CHANGED');
        },
      });
    } finally {
      fs.closeSync(fd);
    }
  },
}));
import { initializeVaultBackups } from './backup-initialize.js';
const temporary: string[] = [],
  held: number[] = [];
afterEach(() => {
  for (const fd of held.splice(0)) fs.closeSync(fd);
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.resetAllMocks();
});
function fixture() {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.cos-init-composition-'));
  temporary.push(base);
  fs.chmodSync(base, 0o700);
  const roots = { targetRoot: base + '/state', installationRoot: base + '/install', dataRoot: base + '/data' },
    manifest = fixtureVaultRelease('G02');
  const areas = { 'backup-credentials': base + '/credentials', cache: base + '/cache' },
    sharePath = base + '/share';
  for (const folder of [...Object.values(roots), ...Object.values(areas), sharePath])
    fs.mkdirSync(folder, { mode: 0o700 });
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: roots.installationRoot,
    dataRoot: roots.dataRoot,
  };
  const filesystemUuid = randomUUID(),
    reference = randomUUID(),
    vault = vaultRootConfiguration({
      contract: 'cos-vault-root-config/v2',
      authority: { operationId: randomUUID() },
      identity: {
        operationId: randomUUID(),
        targetDigest: digest(binding),
        recoveryReference: randomUUID(),
        luksUuid: randomUUID(),
        filesystemUuid,
      },
      target: { binding, lifecycle: 'protected', minimumGeneration: 2 },
      owner: { uid: process.getuid!(), gid: process.getgid!(), home: os.homedir(), targetRoot: roots.targetRoot },
      artifact: {
        sourceCommit: manifest.source.commit,
        sourceTree: manifest.source.tree,
        digest: manifest.vaultArtifact!.digest,
      },
    });
  fs.writeFileSync(roots.targetRoot + '/vault-owner.json', JSON.stringify(vault), { mode: 0o600 });
  const selection = {
    contract: 'cos-backup-nas-selection/v1',
    targetDigest: digest(binding),
    nas: {
      contract: 'cos-backup-nas-root-config/v1',
      host: '192.168.56.12',
      credentialReference: reference,
      vaultStateDigest: vaultRootStateDigest(vault),
    },
  };
  const selectionFile = roots.targetRoot + '/backup-nas-selection.json';
  fs.writeFileSync(selectionFile, JSON.stringify(selection), { mode: 0o600 });
  const installation = {
    contract: 'cos-backup-credential-installation/v1',
    rootsDigest: digest(roots),
    filesystemUuid,
    operationId: randomUUID(),
    credentialReference: reference,
    phase: 'ready',
  };
  const installationFile = areas['backup-credentials'] + '/backup-credential-installation.json';
  fs.writeFileSync(installationFile, JSON.stringify(installation), { mode: 0o600 });
  const passwordFile = areas['backup-credentials'] + '/restic-password';
  fs.writeFileSync(passwordFile, 'SYNTHETIC_FIXTURE_PASSWORD_NO_LIVE_AUTHORITY', { mode: 0o600 });
  const passwordFd = fs.openSync(passwordFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
    shareFd = fs.openSync(sharePath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  held.push(passwordFd, shareFd);
  const proof = { fd: passwordFd, assertCurrent: vi.fn() },
    share = { fd: shareFd, assertCurrent: vi.fn() },
    assertVault = vi.fn();
  f.vault.mockReturnValue({ targetDigest: digest(roots.targetRoot), volume: { filesystemUuid } });
  f.target.mockReturnValue({
    version: 1,
    lifecycle: 'protected',
    releaseId: manifest.releaseId,
    generation: 3,
    maintenance: false,
    binding,
  });
  f.access.mockImplementation(async (_roots, area, work) => {
    assertVault();
    const result = await work(areas[area as keyof typeof areas], assertVault);
    assertVault();
    return result;
  });
  f.binary.mockImplementation(async (_path, work) => work(proof));
  f.share.mockImplementation(async (_mount, work) => work(share));
  f.password.mockImplementation(async (_roots, work) => work(proof));
  f.capacity.mockResolvedValue({
    staging: 4096,
    cache: 4096,
    credentials: 4096,
    repository: 4096,
    nasFree: 2 ** 42,
    vaultFree: 1024 ** 3,
  });
  f.create.mockImplementation(async () => {
    fs.writeFileSync(sharePath + '/restic/config', 'synthetic config', { mode: 0o600 });
  });
  f.identify.mockResolvedValue('e'.repeat(64));
  f.initializer.mockImplementation(function (scopes, check) {
    return {
      create: async () => {
        scopes.writer.assertCurrent();
        scopes.cache.assertCurrent();
        await check();
        await f.create();
        await check();
      },
      identify: async () => {
        await check();
        return f.identify();
      },
    };
  });
  return {
    input: { roots, manifest, operationId: randomUUID(), assertCurrent: vi.fn(), check: vi.fn(async () => {}) },
    roots,
    areas,
    sharePath,
    selection,
    selectionFile,
    installation,
    installationFile,
    assertVault,
  };
}
it('the default composition holds owner metadata, credentials, capacity and writer checks before binding the repository', async () => {
  const s = fixture(),
    result = await initializeVaultBackups(s.input);
  expect(result.status).toBe('backup_repository_initialized');
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.share.mock.calls[0]?.[0]).toEqual({
    host: s.selection.nas.host,
    share: 'nanoclaw-cos-backups',
    mount: '/var/lib/nanoclaw-cos/nas',
  });
  expect(f.password).toHaveBeenCalledOnce();
  expect(f.capacity).toHaveBeenCalled();
  expect(s.assertVault).toHaveBeenCalled();
  expect(
    JSON.parse(fs.readFileSync(s.areas['backup-credentials'] + '/backup-repository.json', 'utf8')).repositoryId,
  ).toBe(result.repositoryId);
});
it('an unsigned or unavailable share is refused before accessing the backup password', async () => {
  const s = fixture();
  f.share.mockRejectedValue(Error('FIXTURE_UNSIGNED_SHARE'));
  await expect(initializeVaultBackups(s.input)).rejects.toThrow('backup_repository_initialization_unavailable');
  expect(f.password).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect(fs.readdirSync(s.sharePath)).toEqual([]);
});
it.each([
  'nas-floor',
  'vault-reserve',
  'credential-reference',
  'selection-mode',
  'selection-link',
  'owner-source',
] as const)('refuses %s before creating remote files', async (reason) => {
  const s = fixture();
  if (reason === 'nas-floor') f.capacity.mockResolvedValue({ ...(await f.capacity()), nasFree: 1024 ** 4 });
  if (reason === 'vault-reserve') f.capacity.mockResolvedValue({ ...(await f.capacity()), vaultFree: 4096 });
  if (reason === 'credential-reference')
    fs.writeFileSync(s.installationFile, JSON.stringify({ ...s.installation, credentialReference: randomUUID() }));
  if (reason === 'selection-mode') fs.chmodSync(s.selectionFile, 0o644);
  if (reason === 'selection-link') fs.linkSync(s.selectionFile, s.roots.targetRoot + '/foreign-selection');
  if (reason === 'owner-source')
    fs.writeFileSync(
      s.roots.targetRoot + '/vault-owner.json',
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(s.roots.targetRoot + '/vault-owner.json', 'utf8')),
        artifact: { sourceCommit: 'f'.repeat(40), sourceTree: 'f'.repeat(40), digest: 'f'.repeat(64) },
      }),
    );
  await expect(initializeVaultBackups(s.input)).rejects.toThrow('backup_repository_initialization_unavailable');
  expect(f.create).not.toHaveBeenCalled();
  expect(fs.readdirSync(s.sharePath)).toEqual([]);
});
it('changed owner selection during an awaited capacity check cannot publish a journal or repository', async () => {
  const s = fixture();
  f.capacity.mockImplementation(async () => {
    fs.renameSync(s.selectionFile, s.selectionFile + '.old');
    fs.writeFileSync(s.selectionFile, JSON.stringify(s.selection), { mode: 0o600 });
    return { staging: 4096, cache: 4096, credentials: 4096, repository: 4096, nasFree: 2 ** 42, vaultFree: 1024 ** 3 };
  });
  await expect(initializeVaultBackups(s.input)).rejects.toThrow('backup_repository_initialization_unavailable');
  expect(f.create).not.toHaveBeenCalled();
  expect(fs.readdirSync(s.sharePath)).toEqual([]);
});
