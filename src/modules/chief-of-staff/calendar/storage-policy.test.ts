import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configureCalendarStorage, verifyCalendarStorage } from './storage-policy.js';
import type { StorageInspection } from './storage-protection.js';
const bases: string[] = [];
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-calendar-storage-policy-'));
  bases.push(base);
  const roots = { targetRoot: base + '/state', installationRoot: base + '/app', dataRoot: base + '/data' };
  const backupRoot = base + '/backup';
  for (const root of [roots.targetRoot, roots.installationRoot, roots.dataRoot, backupRoot])
    fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(roots.targetRoot + '/calendar', { mode: 0o700 });
  const state = { encrypted: true, uuid: '11111111-2222-4333-8444-555555555555', calls: 0 };
  const inspect: StorageInspection = (command, args) => {
    state.calls++;
    return JSON.stringify(
      command.endsWith('/findmnt')
        ? {
            filesystems: [
              {
                target: args[args.indexOf('--target') + 1],
                source: '/dev/mapper/private',
                fstype: 'ext4',
                'maj:min': '253:0',
                uuid: state.uuid,
              },
            ],
          }
        : {
            blockdevices: [
              {
                name: '/dev/mapper/private',
                type: state.encrypted ? 'crypt' : 'part',
                'maj:min': '253:0',
                uuid: state.uuid,
              },
            ],
          },
    );
  };
  return { base, roots, backupRoot, state, inspect };
}
afterEach(() => {
  for (const base of bases.splice(0)) fs.rmSync(base, { recursive: true, force: true });
});
it('records matching verified storage and backup ownership; replay preserves the same policy', () => {
  const f = setup();
  const first = configureCalendarStorage(f.roots, f.backupRoot, f.inspect);
  expect(first.contract).toBe('cos-calendar-storage/v1');
  expect(first.backupRoot).toBe(f.backupRoot);
  expect(verifyCalendarStorage(f.roots, f.inspect)).toEqual(first);
  expect(configureCalendarStorage(f.roots, f.backupRoot, f.inspect)).toEqual(first);
  expect(fs.statSync(f.roots.targetRoot + '/calendar-storage.json').mode & 0o777).toBe(0o600);
  expect(fs.statSync(f.backupRoot + '/.cos-calendar-backups').mode & 0o777).toBe(0o600);
});
it('does not replace the configured filesystem, backup destination or lost backup ownership marker', () => {
  const f = setup();
  configureCalendarStorage(f.roots, f.backupRoot, f.inspect);
  f.state.uuid = '22222222-3333-4444-8555-666666666666';
  expect(() => verifyCalendarStorage(f.roots, f.inspect)).toThrow('calendar_storage_policy_unavailable');
  expect(() => configureCalendarStorage(f.roots, f.backupRoot, f.inspect)).toThrow(
    'calendar_storage_policy_unavailable',
  );
  f.state.uuid = '11111111-2222-4333-8444-555555555555';
  const another = f.base + '/another';
  fs.mkdirSync(another, { mode: 0o700 });
  expect(() => configureCalendarStorage(f.roots, another, f.inspect)).toThrow('calendar_storage_policy_unavailable');
  expect(fs.readdirSync(another)).toEqual([]);
  fs.unlinkSync(f.backupRoot + '/.cos-calendar-backups');
  expect(() => configureCalendarStorage(f.roots, f.backupRoot, f.inspect)).toThrow(
    'calendar_storage_policy_unavailable',
  );
  expect(fs.readdirSync(f.backupRoot)).toEqual([]);
});
it('refuses unverified storage and an unknown nonempty backup directory without publishing configuration', () => {
  const f = setup();
  f.state.encrypted = false;
  expect(() => configureCalendarStorage(f.roots, f.backupRoot, f.inspect)).toThrow(
    'calendar_storage_policy_unavailable',
  );
  expect(fs.existsSync(f.roots.targetRoot + '/calendar-storage.json')).toBe(false);
  expect(fs.readdirSync(f.backupRoot)).toEqual([]);
  f.state.encrypted = true;
  fs.writeFileSync(f.backupRoot + '/unowned', 'preserve', { mode: 0o600 });
  expect(() => configureCalendarStorage(f.roots, f.backupRoot, f.inspect)).toThrow(
    'calendar_storage_policy_unavailable',
  );
  expect(fs.readFileSync(f.backupRoot + '/unowned', 'utf8')).toBe('preserve');
});
it('rejects overlapping runtime roots, backup trees, links and exposed or forged policies', () => {
  const f = setup();
  for (const root of [f.roots.targetRoot, f.roots.targetRoot + '/calendar', f.roots.installationRoot, f.roots.dataRoot])
    expect(() => configureCalendarStorage(f.roots, root, f.inspect)).toThrow('calendar_storage_policy_unavailable');
  configureCalendarStorage(f.roots, f.backupRoot, f.inspect);
  const policy = f.roots.targetRoot + '/calendar-storage.json';
  fs.chmodSync(policy, 0o644);
  expect(() => verifyCalendarStorage(f.roots, f.inspect)).toThrow('calendar_storage_policy_unavailable');
  fs.chmodSync(policy, 0o600);
  const value = JSON.parse(fs.readFileSync(policy, 'utf8'));
  value.extra = 'PRIVATE_POLICY_CANARY';
  fs.writeFileSync(policy, JSON.stringify(value));
  expect(() => verifyCalendarStorage(f.roots, f.inspect)).toThrow('calendar_storage_policy_unavailable');
});
