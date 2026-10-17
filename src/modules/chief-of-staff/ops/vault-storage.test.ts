import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  VAULT_DIRECTORIES,
  configureVaultStorage,
  verifyVaultStorage,
  withVaultDirectory,
  vaultStorageStatus,
} from './vault-storage.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
const cleanup: string[] = [];
const uuid = '11111111-2222-4333-8444-555555555555';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-vault-'));
  cleanup.push(root);
  const roots = { targetRoot: root + '/target', installationRoot: root + '/application', dataRoot: root + '/data' };
  const vault = root + '/vault';
  for (const directory of [
    ...Object.values(roots),
    vault,
    ...VAULT_DIRECTORIES.map((area) => vault + '/' + area),
    roots.targetRoot + '/calendar',
  ])
    fs.mkdirSync(directory, { mode: 0o700 });
  // Synthetic fixture mounts. Real kernel bind/remount proof is a separate mandatory gate.
  let plaintext = false;
  const inspect: StorageInspection = (command, args) =>
    JSON.stringify(
      command.endsWith('/findmnt')
        ? {
            filesystems: [
              {
                target: args[2] === roots.targetRoot + '/calendar' ? args[2] : vault,
                fsroot: '/google/calendar',
                source: '/dev/mapper/cos-vault',
                fstype: 'ext4',
                'maj:min': '253:0',
                uuid,
              },
            ],
          }
        : { blockdevices: [{ type: plaintext ? 'part' : 'crypt', 'maj:min': '253:0', uuid }] },
    );
  return {
    root,
    roots,
    vault,
    inspect,
    loseMount: () => {
      plaintext = true;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('lends a fresh kernel and directory guard without repeating the full subprocess inspection for each chunk', async () => {
  const f = fixture();
  configureVaultStorage(f.roots, f.vault, f.inspect);
  const inspect = vi.fn(f.inspect);
  let check!: () => void;
  await withVaultDirectory(
    f.roots,
    'staging',
    async (_directory, current) => {
      check = current;
      expect(typeof current).toBe('function');
      const before = inspect.mock.calls.length;
      for (let index = 0; index < 12; index++) current();
      expect(inspect.mock.calls.length).toBe(before);
    },
    inspect,
    () => {},
  );
  expect(() => check()).toThrow(/^vault_storage_unavailable$/);
});
it.each(['area', 'policy', 'memory'])(
  'withdraws its fresh streaming guard after an awaited %s change',
  async (reason) => {
    const f = fixture();
    configureVaultStorage(f.roots, f.vault, f.inspect);
    const memory = vi.fn();
    let written = false;
    await expect(
      withVaultDirectory(
        f.roots,
        'staging',
        async (directory, current) => {
          await Promise.resolve();
          if (reason === 'area') {
            fs.renameSync(f.vault + '/backup-credentials', f.vault + '/old');
            fs.mkdirSync(f.vault + '/backup-credentials', { mode: 0o700 });
          }
          if (reason === 'policy') fs.writeFileSync(f.roots.targetRoot + '/vault-storage.json', '{}');
          if (reason === 'memory')
            memory.mockImplementation(() => {
              throw Error('PRIVATE_WITHDRAWN');
            });
          current();
          fs.writeFileSync(directory + '/must-not-write', 'secret', { mode: 0o600 });
          written = true;
        },
        f.inspect,
        memory,
      ),
    ).rejects.toThrow(/^vault_storage_unavailable$/);
    expect(written).toBe(false);
    expect(fs.existsSync(f.vault + '/staging/must-not-write')).toBe(false);
  },
);
it('withdraws the fresh guard on a kernel mount-table change before another private write', async () => {
  const f = fixture();
  configureVaultStorage(f.roots, f.vault, f.inspect);
  const read = fs.readSync;
  await expect(
    withVaultDirectory(
      f.roots,
      'staging',
      async (directory, current) => {
        await Promise.resolve();
        vi.spyOn(fs, 'readSync').mockImplementation(((
          fd: number,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          if (!fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/mountinfo'))
            return Reflect.apply(read, fs, [fd, buffer, offset, length, position]);
          if (position) return 0;
          return Buffer.from('CHANGED_KERNEL_MOUNT_TABLE').copy(buffer, offset, 0, length);
        }) as typeof fs.readSync);
        current();
        fs.writeFileSync(directory + '/must-not-write', 'private', { mode: 0o600 });
      },
      f.inspect,
      () => {},
    ),
  ).rejects.toThrow(/^vault_storage_unavailable$/);
  expect(fs.existsSync(f.vault + '/staging/must-not-write')).toBe(false);
});
it('keeps its held encrypted accessor usable across an unrelated worker mount', async () => {
  const f = fixture();
  configureVaultStorage(f.roots, f.vault, f.inspect);
  const table = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const read = fs.readSync;
  await withVaultDirectory(
    f.roots,
    'staging',
    async (_directory, current) => {
      vi.spyOn(fs, 'readSync').mockImplementation(((
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        if (!fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/mountinfo'))
          return Reflect.apply(read, fs, [fd, buffer, offset, length, position]);
        return Buffer.from(table + '2000000000 1 0:99 / /var/lib/docker/synthetic-worker rw - tmpfs tmpfs rw\n')
          .subarray(Number(position), Number(position) + length)
          .copy(buffer, offset);
      }) as typeof fs.readSync);
      current();
      await Promise.resolve();
      current();
    },
    f.inspect,
    () => {},
  );
});
it('pins every required encrypted area and the canonical Calendar credential path', () => {
  const f = fixture();
  const first = configureVaultStorage(f.roots, f.vault, f.inspect);
  expect(first.volume.filesystemUuid).toBe(uuid);
  expect(Object.keys(first.directories)).toEqual([...VAULT_DIRECTORIES]);
  expect(verifyVaultStorage(f.roots, f.inspect)).toEqual(first);
  expect(configureVaultStorage(f.roots, f.vault, f.inspect)).toEqual(first);
  expect(vaultStorageStatus(f.roots, f.inspect, () => {})).toMatchObject({
    status: 'ready',
    encryption: 'dm-crypt',
    googleCredentials: 'available',
  });
  expect(JSON.stringify(vaultStorageStatus(f.roots, f.inspect))).not.toContain(f.root);
});
it.each(['missing', 'mode', 'symlink', 'plaintext'])(
  'denies unhealthy storage and never repairs it: %s',
  async (reason) => {
    const f = fixture();
    configureVaultStorage(f.roots, f.vault, f.inspect);
    const directory = f.vault + '/backup-credentials';
    if (reason === 'missing') fs.rmdirSync(directory);
    if (reason === 'mode') fs.chmodSync(directory, 0o755);
    if (reason === 'symlink') {
      fs.rmdirSync(directory);
      fs.symlinkSync(f.vault + '/google', directory);
    }
    if (reason === 'plaintext') f.loseMount();
    let used = false;
    await expect(
      withVaultDirectory(
        f.roots,
        'google',
        async () => {
          used = true;
        },
        f.inspect,
        () => {},
      ),
    ).rejects.toThrow('vault_storage_unavailable');
    expect(used).toBe(false);
    expect(vaultStorageStatus(f.roots, f.inspect)).toMatchObject({
      status: 'unavailable',
      googleCredentials: 'unavailable',
    });
    if (reason === 'missing') expect(fs.existsSync(directory)).toBe(false);
  },
);
it('pins credential writes across an awaited operation and refuses a replaced directory', async () => {
  const f = fixture();
  configureVaultStorage(f.roots, f.vault, f.inspect);
  const directory = f.vault + '/google',
    prior = f.vault + '/google-old';
  await expect(
    withVaultDirectory(
      f.roots,
      'google',
      async (pinned) => {
        expect(pinned).toMatch(/^\/proc\/self\/fd\/[0-9]+$/);
        fs.renameSync(directory, prior);
        fs.mkdirSync(directory, { mode: 0o700 });
        await Promise.resolve();
        fs.writeFileSync(pinned + '/token-canary', 'SYNTHETIC_SECRET_CANARY', { mode: 0o600 });
      },
      f.inspect,
      () => {},
    ),
  ).rejects.toThrow('vault_storage_unavailable');
  expect(fs.existsSync(directory + '/token-canary')).toBe(false);
  expect(fs.readFileSync(prior + '/token-canary', 'utf8')).toBe('SYNTHETIC_SECRET_CANARY');
});
it('denies unprotected credential processes before invoking user code', async () => {
  const f = fixture();
  configureVaultStorage(f.roots, f.vault, f.inspect);
  let used = false;
  await expect(
    withVaultDirectory(
      f.roots,
      'google',
      async () => {
        used = true;
      },
      f.inspect,
      () => {
        throw new Error('PRIVATE_MEMORY_CANARY');
      },
    ),
  ).rejects.toThrow('vault_storage_unavailable');
  expect(used).toBe(false);
});
it('rejects changed policy, missing policy and unknown areas without creating plaintext directories', async () => {
  const f = fixture();
  expect(() => verifyVaultStorage(f.roots, f.inspect)).toThrow('vault_storage_unavailable');
  configureVaultStorage(f.roots, f.vault, f.inspect);
  await expect(
    withVaultDirectory(
      f.roots,
      '../private' as 'google',
      async () => {},
      f.inspect,
      () => {},
    ),
  ).rejects.toThrow('vault_storage_unavailable');
  fs.chmodSync(f.roots.targetRoot + '/vault-storage.json', 0o644);
  expect(() => verifyVaultStorage(f.roots, f.inspect)).toThrow('vault_storage_unavailable');
});
