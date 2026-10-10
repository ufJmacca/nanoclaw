import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { prepareBackupNasUnderlay, inspectBackupNasUnclaimedUnderlay } from './backup-nas-underlay.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-nas-underlay-'));
  roots.push(root);
  const configRoot = path.join(root, 'config'),
    controlRoot = path.join(configRoot, 'control'),
    storageRoot = path.join(root, 'storage');
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
  const inode = (directory: string) => {
    const s = fs.lstatSync(directory);
    return { device: s.dev, inode: s.ino };
  };
  const bootstrap = {
    contract: 'cos-vault-root-state/v1',
    identityDigest: vaultRootStateDigest(vault),
    phase: 'complete',
    claims: { control: inode(controlRoot), storage: inode(storageRoot) },
  };
  const bootstrapFile = path.join(configRoot, 'vault-bootstrap.json');
  fs.writeFileSync(bootstrapFile, JSON.stringify(bootstrap), { mode: 0o600 });
  const nas = {
    contract: 'cos-backup-nas-root-config/v1' as const,
    host: '192.168.56.12',
    credentialReference: randomUUID(),
    vaultStateDigest: vaultRootStateDigest(vault),
  };
  const mount = path.join(storageRoot, 'nas'),
    journal = path.join(controlRoot, 'nas-mount.json');
  const controls = {
    paths: { configRoot, controlRoot, storageRoot, mount },
    assertMemory: vi.fn(),
    assertAuthority: vi.fn(async () => {}),
    isMounted: vi.fn(() => false),
  };
  return { root, vault, nas, bootstrap, bootstrapFile, controls, mount, journal };
}
it('observes the exact closed unclaimed underlay under the root writer without claiming or repairing it', async () => {
  const s = fixture();
  fs.mkdirSync(s.mount, { mode: 0 });
  const before = fs.lstatSync(s.mount),
    bootstrap = fs.readFileSync(s.bootstrapFile);
  const result = await inspectBackupNasUnclaimedUnderlay(s.vault, s.nas, s.controls);
  expect(result).toEqual({ kind: 'closed-underlay', device: before.dev, inode: before.ino });
  expect(Object.isFrozen(result)).toBe(true);
  expect(s.controls.assertAuthority.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(fs.existsSync(s.journal)).toBe(false);
  expect(fs.lstatSync(s.mount).ino).toBe(before.ino);
  expect(fs.lstatSync(s.mount).mode & 0o7777).toBe(0);
  expect(fs.readdirSync(s.mount)).toEqual([]);
  expect(fs.readFileSync(s.bootstrapFile)).toEqual(bootstrap);
  await expect(prepareBackupNasUnderlay(s.vault, s.nas, s.controls)).rejects.toThrow(
    /^backup_nas_underlay_unavailable$/,
  );
});
it.each(['missing', 'claimed', 'mode', 'payload', 'symlink', 'file', 'mounted', 'authority'])(
  'refuses to observe an ambiguous %s underlay without publishing a new claim',
  async (reason) => {
    const s = fixture();
    if (reason === 'claimed') await prepareBackupNasUnderlay(s.vault, s.nas, s.controls);
    else if (reason === 'symlink') fs.symlinkSync(s.controls.paths.configRoot, s.mount);
    else if (reason === 'file') fs.writeFileSync(s.mount, 'KEEP', { mode: 0o600 });
    else if (reason !== 'missing') fs.mkdirSync(s.mount, { mode: 0 });
    if (reason === 'mode') fs.chmodSync(s.mount, 0o700);
    if (reason === 'payload') fs.writeFileSync(s.mount + '/payload', 'KEEP');
    if (reason === 'mounted') s.controls.isMounted.mockReturnValue(true);
    if (reason === 'authority') s.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
    const before = fs.existsSync(s.journal) ? fs.readFileSync(s.journal) : null;
    await expect(inspectBackupNasUnclaimedUnderlay(s.vault, s.nas, s.controls)).rejects.toThrow(
      /^backup_nas_underlay_observation_unavailable$/,
    );
    expect(fs.existsSync(s.journal)).toBe(before !== null);
    if (before) expect(fs.readFileSync(s.journal)).toEqual(before);
    if (reason === 'payload') expect(fs.readFileSync(s.mount + '/payload', 'utf8')).toBe('KEEP');
    if (reason === 'file') expect(fs.readFileSync(s.mount, 'utf8')).toBe('KEEP');
  },
);
it.each(['inode', 'mode', 'payload', 'journal', 'bootstrap', 'revocation'])(
  'refuses a %s change across the fresh authority await with the observed directory held',
  async (reason) => {
    const s = fixture();
    fs.mkdirSync(s.mount, { mode: 0 });
    let checks = 0;
    s.controls.assertAuthority.mockImplementation(async () => {
      if (++checks !== 3) return;
      if (reason === 'inode') {
        fs.renameSync(s.mount, s.mount + '.original');
        fs.mkdirSync(s.mount, { mode: 0 });
      }
      if (reason === 'mode') fs.chmodSync(s.mount, 0o700);
      if (reason === 'payload') fs.writeFileSync(s.mount + '/payload', 'KEEP');
      if (reason === 'journal') fs.writeFileSync(s.journal, 'FOREIGN', { mode: 0o600 });
      if (reason === 'bootstrap')
        fs.writeFileSync(s.bootstrapFile, JSON.stringify({ ...s.bootstrap, phase: 'intent' }));
      if (reason === 'revocation') throw Error('PRIVATE_REVOKED');
    });
    await expect(inspectBackupNasUnclaimedUnderlay(s.vault, s.nas, s.controls)).rejects.toThrow(
      /^backup_nas_underlay_observation_unavailable$/,
    );
    expect(checks).toBe(3);
    if (reason === 'journal') expect(fs.readFileSync(s.journal, 'utf8')).toBe('FOREIGN');
    else expect(fs.existsSync(s.journal)).toBe(false);
  },
);
it.each(['inode', 'claim'])(
  'rechecks an observed %s change during final writer closure before returning its identity',
  async (reason) => {
    const s = fixture();
    fs.mkdirSync(s.mount, { mode: 0 });
    const close = fs.closeSync;
    let changed = false;
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      const file = fs.readlinkSync('/proc/self/fd/' + fd);
      close(fd);
      if (!changed && file.endsWith('/repository.lock')) {
        changed = true;
        if (reason === 'inode') {
          fs.renameSync(s.mount, s.mount + '.original');
          fs.mkdirSync(s.mount, { mode: 0 });
        } else fs.writeFileSync(s.journal, 'FOREIGN', { mode: 0o600 });
      }
    });
    await expect(inspectBackupNasUnclaimedUnderlay(s.vault, s.nas, s.controls)).rejects.toThrow(
      /^backup_nas_underlay_observation_unavailable$/,
    );
    expect(changed).toBe(true);
    if (reason === 'claim') expect(fs.readFileSync(s.journal, 'utf8')).toBe('FOREIGN');
    else expect(fs.existsSync(s.journal)).toBe(false);
  },
);
it('exclusively creates a closed root-owned mountpoint and durable claim while preserving all G01 state', async () => {
  const s = fixture(),
    before = fs.readFileSync(s.bootstrapFile);
  fs.writeFileSync(path.join(s.controls.paths.storageRoot, 'vault.luks'), 'KEEP_VAULT', { mode: 0o600 });
  const result = await prepareBackupNasUnderlay(s.vault, s.nas, s.controls);
  expect(process.getuid?.()).toBe(0);
  expect(result).toMatchObject({
    contract: 'cos-backup-nas-mount-state/v1',
    configurationDigest: digest(s.nas),
    phase: 'closed',
    attemptId: null,
    mount: null,
  });
  expect(fs.lstatSync(s.mount).uid).toBe(0);
  expect(fs.lstatSync(s.mount).mode & 0o7777).toBe(0);
  expect(fs.readdirSync(s.mount)).toEqual([]);
  expect(fs.lstatSync(s.journal).mode & 0o7777).toBe(0o600);
  const original = fs.lstatSync(s.mount).ino;
  expect(await prepareBackupNasUnderlay(s.vault, s.nas, s.controls)).toEqual(result);
  expect(fs.lstatSync(s.mount).ino).toBe(original);
  expect(fs.readFileSync(s.bootstrapFile)).toEqual(before);
  expect(fs.readFileSync(path.join(s.controls.paths.storageRoot, 'vault.luks'), 'utf8')).toBe('KEEP_VAULT');
});
it.each([
  'directory',
  'file',
  'symlink',
  'mounted',
  'authority',
  'memory',
  'bootstrap-missing',
  'bootstrap-identity',
  'bootstrap-phase',
  'bootstrap-claim',
  'bootstrap-symlink',
  'bootstrap-hardlink',
  'bootstrap-mode',
  'control-mode',
  'storage-mode',
  'path',
])('refuses initial %s without claiming or repairing it', async (reason) => {
  const s = fixture();
  if (reason === 'directory') fs.mkdirSync(s.mount, { mode: 0o700 });
  if (reason === 'file') fs.writeFileSync(s.mount, 'FOREIGN');
  if (reason === 'symlink') fs.symlinkSync(s.controls.paths.configRoot, s.mount);
  if (reason === 'mounted') s.controls.isMounted.mockReturnValue(true);
  if (reason === 'authority') s.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
  if (reason === 'memory')
    s.controls.assertMemory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'bootstrap-missing') fs.unlinkSync(s.bootstrapFile);
  if (reason === 'bootstrap-identity')
    fs.writeFileSync(s.bootstrapFile, JSON.stringify({ ...s.bootstrap, identityDigest: 'f'.repeat(64) }));
  if (reason === 'bootstrap-phase')
    fs.writeFileSync(s.bootstrapFile, JSON.stringify({ ...s.bootstrap, phase: 'intent' }));
  if (reason === 'bootstrap-claim')
    fs.writeFileSync(
      s.bootstrapFile,
      JSON.stringify({
        ...s.bootstrap,
        claims: { ...s.bootstrap.claims, storage: { ...s.bootstrap.claims.storage, inode: 999 } },
      }),
    );
  if (reason === 'bootstrap-symlink') {
    fs.renameSync(s.bootstrapFile, s.bootstrapFile + '.old');
    fs.symlinkSync(s.bootstrapFile + '.old', s.bootstrapFile);
  }
  if (reason === 'bootstrap-hardlink') fs.linkSync(s.bootstrapFile, s.bootstrapFile + '.other');
  if (reason === 'bootstrap-mode') fs.chmodSync(s.bootstrapFile, 0o644);
  if (reason === 'control-mode') fs.chmodSync(s.controls.paths.controlRoot, 0o755);
  if (reason === 'storage-mode') fs.chmodSync(s.controls.paths.storageRoot, 0o777);
  if (reason === 'path') s.controls.paths.mount = path.join(s.root, 'foreign');
  await expect(prepareBackupNasUnderlay(s.vault, s.nas, s.controls)).rejects.toThrow(
    /^backup_nas_underlay_unavailable$/,
  );
  expect(fs.existsSync(s.journal)).toBe(false);
  if (reason === 'file') expect(fs.readFileSync(s.mount, 'utf8')).toBe('FOREIGN');
});
it.each(['missing', 'inode', 'mode', 'payload', 'journal-scope', 'journal-hardlink', 'journal-mode'])(
  'refuses a changed claimed %s without recreating the underlay',
  async (reason) => {
    const s = fixture();
    await prepareBackupNasUnderlay(s.vault, s.nas, s.controls);
    if (reason === 'missing') fs.rmdirSync(s.mount);
    if (reason === 'inode') {
      fs.renameSync(s.mount, s.mount + '.old');
      fs.mkdirSync(s.mount, { mode: 0 });
    }
    if (reason === 'mode') fs.chmodSync(s.mount, 0o700);
    if (reason === 'payload') fs.writeFileSync(path.join(s.mount, 'FOREIGN'), 'KEEP');
    if (reason === 'journal-scope') {
      const value = JSON.parse(fs.readFileSync(s.journal, 'utf8'));
      fs.writeFileSync(s.journal, JSON.stringify({ ...value, configurationDigest: 'f'.repeat(64) }));
    }
    if (reason === 'journal-hardlink') fs.linkSync(s.journal, s.journal + '.other');
    if (reason === 'journal-mode') fs.chmodSync(s.journal, 0o644);
    await expect(prepareBackupNasUnderlay(s.vault, s.nas, s.controls)).rejects.toThrow(
      /^backup_nas_underlay_unavailable$/,
    );
    if (reason === 'missing') expect(fs.existsSync(s.mount)).toBe(false);
    if (reason === 'payload') expect(fs.readFileSync(path.join(s.mount, 'FOREIGN'), 'utf8')).toBe('KEEP');
  },
);
it('does not adopt an unclaimed mountpoint left after authority disappears during creation', async () => {
  const s = fixture();
  s.controls.assertAuthority.mockImplementation(async () => {
    if (fs.existsSync(s.mount)) throw Error('PRIVATE_REVOKED');
  });
  await expect(prepareBackupNasUnderlay(s.vault, s.nas, s.controls)).rejects.toThrow(
    /^backup_nas_underlay_unavailable$/,
  );
  expect(fs.lstatSync(s.mount).mode & 0o7777).toBe(0);
  expect(fs.existsSync(s.journal)).toBe(false);
  s.controls.assertAuthority.mockResolvedValue(undefined);
  await expect(prepareBackupNasUnderlay(s.vault, s.nas, s.controls)).rejects.toThrow(
    /^backup_nas_underlay_unavailable$/,
  );
  expect(fs.existsSync(s.journal)).toBe(false);
});
it('repeats durability checks on an exact replay whose first journal sync failed', async () => {
  const s = fixture(),
    sync = fs.fsyncSync;
  let failed = false;
  const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/nas-mount.json') && !failed) {
      failed = true;
      throw Error('PRIVATE_SYNC');
    }
    sync(fd);
  });
  await expect(prepareBackupNasUnderlay(s.vault, s.nas, s.controls)).rejects.toThrow(
    /^backup_nas_underlay_unavailable$/,
  );
  expect(failed).toBe(true);
  // Capture descriptor identity at the actual sync call, before the replay closes it.
  let journalSynced = false;
  spy.mockImplementation((fd) => {
    if (fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/nas-mount.json')) journalSynced = true;
    sync(fd);
  });
  await prepareBackupNasUnderlay(s.vault, s.nas, s.controls);
  expect(journalSynced).toBe(true);
});
it('holds a real kernel writer lease through preparation and refuses a competing helper', async () => {
  const s = fixture();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  let waited = false;
  const first = {
    ...s.controls,
    assertAuthority: vi.fn(async () => {
      if (!waited && fs.existsSync(path.join(s.controls.paths.controlRoot, 'repository.lock'))) {
        waited = true;
        entered();
        await hold;
      }
    }),
  };
  const running = prepareBackupNasUnderlay(s.vault, s.nas, first);
  await ready;
  await expect(prepareBackupNasUnderlay(s.vault, s.nas, s.controls)).rejects.toThrow(
    /^backup_nas_underlay_unavailable$/,
  );
  release();
  await running;
  expect(fs.existsSync(s.journal)).toBe(true);
});
