import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createVaultMounts, type VaultMountControls } from './vault-mounts.js';
import { VAULT_DIRECTORIES } from './vault-storage.js';
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mounts-'));
  temporary.push(root);
  const paths = { stateRoot: root + '/control', vaultRoot: root + '/vault', calendarRoot: root + '/target/calendar' };
  fs.mkdirSync(paths.stateRoot, { mode: 0o700 });
  fs.mkdirSync(root + '/target', { mode: 0o700 });
  fs.writeFileSync(root + '/device', 'synthetic', { mode: 0o600 });
  const identity = {
    operationId: randomUUID(),
    targetDigest: 'd'.repeat(64),
    recoveryReference: randomUUID(),
    luksUuid: randomUUID(),
    filesystemUuid: randomUUID(),
  };
  const owner = { uid: process.getuid!(), gid: process.getgid!() };
  const mounted = new Map<
    string,
    { target: string; fstype: string; fsroot: string; 'maj:min': string; uuid: string; options: string }
  >();
  // Model root access and a bind's inode in this unprivileged unit fixture; real kernel behavior is checked separately.
  const lstat = fs.lstatSync,
    readdir = fs.readdirSync,
    open = fs.openSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file, options) => {
    if (file === paths.calendarRoot && mounted.has(paths.calendarRoot))
      return lstat(paths.vaultRoot + '/google/calendar', options);
    return lstat(file, options);
  }) as typeof fs.lstatSync);
  vi.spyOn(fs, 'readdirSync').mockImplementation(((file, options) => {
    if ([paths.vaultRoot, paths.calendarRoot].includes(String(file)) && (lstat(file).mode & 0o777) === 0) return [];
    return Reflect.apply(readdir, fs, [file, options]);
  }) as typeof fs.readdirSync);
  vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    if ([paths.vaultRoot, paths.calendarRoot].includes(String(file)) && (lstat(file).mode & 0o777) === 0)
      return open(file, 0x200000 | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    return open(file, flags, mode);
  });
  const number = fs.statSync(root).dev;
  const major = ((BigInt(number) >> 8n) & 0xfffn) | ((BigInt(number) >> 32n) & 0xfffff000n);
  const minor = (BigInt(number) & 0xffn) | ((BigInt(number) >> 12n) & 0xffffff00n);
  const controls: VaultMountControls = {
    assertAuthority: vi.fn(async () => {}),
    assertMemory: vi.fn(),
    assertFilesystem: vi.fn(),
    withMappedDevice(operation) {
      const fd = fs.openSync(root + '/device', 'r');
      try {
        return operation(fd, number);
      } finally {
        fs.closeSync(fd);
      }
    },
    inspect(directory) {
      return mounted.get(directory) ?? null;
    },
    run: vi.fn((command, args, descriptors) => {
      expect(command).toBe('/usr/bin/mount');
      expect(args).toContain('/proc/self/fd/3');
      expect(args).toContain('/proc/self/fd/4');
      expect(descriptors).toHaveLength(2);
      const bind = args.includes('bind,nosuid,nodev,noexec');
      const directory = bind ? paths.calendarRoot : paths.vaultRoot;
      expect(fs.fstatSync(descriptors[1]).ino).toBe(fs.statSync(directory).ino);
      if (!bind) {
        fs.chmodSync(directory, 0o755);
        fs.mkdirSync(directory + '/lost+found', { mode: 0o700 });
      }
      mounted.set(directory, {
        target: directory,
        fstype: 'ext4',
        fsroot: bind ? '/google/calendar' : '/',
        'maj:min': `${major}:${minor}`,
        uuid: identity.filesystemUuid,
        options: 'rw,nosuid,nodev,noexec,relatime',
      });
      return { status: 0, output: '' };
    }),
  };
  return {
    root,
    paths,
    identity,
    owner,
    controls,
    mounted,
    mounts: createVaultMounts(paths, identity, owner, controls),
  };
}
it('creates only claimed closed underlays, mounts pinned descriptors and initializes private encrypted areas once', async () => {
  const f = fixture();
  expect(f.mounts.inspect()).toBe('absent');
  await f.mounts.mount();
  expect(f.mounts.inspect()).toBe('matching');
  const before = fs.statSync(f.paths.vaultRoot + '/google/calendar').ino;
  fs.writeFileSync(f.paths.vaultRoot + '/google/calendar/canary', 'synthetic');
  await f.mounts.mount();
  expect(fs.statSync(f.paths.vaultRoot + '/google/calendar').ino).toBe(before);
  expect(fs.readFileSync(f.paths.vaultRoot + '/google/calendar/canary', 'utf8')).toBe('synthetic');
  expect(vi.mocked(f.controls.run!).mock.calls).toHaveLength(2);
  for (const area of VAULT_DIRECTORIES) expect(fs.statSync(f.paths.vaultRoot + '/' + area).mode & 0o777).toBe(0o700);
});
it.each([
  'existing-underlay',
  'symlink',
  'foreign-mount',
  'wrong-uuid',
  'wrong-fsroot',
  'missing-options',
  'authority',
  'memory',
  'filesystem',
])('denies %s without adopting or creating plaintext areas', async (reason) => {
  const f = fixture();
  if (reason === 'existing-underlay') fs.mkdirSync(f.paths.vaultRoot, { mode: 0 });
  if (reason === 'symlink') fs.symlinkSync(f.root + '/target', f.paths.vaultRoot);
  if (['foreign-mount', 'wrong-uuid', 'wrong-fsroot', 'missing-options'].includes(reason)) {
    f.mounted.set(f.paths.vaultRoot, {
      target: f.paths.vaultRoot,
      fstype: 'ext4',
      fsroot: '/',
      'maj:min': '8:1',
      uuid: f.identity.filesystemUuid,
      options: 'rw,nosuid,nodev,noexec',
    });
    const entry = f.mounted.get(f.paths.vaultRoot)!;
    if (reason === 'wrong-uuid') entry.uuid = randomUUID();
    if (reason === 'wrong-fsroot') entry.fsroot = '/foreign';
    if (reason === 'missing-options') entry.options = 'rw';
  }
  if (reason === 'authority')
    f.controls.assertAuthority = async () => {
      throw Error('PRIVATE_LEASE');
    };
  if (reason === 'memory')
    f.controls.assertMemory = () => {
      throw Error('PRIVATE_MEMORY');
    };
  if (reason === 'filesystem')
    f.controls.assertFilesystem = () => {
      throw Error('PRIVATE_DEVICE');
    };
  await expect(f.mounts.mount()).rejects.toThrow('vault_mounts_unavailable');
  expect(fs.existsSync(f.paths.vaultRoot + '/google')).toBe(false);
  expect(vi.mocked(f.controls.run!).mock.calls).toHaveLength(0);
});
it('keeps completed directory permissions strict and refuses identity or inode replacement', async () => {
  const f = fixture();
  await f.mounts.mount();
  fs.chmodSync(f.paths.vaultRoot + '/cache', 0o755);
  expect(f.mounts.inspect()).toBe('conflict');
  await expect(f.mounts.mount()).rejects.toThrow('vault_mounts_unavailable');
  expect(fs.statSync(f.paths.vaultRoot + '/cache').mode & 0o777).toBe(0o755);
  fs.chmodSync(f.paths.vaultRoot + '/cache', 0o700);
  fs.renameSync(f.paths.vaultRoot + '/cache', f.paths.vaultRoot + '/cache-original');
  fs.mkdirSync(f.paths.vaultRoot + '/cache', { mode: 0o700 });
  expect(f.mounts.inspect()).toBe('conflict');
  f.identity.operationId = randomUUID();
  await expect(f.mounts.mount()).rejects.toThrow('vault_mounts_unavailable');
});
it('resumes a verified owned mount after a lost mount reply without repeating it', async () => {
  const f = fixture(),
    run = f.controls.run!;
  f.controls.run = (...args) => {
    run(...args);
    throw Error('PRIVATE_LOST_REPLY');
  };
  await expect(f.mounts.mount()).rejects.toThrow('vault_mounts_unavailable');
  f.controls.run = run;
  await f.mounts.mount();
  expect(f.mounts.inspect()).toBe('matching');
  expect(vi.mocked(run).mock.calls).toHaveLength(2);
});
it('denies a replaced Calendar underlay after authority awaits, before binding anything', async () => {
  const f = fixture();
  let replaced = false;
  f.controls.assertAuthority = async () => {
    if (
      !replaced &&
      fs.existsSync(f.paths.stateRoot + '/mounts.json') &&
      JSON.parse(fs.readFileSync(f.paths.stateRoot + '/mounts.json', 'utf8')).areas['google/calendar']
    ) {
      fs.renameSync(f.paths.calendarRoot, f.paths.calendarRoot + '-original');
      fs.mkdirSync(f.paths.calendarRoot, { mode: 0 });
      replaced = true;
    }
  };
  await expect(f.mounts.mount()).rejects.toThrow('vault_mounts_unavailable');
  expect(replaced).toBe(true);
  expect(f.mounted.has(f.paths.calendarRoot)).toBe(false);
});
it.each(['uuid', 'filesystem', 'fsroot', 'device', 'options', 'claim-loss'])(
  'denies %s changes to a previously verified mount',
  async (reason) => {
    const f = fixture();
    await f.mounts.mount();
    const entry = f.mounted.get(f.paths.vaultRoot)!;
    if (reason === 'uuid') entry.uuid = randomUUID();
    if (reason === 'filesystem') entry.fstype = 'xfs';
    if (reason === 'fsroot') entry.fsroot = '/foreign';
    if (reason === 'device') entry['maj:min'] = '8:1';
    if (reason === 'options') entry.options = 'rw,nosuid,nodev';
    if (reason === 'claim-loss') fs.unlinkSync(f.paths.stateRoot + '/mounts.json');
    expect(f.mounts.inspect()).toBe('conflict');
    await expect(f.mounts.mount()).rejects.toThrow('vault_mounts_unavailable');
    expect(vi.mocked(f.controls.run!).mock.calls).toHaveLength(2);
  },
);
it('uses the proven filesystem identity rather than a previous dm minor for persistent area claims', async () => {
  const f = fixture();
  await f.mounts.mount();
  const file = f.paths.stateRoot + '/mounts.json',
    claim = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const entry of Object.values(claim.areas) as Array<{ device: number }>) entry.device = 999;
  fs.writeFileSync(file, JSON.stringify(claim));
  expect(f.mounts.inspect()).toBe('matching');
});
it('pins a claimed encrypted area, denies unmounted or asynchronous use and catches replacement after writing', async () => {
  const f = fixture();
  expect(() => f.mounts.withArea('journals', () => {})).toThrow('vault_mounts_unavailable');
  await f.mounts.mount();
  expect(() => f.mounts.withArea('journals', () => Promise.resolve())).toThrow('vault_mounts_unavailable');
  expect(() =>
    f.mounts.withArea('journals', (fd) => {
      fs.renameSync(f.paths.vaultRoot + '/journals', f.paths.vaultRoot + '/journals-original');
      fs.mkdirSync(f.paths.vaultRoot + '/journals', { mode: 0o700 });
      fs.writeFileSync(`/proc/self/fd/${fd}/synthetic-canary`, 'synthetic');
    }),
  ).toThrow('vault_mounts_unavailable');
  expect(fs.readdirSync(f.paths.vaultRoot + '/journals')).toEqual([]);
  expect(fs.readFileSync(f.paths.vaultRoot + '/journals-original/synthetic-canary', 'utf8')).toBe('synthetic');
});
