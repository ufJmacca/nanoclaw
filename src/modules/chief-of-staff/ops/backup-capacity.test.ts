import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock('./vault-storage.js', () => ({ withVaultDirectory: f.access }));
import { readBackupCapacity } from './backup-capacity.js';
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
