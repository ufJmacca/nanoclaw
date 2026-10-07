import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
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
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
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
