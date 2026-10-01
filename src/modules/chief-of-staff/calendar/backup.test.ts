import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { backupCalendarState, verifyCalendarBackup } from './backup.js';
import { configureCalendarStorage } from './storage-policy.js';
import type { StorageInspection } from './storage-protection.js';
const bases: string[] = [];
function setup(configured = true) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-calendar-backup-'));
  bases.push(base);
  const roots = { targetRoot: base + '/state', installationRoot: base + '/app', dataRoot: base + '/data' };
  const backupRoot = base + '/backups',
    receiptRoot = roots.targetRoot + '/operation';
  for (const directory of [roots.targetRoot, roots.installationRoot, roots.dataRoot, backupRoot, receiptRoot])
    fs.mkdirSync(directory, { mode: 0o700 });
  const inspect: StorageInspection = (command, args) =>
    JSON.stringify(
      command.endsWith('/findmnt')
        ? {
            filesystems: [
              {
                target: args[args.indexOf('--target') + 1],
                source: '/dev/mapper/private',
                fstype: 'ext4',
                'maj:min': '253:0',
                uuid: 'fixture-private-volume',
              },
            ],
          }
        : {
            blockdevices: [
              { name: '/dev/mapper/private', type: 'crypt', 'maj:min': '253:0', uuid: 'fixture-private-volume' },
            ],
          },
    );
  const source = roots.targetRoot + '/calendar';
  if (configured) {
    fs.mkdirSync(source, { mode: 0o700 });
    configureCalendarStorage(roots, backupRoot, inspect);
    for (const name of ['credentials', 'access-denials']) fs.mkdirSync(source + '/' + name, { mode: 0o700 });
    fs.writeFileSync(source + '/credentials/token.json', 'PRIVATE_TOKEN_CANARY', { mode: 0o600 });
    fs.writeFileSync(source + '/access-denials/denial.json', 'MONOTONIC_DENIAL_CANARY', { mode: 0o600 });
    fs.writeFileSync(source + '/access-denials/check.pending', 'UNCERTAIN_CHECK_CANARY', { mode: 0o600 });
    fs.writeFileSync(source + '/oauth-client.json', 'PRIVATE_CLIENT_CANARY', { mode: 0o600 });
  }
  const options = { roots, receiptRoot, operationId: 'release-fixture', check: vi.fn(async () => {}), inspect };
  return { base, roots, backupRoot, source, options };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const base of bases.splice(0)) fs.rmSync(base, { recursive: true, force: true });
});
it('records absent calendar state without creating configuration or needing encrypted storage', async () => {
  const f = setup(false);
  const receipt = await backupCalendarState(f.options);
  expect(receipt.present).toBe(false);
  expect(receipt.files).toBe(0);
  expect(fs.existsSync(f.source)).toBe(false);
  expect(await verifyCalendarBackup(f.options)).toEqual(receipt);
  fs.mkdirSync(f.source, { mode: 0o700 });
  await expect(verifyCalendarBackup(f.options)).rejects.toThrow('calendar_backup_unavailable');
});
it('copies credentials, client configuration and monotonic journals only into protected storage, with metadata-only receipts', async () => {
  const f = setup();
  const receipt = await backupCalendarState(f.options);
  expect(receipt.present).toBe(true);
  expect(receipt.files).toBe(4);
  const snapshot = path.join(f.backupRoot, receipt.snapshot!);
  expect(fs.readFileSync(snapshot + '/state/credentials/token.json', 'utf8')).toBe('PRIVATE_TOKEN_CANARY');
  expect(fs.readFileSync(snapshot + '/state/access-denials/check.pending', 'utf8')).toBe('UNCERTAIN_CHECK_CANARY');
  expect(fs.readFileSync(snapshot + '/state/access-denials/denial.json', 'utf8')).toBe('MONOTONIC_DENIAL_CANARY');
  expect(fs.statSync(snapshot + '/state/credentials/token.json').mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(f.options.receiptRoot)).toEqual(['calendar-backup.json']);
  expect(JSON.stringify(receipt)).not.toMatch(/CANARY|\/tmp\/|token\.json/);
  expect(await backupCalendarState(f.options)).toEqual(receipt);
  expect(await verifyCalendarBackup(f.options)).toEqual(receipt);
  expect(f.options.check).toHaveBeenCalled();
});
it('recovers a published snapshot after losing its local acknowledgement without rewriting token or denial bytes', async () => {
  const f = setup(),
    first = await backupCalendarState(f.options);
  const token = path.join(f.backupRoot, first.snapshot!, 'state/credentials/token.json');
  const inode = fs.statSync(token).ino;
  fs.unlinkSync(f.options.receiptRoot + '/calendar-backup.json');
  expect(await backupCalendarState(f.options)).toEqual(first);
  expect(fs.statSync(token).ino).toBe(inode);
});
it('renews backup-directory durability after an interrupted publication before acknowledging a retry', async () => {
  const f = setup(),
    sync = fs.fsyncSync;
  let failing = true;
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (failing && fs.readlinkSync('/proc/self/fd/' + fd) === f.backupRoot)
      throw new Error('fixture_directory_sync_failure');
    return sync(fd);
  });
  await expect(backupCalendarState(f.options)).rejects.toThrow('calendar_backup_unavailable');
  await expect(backupCalendarState(f.options)).rejects.toThrow('calendar_backup_unavailable');
  expect(fs.existsSync(f.options.receiptRoot + '/calendar-backup.json')).toBe(false);
  failing = false;
  expect((await backupCalendarState(f.options)).present).toBe(true);
});
it('detects backup tampering and lost storage protection without repairing or restoring anything', async () => {
  const f = setup(),
    first = await backupCalendarState(f.options);
  const token = path.join(f.backupRoot, first.snapshot!, 'state/credentials/token.json');
  fs.writeFileSync(token, 'tampered');
  await expect(verifyCalendarBackup(f.options)).rejects.toThrow('calendar_backup_unavailable');
  expect(fs.readFileSync(f.source + '/credentials/token.json', 'utf8')).toBe('PRIVATE_TOKEN_CANARY');
  fs.writeFileSync(token, 'PRIVATE_TOKEN_CANARY');
  fs.unlinkSync(f.backupRoot + '/.cos-calendar-backups');
  await expect(verifyCalendarBackup(f.options)).rejects.toThrow('calendar_backup_unavailable');
  expect(fs.existsSync(f.backupRoot + '/.cos-calendar-backups')).toBe(false);
});
it('refuses a backup state directory replaced by a symlink even when its bytes still match', async () => {
  const f = setup(),
    receipt = await backupCalendarState(f.options);
  const state = path.join(f.backupRoot, receipt.snapshot!, 'state');
  fs.renameSync(state, f.base + '/moved-backup');
  fs.symlinkSync(f.base + '/moved-backup', state);
  await expect(verifyCalendarBackup(f.options)).rejects.toThrow('calendar_backup_unavailable');
});
it('pins the encrypted destination so replacement cannot redirect secret writes into a fallback directory', async () => {
  const f = setup(),
    read = fs.readSync;
  let replaced = false;
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...args: unknown[]) => {
    if (!replaced && fs.readlinkSync('/proc/self/fd/' + fd) === f.source + '/credentials/token.json') {
      replaced = true;
      fs.renameSync(f.backupRoot, f.backupRoot + '-old');
      fs.mkdirSync(f.backupRoot, { mode: 0o700 });
    }
    return Reflect.apply(read, fs, [fd, ...args]);
  }) as typeof fs.readSync);
  await expect(backupCalendarState(f.options)).rejects.toThrow('calendar_backup_unavailable');
  expect(replaced).toBe(true);
  expect(fs.readdirSync(f.backupRoot)).toEqual([]);
  expect(fs.existsSync(f.options.receiptRoot + '/calendar-backup.json')).toBe(false);
});
it.each(['symlink', 'hardlink', 'permissions', 'missing-policy'])(
  'refuses unsafe source state before publishing a backup: %s',
  async (kind) => {
    const f = setup();
    if (kind === 'symlink') fs.symlinkSync(f.base, f.source + '/linked');
    if (kind === 'hardlink') fs.linkSync(f.source + '/credentials/token.json', f.source + '/alias');
    if (kind === 'permissions') fs.chmodSync(f.source + '/credentials/token.json', 0o644);
    if (kind === 'missing-policy') fs.unlinkSync(f.roots.targetRoot + '/calendar-storage.json');
    await expect(backupCalendarState(f.options)).rejects.toThrow('calendar_backup_unavailable');
    expect(fs.existsSync(f.options.receiptRoot + '/calendar-backup.json')).toBe(false);
  },
);
it('refuses a changed operation identity, active writer or unowned receipt destination', async () => {
  const f = setup();
  await backupCalendarState(f.options);
  await expect(verifyCalendarBackup({ ...f.options, operationId: 'different-release' })).rejects.toThrow(
    'calendar_backup_unavailable',
  );
  await expect(
    backupCalendarState({
      ...f.options,
      check: async () => {
        throw new Error('PRIVATE_AUTHORITY_CANARY');
      },
    }),
  ).rejects.toThrow('calendar_backup_unavailable');
  await expect(backupCalendarState({ ...f.options, receiptRoot: f.base })).rejects.toThrow(
    'calendar_backup_unavailable',
  );
});
