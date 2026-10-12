import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock('./vault-storage.js', () => ({ withVaultDirectory: f.access }));
import { readBackupCapacity, readBackupInitializationCapacity } from './backup-capacity.js';
const temporary: string[] = [],
  held: number[] = [];
const roots = { targetRoot: '/synthetic/state', installationRoot: '/synthetic/install', dataRoot: '/synthetic/data' };
afterEach(() => {
  for (const fd of held.splice(0)) fs.closeSync(fd);
  vi.restoreAllMocks();
  f.access.mockReset();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-capacity-'));
  temporary.push(root);
  const areas = Object.fromEntries(
    ['staging', 'cache', 'journals', 'repository'].map((name) => {
      const directory = path.join(root, name);
      fs.mkdirSync(directory, { mode: 0o700 });
      return [name, directory];
    }),
  );
  f.access.mockImplementation(async (_roots, area, operation) => operation(areas[area]));
  const fd = fs.openSync(areas.repository, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  held.push(fd);
  const check = vi.fn();
  const repository = { fd, assertCurrent: check };
  vi.spyOn(fs, 'statfsSync').mockReturnValue({
    type: 0xfe534d42n,
    bavail: 2n ** 30n,
    bsize: 4096n,
  } as fs.BigIntStatsFs);
  return { areas, repository, check };
}
it.each([false, true])('initialization counts only the fixed repository with existing=%s', async (existing) => {
  const s = fixture();
  fs.mkdirSync(s.areas.repository + '/@Recently-Snapshot', { mode: 0o500 });
  let expected = 0;
  if (existing) {
    const child = s.areas.repository + '/restic';
    fs.mkdirSync(child, { mode: 0o700 });
    fs.writeFileSync(child + '/config', 'synthetic encrypted repository config', { mode: 0o600 });
    const fd = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    held.push(fd);
    expected = (await readBackupCapacity(roots, { fd, assertCurrent: s.repository.assertCurrent })).repository;
  }
  await expect(readBackupInitializationCapacity(roots, s.repository)).resolves.toMatchObject({ repository: expected });
  await expect(readBackupCapacity(roots, s.repository)).rejects.toThrow('backup_capacity_unavailable');
  expect(fs.statSync(s.areas.repository + '/@Recently-Snapshot').mode & 0o777).toBe(0o500);
});
it.each(['symlink', 'file', 'directory-mode', 'file-mode', 'withdrawn-share'])(
  'initialization still rejects an unsafe fixed repository: %s',
  async (reason) => {
    const s = fixture(),
      child = s.areas.repository + '/restic';
    fs.mkdirSync(s.areas.repository + '/@Recently-Snapshot', { mode: 0o500 });
    if (reason === 'file') fs.writeFileSync(child, 'unrelated', { mode: 0o600 });
    else if (reason === 'symlink') fs.symlinkSync(s.areas.staging, child);
    else {
      fs.mkdirSync(child, { mode: 0o700 });
      if (reason === 'directory-mode') fs.chmodSync(child, 0o755);
      if (reason === 'file-mode') fs.writeFileSync(child + '/config', 'synthetic', { mode: 0o644 });
    }
    if (reason === 'withdrawn-share')
      s.check.mockImplementation(() => {
        throw Error('withdrawn');
      });
    await expect(readBackupInitializationCapacity(roots, s.repository)).rejects.toThrow('backup_capacity_unavailable');
  },
);
it('counts allocated files and directory metadata without reading any payload contents', async () => {
  const s = fixture();
  fs.writeFileSync(path.join(s.areas.staging, 'checkpoint'), Buffer.alloc(100000), { mode: 0o600 });
  fs.mkdirSync(path.join(s.areas.journals, 'nested'), { mode: 0o700 });
  fs.writeFileSync(path.join(s.areas.journals, 'nested', 'journal'), 'synthetic metadata', { mode: 0o600 });
  fs.writeFileSync(path.join(s.areas.repository, 'encrypted-pack'), Buffer.alloc(30000), { mode: 0o600 });
  const read = vi.spyOn(fs, 'readFileSync'),
    capacity = await readBackupCapacity(roots, s.repository);
  expect(capacity.staging).toBeGreaterThanOrEqual(102400);
  expect(capacity.credentials).toBeGreaterThanOrEqual(8192);
  expect(capacity.repository).toBeGreaterThanOrEqual(32768);
  expect(capacity.cache).toBeGreaterThan(0);
  expect(capacity.nasFree).toBe(2 ** 42);
  expect(capacity.vaultFree).toBe(2 ** 42);
  expect(read).not.toHaveBeenCalled();
  expect(s.check).toHaveBeenCalledTimes(2);
  expect(f.access.mock.calls.map((call) => call[1])).toEqual(['staging', 'cache', 'journals']);
});
it.each(['symlink', 'hardlink', 'permissions', 'directory-permissions', 'changed-root', 'invalid-free-space'])(
  'refuses %s instead of reporting an incomplete capacity estimate',
  async (reason) => {
    const s = fixture(),
      file = path.join(s.areas.staging, 'checkpoint');
    fs.writeFileSync(file, 'synthetic checkpoint', { mode: 0o600 });
    if (reason === 'symlink') {
      fs.renameSync(file, file + '.original');
      fs.symlinkSync(file + '.original', file);
    }
    if (reason === 'hardlink') fs.linkSync(file, file + '.other');
    if (reason === 'permissions') fs.chmodSync(file, 0o644);
    if (reason === 'directory-permissions') fs.chmodSync(s.areas.staging, 0o755);
    if (reason === 'changed-root')
      s.check
        .mockImplementationOnce(() => {})
        .mockImplementation(() => {
          throw Error('private changed NAS');
        });
    if (reason === 'invalid-free-space')
      vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096n, bavail: -1n } as fs.BigIntStatsFs);
    await expect(readBackupCapacity(roots, s.repository)).rejects.toThrow(/^backup_capacity_unavailable$/);
  },
);
it('denies unavailable vault access with a fixed error', async () => {
  const s = fixture();
  f.access.mockImplementation(() => {
    throw Error('private vault path');
  });
  await expect(readBackupCapacity(roots, s.repository)).rejects.toThrow(/^backup_capacity_unavailable$/);
});
function rootProof(file: string) {
  const lstat = fs.lstatSync,
    fstat = fs.fstatSync,
    open = fs.openSync;
  const descriptors = new Set<number>();
  const rootStat = (stat: fs.Stats) =>
    Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0, gid: 0 });
  vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, options?: fs.StatOptions) => {
    const stat = lstat(path, options as never);
    return String(path).endsWith('/' + file) ? rootStat(stat) : stat;
  }) as typeof fs.lstatSync);
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    const fd = open(path, flags, mode);
    if (String(path).endsWith('/' + file)) {
      expect(flags).toBe(0x200000 | fs.constants.O_NOFOLLOW);
      descriptors.add(fd);
    } else descriptors.delete(fd);
    return fd;
  });
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
    const stat = fstat(fd);
    return descriptors.has(fd) ? rootStat(stat) : stat;
  }) as typeof fs.fstatSync);
}
it('charges the fixed root-owned vault proof by metadata without reading its bytes', async () => {
  const s = fixture();
  fs.writeFileSync(s.areas.journals + '/.vault-canary', 'SYNTHETIC_ROOT_PROOF', { mode: 0o600 });
  rootProof('.vault-canary');
  const read = vi.spyOn(fs, 'readSync'),
    readFile = vi.spyOn(fs, 'readFileSync');
  const capacity = await readBackupCapacity(roots, s.repository);
  expect(capacity.credentials).toBeGreaterThanOrEqual(8192);
  expect(read).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});
it.each(['mode', 'hardlink', 'too-large', 'other-root-file', 'nested-proof'])(
  'refuses an unsafe or out-of-scope root proof: %s',
  async (reason) => {
    const s = fixture(),
      name = reason === 'other-root-file' ? 'unrelated-root-proof' : '.vault-canary';
    let directory = s.areas.journals;
    if (reason === 'nested-proof') {
      directory += '/nested';
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    const file = directory + '/' + name;
    fs.writeFileSync(file, Buffer.alloc(reason === 'too-large' ? 4097 : 32), {
      mode: reason === 'mode' ? 0o644 : 0o600,
    });
    if (reason === 'mode') fs.chmodSync(file, 0o644);
    if (reason === 'hardlink') fs.linkSync(file, file + '.other');
    rootProof(name);
    await expect(readBackupCapacity(roots, s.repository)).rejects.toThrow(/^backup_capacity_unavailable$/);
  },
);
