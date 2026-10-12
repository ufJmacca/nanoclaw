import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withSignedBackupRepository, withSignedBackupShare, withPinnedBackupRepository } from './backup-nas-access.js';
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-nas-'));
  temporary.push(root);
  const mount = path.join(root, 'mount');
  fs.mkdirSync(mount, { mode: 0o700 });
  fs.mkdirSync(path.join(mount, 'restic'), { mode: 0o700 });
  const binding = { host: '192.0.2.10', share: 'nanoclaw-cos-backups' as const, mount };
  const fd = fs.openSync(mount, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const initialMountId = Number(fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8').match(/^mnt_id:\s+(\d+)$/m)![1]);
  fs.closeSync(fd);
  let mountId = initialMountId,
    signed = true;
  const inspect = vi.fn(() =>
    JSON.stringify({
      filesystems: [
        {
          target: mount,
          source: '//192.0.2.10/nanoclaw-cos-backups',
          fstype: 'cifs',
          id: mountId,
          options:
            'rw,nosuid,nodev,noexec,nodfs,soft,vers=2.1,username=nanoclaw-cos-backup,addr=192.0.2.10,sec=' +
            (signed ? 'ntlmsspi' : 'ntlmssp'),
        },
      ],
    }),
  );
  const statfs = fs.statfsSync;
  vi.spyOn(fs, 'statfsSync').mockImplementation((file, options) => {
    const value = statfs(file, options);
    return String(file).startsWith('/proc/self/fd/') && fs.readlinkSync(String(file)).startsWith(mount)
      ? ({ ...value, type: options?.bigint ? 0xfe534d42n : 0xfe534d42 } as ReturnType<typeof statfs>)
      : value;
  });
  return {
    root,
    mount,
    binding,
    inspect,
    replaceMount: () => {
      mountId++;
      const read = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) =>
        String(file).startsWith('/proc/self/fdinfo/') ? 'mnt_id:\t' + mountId + '\n' : read(file, options),
      );
    },
    unsigned: () => {
      signed = false;
    },
  };
}
it('admits an empty signed share without creating a repository or reading a credential', async () => {
  const s = fixture();
  fs.rmdirSync(path.join(s.mount, 'restic'));
  let fd = -1;
  await withSignedBackupShare(
    s.binding,
    async (share) => {
      fd = share.fd;
      expect(fs.readlinkSync('/proc/self/fd/' + fd)).toBe(s.mount);
      await expect(withPinnedBackupRepository(share, async () => {})).rejects.toThrow(
        'backup_repository_mount_unverified',
      );
      share.assertCurrent();
      expect(fs.readdirSync(s.mount)).toEqual([]);
    },
    s.inspect,
  );
  expect(() => fs.fstatSync(fd)).toThrow();
});
it('pins the dedicated signed CIFS repository and closes its descriptor after awaited work', async () => {
  const s = fixture();
  let fd = -1,
    check!: () => void;
  await withSignedBackupRepository(
    s.binding,
    async (lease) => {
      fd = lease.fd;
      check = lease.assertCurrent;
      await new Promise<void>((resolve) => setImmediate(resolve));
      lease.assertCurrent();
      expect(fs.readlinkSync('/proc/self/fd/' + fd)).toBe(path.join(s.mount, 'restic'));
    },
    s.inspect,
  );
  expect(s.inspect).toHaveBeenCalledWith('/usr/bin/findmnt', [
    '--json',
    '--mountpoint',
    s.mount,
    '--output',
    'TARGET,SOURCE,FSTYPE,OPTIONS,ID',
  ]);
  expect(() => fs.fstatSync(fd)).toThrow();
  expect(() => check()).toThrow(/^backup_repository_mount_unverified$/);
});
it('rejects distinct 64-bit repository inodes even when their JavaScript numbers collide', async () => {
  const s = fixture(),
    original = 11453233246511605176n;
  let named = original,
    blocked = false;
  const fstat = fs.fstatSync,
    lstat = fs.lstatSync;
  vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
    const value = fstat(fd, options);
    return fs.readlinkSync('/proc/self/fd/' + fd) === s.mount + '/restic'
      ? (Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
          ino: options?.bigint ? original : Number(original),
        }) as ReturnType<typeof fstat>)
      : value;
  });
  vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
    const value = lstat(file, options);
    return value && String(file).endsWith('/restic')
      ? (Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
          ino: options?.bigint ? named : Number(named),
        }) as ReturnType<typeof lstat>)
      : value;
  });
  await withSignedBackupRepository(
    s.binding,
    async (repository) => {
      named = original + 1n;
      try {
        repository.assertCurrent();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'backup_repository_mount_unverified') throw error;
        blocked = true;
      }
      named = original;
    },
    s.inspect,
  );
  expect(Number(original + 1n)).toBe(Number(original));
  expect(blocked).toBe(true);
});
it('rechecks the kernel mount and descriptors for every block without spawning repeated mount inspections', async () => {
  const s = fixture();
  await withSignedBackupRepository(
    s.binding,
    async (lease) => {
      const before = s.inspect.mock.calls.length;
      for (let index = 0; index < 12; index++) lease.assertCurrent();
      expect(s.inspect.mock.calls.length).toBe(before);
    },
    s.inspect,
  );
  expect(s.inspect).toHaveBeenCalledTimes(2);
});
it('refuses a local underlay before calling any credential-bearing operation', async () => {
  const s = fixture(),
    operation = vi.fn();
  vi.restoreAllMocks(); // Real local filesystem type cannot be admitted as CIFS.
  await expect(withSignedBackupRepository(s.binding, operation, s.inspect)).rejects.toThrow(
    /^backup_repository_mount_unverified$/,
  );
  expect(operation).not.toHaveBeenCalled();
});
it('requires the kernel SMB2 filesystem rather than admitting an SMB1 filesystem type', async () => {
  const s = fixture(),
    operation = vi.fn();
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ type: 0xff534d42n } as fs.BigIntStatsFs);
  await expect(withSignedBackupRepository(s.binding, operation, s.inspect)).rejects.toThrow(
    /^backup_repository_mount_unverified$/,
  );
  expect(operation).not.toHaveBeenCalled();
});
it('requires the opened descriptor mount ID to match the signed mount proof before credential use', async () => {
  const s = fixture(),
    operation = vi.fn(),
    read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) =>
    String(file).startsWith('/proc/self/fdinfo/') ? 'mnt_id:\t999999\n' : read(file, options),
  );
  await expect(withSignedBackupRepository(s.binding, operation, s.inspect)).rejects.toThrow(
    /^backup_repository_mount_unverified$/,
  );
  expect(operation).not.toHaveBeenCalled();
});
it.each(['missing', 'unsigned', 'replacement', 'linked-repository', 'foreign-permissions', 'missing-repository'])(
  'refuses %s rather than following an unverified repository path',
  async (reason) => {
    const s = fixture(),
      operation = vi.fn();
    if (reason === 'missing') s.inspect.mockReturnValue(JSON.stringify({ filesystems: [] }));
    if (reason === 'unsigned') s.unsigned();
    if (reason === 'replacement')
      s.inspect.mockReturnValue(
        JSON.stringify({
          filesystems: [{ id: 1, target: s.mount, source: '//192.0.2.99/other', fstype: 'cifs', options: 'rw' }],
        }),
      );
    if (reason === 'linked-repository') {
      fs.rmdirSync(path.join(s.mount, 'restic'));
      fs.symlinkSync(s.root, path.join(s.mount, 'restic'));
    }
    if (reason === 'foreign-permissions') fs.chmodSync(path.join(s.mount, 'restic'), 0o755);
    if (reason === 'missing-repository') fs.rmdirSync(path.join(s.mount, 'restic'));
    await expect(withSignedBackupRepository(s.binding, operation, s.inspect)).rejects.toThrow(
      /^backup_repository_mount_unverified$/,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(fs.readdirSync(s.mount)).toEqual(reason === 'missing-repository' ? [] : ['restic']);
  },
);
it.each(['mount-id', 'repository-directory'])('invalidates a held lease after %s changes', async (reason) => {
  const s = fixture();
  let used = false,
    fd = -1;
  await expect(
    withSignedBackupRepository(
      s.binding,
      async (lease) => {
        fd = lease.fd;
        if (reason === 'mount-id') s.replaceMount();
        else {
          fs.renameSync(path.join(s.mount, 'restic'), path.join(s.mount, 'previous'));
          fs.mkdirSync(path.join(s.mount, 'restic'), { mode: 0o700 });
        }
        lease.assertCurrent();
        used = true;
      },
      s.inspect,
    ),
  ).rejects.toThrow(/^backup_repository_mount_unverified$/);
  expect(used).toBe(false);
  expect(() => fs.fstatSync(fd)).toThrow();
});
it('redacts private command failures while releasing held mount and repository handles', async () => {
  const s = fixture();
  let fd = -1;
  await expect(
    withSignedBackupRepository(
      s.binding,
      async (lease) => {
        fd = lease.fd;
        throw Error('private NAS credential diagnostic');
      },
      s.inspect,
    ),
  ).rejects.toThrow(/^backup_repository_mount_unverified$/);
  expect(() => fs.fstatSync(fd)).toThrow();
});
