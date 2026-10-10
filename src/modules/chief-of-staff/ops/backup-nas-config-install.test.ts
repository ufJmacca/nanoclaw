import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { readBackupNasRootConfiguration } from './backup-nas-root-config.js';
import { installBackupNasRootConfiguration } from './backup-nas-config-install.js';
import { prepareBackupNasUnderlay } from './backup-nas-underlay.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-nas-config-install-'));
  roots.push(root);
  const configRoot = root + '/config',
    controlRoot = configRoot + '/control',
    storageRoot = root + '/storage';
  for (const [directory, mode] of [
    [configRoot, 0o700],
    [controlRoot, 0o700],
    [storageRoot, 0o711],
  ] as const)
    fs.mkdirSync(directory, { mode });
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
  const claim = (directory: string) => {
    const stat = fs.lstatSync(directory);
    return { device: stat.dev, inode: stat.ino };
  };
  const bootstrap = {
    contract: 'cos-vault-root-state/v1',
    identityDigest: vaultRootStateDigest(vault),
    phase: 'complete',
    claims: { control: claim(controlRoot), storage: claim(storageRoot) },
  };
  const bootstrapFile = configRoot + '/vault-bootstrap.json';
  fs.writeFileSync(bootstrapFile, JSON.stringify(bootstrap), { mode: 0o600 });
  const nas = {
    contract: 'cos-backup-nas-root-config/v1' as const,
    host: '192.168.56.12',
    credentialReference: randomUUID(),
    vaultStateDigest: vaultRootStateDigest(vault),
  };
  const controls = {
    paths: { configRoot, controlRoot, storageRoot },
    assertMemory: vi.fn(),
    assertAuthority: vi.fn(async () => {}),
  };
  return {
    root,
    vault,
    nas,
    bootstrap,
    bootstrapFile,
    controls,
    file: configRoot + '/backup-nas.json',
    journal: controlRoot + '/nas-config-install.json',
  };
}
const denied = /^backup_nas_configuration_installation_unavailable$/;
it('publishes durable private NAS metadata under the real root writer without changing accepted vault resources', async () => {
  const f = fixture(),
    before = fs.readFileSync(f.bootstrapFile);
  const key = f.controls.paths.configRoot + '/vault.key',
    volume = f.controls.paths.storageRoot + '/vault.luks';
  fs.writeFileSync(key, 'KEEP_KEY', { mode: 0o600 });
  fs.writeFileSync(volume, 'KEEP_VOLUME', { mode: 0o600 });
  const result = await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  expect(process.getuid?.()).toBe(0);
  expect(result).toEqual(f.nas);
  expect(fs.lstatSync(f.file).uid).toBe(0);
  expect(fs.lstatSync(f.file).mode & 0o7777).toBe(0o600);
  expect(fs.lstatSync(f.file).nlink).toBe(1);
  expect(
    readBackupNasRootConfiguration(f.vault, {
      root: f.controls.paths.configRoot,
      assertMemory: f.controls.assertMemory,
    }),
  ).toEqual(f.nas);
  expect(fs.readFileSync(f.bootstrapFile)).toEqual(before);
  expect(fs.readFileSync(key, 'utf8')).toBe('KEEP_KEY');
  expect(fs.readFileSync(volume, 'utf8')).toBe('KEEP_VOLUME');
  expect(JSON.parse(fs.readFileSync(f.journal, 'utf8'))).toMatchObject({
    phase: 'installed',
    stage: null,
    configurationDigest: digest(f.nas),
  });
  expect(fs.readdirSync(f.controls.paths.configRoot).some((name) => name.startsWith('.backup-nas.'))).toBe(false);
});
it('replays the claimed NAS configuration across a fresh source and maintenance generation without replacing it', async () => {
  const f = fixture();
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  const inode = fs.lstatSync(f.file).ino;
  const next = vaultRootConfiguration({
    ...f.vault,
    authority: { operationId: randomUUID() },
    target: { ...f.vault.target, minimumGeneration: 4 },
    artifact: { sourceCommit: '1'.repeat(40), sourceTree: '2'.repeat(40), digest: '3'.repeat(64) },
  });
  const sync = vi.spyOn(fs, 'fsyncSync');
  expect(await installBackupNasRootConfiguration(next, f.nas, f.controls)).toEqual(f.nas);
  expect(fs.lstatSync(f.file).ino).toBe(inode);
  expect(sync.mock.calls.length).toBeGreaterThanOrEqual(4);
});
it.each([
  'unclaimed',
  'directory',
  'symlink',
  'config-mode',
  'control-mode',
  'storage-mode',
  'bootstrap-missing',
  'bootstrap-mode',
  'bootstrap-hardlink',
  'bootstrap-identity',
  'bootstrap-claim',
  'bootstrap-phase',
  'authority',
  'memory',
])('refuses initial %s without overwriting it or creating NAS ownership', async (reason) => {
  const f = fixture();
  if (reason === 'unclaimed') fs.writeFileSync(f.file, JSON.stringify(f.nas), { mode: 0o600 });
  if (reason === 'directory') fs.mkdirSync(f.file);
  if (reason === 'symlink') fs.symlinkSync(f.bootstrapFile, f.file);
  if (reason === 'config-mode') fs.chmodSync(f.controls.paths.configRoot, 0o755);
  if (reason === 'control-mode') fs.chmodSync(f.controls.paths.controlRoot, 0o755);
  if (reason === 'storage-mode') fs.chmodSync(f.controls.paths.storageRoot, 0o700);
  if (reason === 'bootstrap-missing') fs.unlinkSync(f.bootstrapFile);
  if (reason === 'bootstrap-mode') fs.chmodSync(f.bootstrapFile, 0o644);
  if (reason === 'bootstrap-hardlink') fs.linkSync(f.bootstrapFile, f.bootstrapFile + '.link');
  if (reason === 'bootstrap-identity')
    fs.writeFileSync(f.bootstrapFile, JSON.stringify({ ...f.bootstrap, identityDigest: '0'.repeat(64) }));
  if (reason === 'bootstrap-claim')
    fs.writeFileSync(
      f.bootstrapFile,
      JSON.stringify({ ...f.bootstrap, claims: { ...f.bootstrap.claims, control: { device: 0, inode: 1 } } }),
    );
  if (reason === 'bootstrap-phase')
    fs.writeFileSync(f.bootstrapFile, JSON.stringify({ ...f.bootstrap, phase: 'intent' }));
  if (reason === 'authority') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
  if (reason === 'memory')
    f.controls.assertMemory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.journal)).toBe(false);
  if (reason === 'unclaimed') expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual(f.nas);
});
it.each([
  'missing',
  'inode',
  'mode',
  'hardlink',
  'bytes',
  'host',
  'reference',
  'journal-mode',
  'journal-hardlink',
  'journal-scope',
])('refuses a changed claimed %s instead of repairing or adopting it', async (reason) => {
  const f = fixture();
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  if (reason === 'missing') fs.unlinkSync(f.file);
  if (reason === 'inode') {
    fs.renameSync(f.file, f.file + '.old');
    fs.writeFileSync(f.file, JSON.stringify(f.nas), { mode: 0o600 });
  }
  if (reason === 'mode') fs.chmodSync(f.file, 0o644);
  if (reason === 'hardlink') fs.linkSync(f.file, f.file + '.link');
  if (reason === 'bytes') fs.writeFileSync(f.file, JSON.stringify({ ...f.nas, host: '192.168.56.13' }));
  if (reason === 'host') f.nas.host = '192.168.56.13';
  if (reason === 'reference') f.nas.credentialReference = randomUUID();
  if (reason === 'journal-mode') fs.chmodSync(f.journal, 0o644);
  if (reason === 'journal-hardlink') fs.linkSync(f.journal, f.journal + '.link');
  if (reason === 'journal-scope') {
    const value = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
    fs.writeFileSync(f.journal, JSON.stringify({ ...value, configurationDigest: '0'.repeat(64) }));
  }
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  if (reason === 'missing') expect(fs.existsSync(f.file)).toBe(false);
});
it('resumes a journaled publication only with fresh authority, then keeps its original inode', async () => {
  const f = fixture();
  f.controls.assertAuthority.mockImplementation(async () => {
    if (fs.existsSync(f.journal)) throw Error('PRIVATE_REVOKED');
  });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.file)).toBe(false);
  const record = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
  expect(record.phase).toBe('publishing');
  f.controls.assertAuthority.mockResolvedValue(undefined);
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(record.file.inode);
});
it('reconciles an interrupted published file with a fresh proof and repeats durability before acknowledgment', async () => {
  const f = fixture();
  f.controls.assertAuthority.mockImplementation(async () => {
    if (fs.existsSync(f.file)) throw Error('PRIVATE_REVOKED');
  });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  const inode = fs.lstatSync(f.file).ino;
  f.controls.assertAuthority.mockResolvedValue(undefined);
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(inode);
  expect(fs.lstatSync(f.file).nlink).toBe(1);
});
it('denies a replaced parent across a fresh-authority await without writing through the replacement', async () => {
  const f = fixture();
  f.controls.assertAuthority.mockImplementationOnce(async () => {
    fs.renameSync(f.controls.paths.controlRoot, f.controls.paths.controlRoot + '.old');
    fs.mkdirSync(f.controls.paths.controlRoot, { mode: 0o700 });
  });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.file)).toBe(false);
  expect(fs.existsSync(f.journal)).toBe(false);
});
it('does not accumulate more stages when an unclaimed stage remains from an interrupted initial intent', async () => {
  const f = fixture();
  f.controls.assertAuthority.mockImplementation(async () => {
    if (fs.readdirSync(f.controls.paths.configRoot).some((name) => name.startsWith('.backup-nas.')))
      throw Error('PRIVATE_REVOKED');
  });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  const names = fs.readdirSync(f.controls.paths.configRoot);
  expect(names.filter((name) => name.startsWith('.backup-nas.'))).toHaveLength(1);
  f.controls.assertAuthority.mockResolvedValue(undefined);
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.readdirSync(f.controls.paths.configRoot)).toEqual(names);
  expect(fs.existsSync(f.file)).toBe(false);
});
it('shares the real kernel writer with underlay preparation and never steals the competing lock', async () => {
  const f = fixture();
  let unblock!: () => void,
    entered!: () => void,
    waiting = false;
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.controls.assertAuthority.mockImplementation(async () => {
    if (!waiting && fs.existsSync(f.controls.paths.controlRoot + '/repository.lock')) {
      waiting = true;
      entered();
      await held;
    }
  });
  const pending = installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  try {
    await locked;
    await expect(
      prepareBackupNasUnderlay(f.vault, f.nas, {
        paths: { ...f.controls.paths, mount: f.controls.paths.storageRoot + '/nas' },
        assertMemory: f.controls.assertMemory,
        assertAuthority: async () => {},
        isMounted: () => false,
      }),
    ).rejects.toThrow(/^backup_nas_underlay_unavailable$/);
    expect(fs.existsSync(f.controls.paths.storageRoot + '/nas')).toBe(false);
    expect(fs.existsSync(f.file)).toBe(false);
  } finally {
    unblock();
    await pending;
  }
});
it('does not acknowledge a failed journal sync and repeats durability before replay publication', async () => {
  const f = fixture(),
    original = fs.fsyncSync;
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.existsSync(f.journal)) throw Error('PRIVATE_DURABILITY');
    return original(fd);
  });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.file)).toBe(false);
  const before = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
  sync.mockRestore();
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(before.file.inode);
});
