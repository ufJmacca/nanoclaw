import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { backupRepositoryHost, backupSnapshotTags } from './backup-retention.js';
const f = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: f.spawn }));
import { BackupResticTransfer } from './backup-restic-transfer.js';
afterEach(() => vi.resetAllMocks());
const owner = 'a'.repeat(64),
  repo = 'd'.repeat(64);
function fixture() {
  const snapshot = (kind: 'state' | 'credentials', id: string) => ({
    id: id.repeat(64),
    hostname: backupRepositoryHost(owner),
    paths: ['/checkpoint.tar'],
    tags: backupSnapshotTags(owner, kind, '9f99d9b4-4dac-423a-956c-afd953993c2d'),
    time: '2026-10-11T03:30:00+11:00',
  });
  let inventory = [snapshot('state', 'b'), snapshot('state', 'c'), snapshot('credentials', 'e')];
  const events: string[][] = [],
    scope = vi.fn(),
    admit = vi.fn(async () => {});
  let response: ((args: string[]) => unknown) | undefined;
  f.spawn.mockImplementation((_file, args) => {
    const command = args.slice(7) as string[];
    events.push(command);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
    });
    queueMicrotask(() => {
      let value: unknown = response?.(command);
      if (value === undefined) {
        if (command[0] === 'cat') value = { version: 2, id: repo, chunker_polynomial: '3da3358b4dc173' };
        if (command[0] === 'snapshots') value = inventory;
        if (command[0] === 'forget' && command.includes('--dry-run')) {
          const kind = command.at(command.indexOf('--tag') + 1)!.endsWith('state') ? 'state' : 'credentials';
          const selected = inventory.filter((s) => s.tags.includes('cos-kind=' + kind));
          value = selected.length
            ? [
                {
                  tags: null,
                  host: backupRepositoryHost(owner),
                  paths: ['/checkpoint.tar'],
                  keep: selected.slice(0, 1),
                  remove: selected.slice(1),
                  reasons: [],
                },
              ]
            : undefined;
        } else if (command[0] === 'forget') inventory = inventory.filter((s) => !command.includes(s.id));
      }
      child.stdout.end(value === undefined ? '' : JSON.stringify(value));
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  });
  const transfer = new BackupResticTransfer({
    binary: { fd: 3, assertCurrent: scope } as never,
    password: { fd: 4, assertCurrent: scope } as never,
    repository: { fd: 5, assertCurrent: scope },
    cache: { fd: 6, assertCurrent: scope },
    writer: { assertCurrent: scope },
    repositoryId: repo,
    ownerDigest: owner,
    producer: () => {
      throw Error('must_not_capture');
    },
    admitUpload: async () => {
      throw Error('must_not_upload');
    },
  });
  return {
    transfer,
    events,
    admit,
    scope,
    respond: (fn: (args: string[]) => unknown) => {
      response = fn;
    },
  };
}
it('checks all data, deletes only validated preview IDs, prunes with a fixed budget, then verifies integrity', async () => {
  const x = fixture();
  expect(await x.transfer.maintain(x.admit)).toMatchObject({
    status: 'backup_repository_maintained',
    repositoryId: repo,
    state: { retained: 1, removed: 1 },
    credentials: { retained: 1, removed: 0 },
    integrity: 'verified',
  });
  expect(x.events.filter((args) => args[0] === 'check')).toEqual([
    ['check', '--read-data', '--with-cache'],
    ['check', '--read-data', '--with-cache'],
  ]);
  expect(x.events.find((args) => args[0] === 'forget' && !args.includes('--dry-run'))).toEqual([
    'forget',
    'c'.repeat(64),
  ]);
  expect(x.events.find((args) => args[0] === 'prune')).toEqual(['prune', '--max-repack-size', '16M']);
  expect(x.admit).toHaveBeenCalled();
});
it('does not delete anything when the preview cannot be authenticated against the fresh inventory', async () => {
  const x = fixture();
  x.respond((args) => (args.includes('--dry-run') ? [] : undefined));
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow('backup_maintenance_unavailable');
  expect(x.events.some((args) => args[0] === 'prune' || (args[0] === 'forget' && !args.includes('--dry-run')))).toBe(
    false,
  );
});
it('withdrawn caller capacity or permission stops before any repository mutation', async () => {
  const x = fixture();
  x.admit.mockRejectedValueOnce(Error('PRIVATE_PERMISSION_WITHDRAWN'));
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow(/^backup_maintenance_unavailable$/);
  expect(x.events).toEqual([]);
});
it('checks capacity again after the awaited repository identity command and before checking or changing data', async () => {
  const x = fixture();
  x.admit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('PRIVATE_CAPACITY_WITHDRAWN'));
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow(/^backup_maintenance_unavailable$/);
  expect(x.events).toEqual([['cat', 'config']]);
});
it('detects a repository change before deleting the next batch or pruning', async () => {
  const x = fixture();
  let lists = 0;
  x.respond((args) => {
    if (args[0] === 'snapshots' && ++lists === 2) return [];
  });
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow('backup_maintenance_unavailable');
  expect(x.events.some((args) => args[0] === 'prune' || (args[0] === 'forget' && !args.includes('--dry-run')))).toBe(
    false,
  );
});
