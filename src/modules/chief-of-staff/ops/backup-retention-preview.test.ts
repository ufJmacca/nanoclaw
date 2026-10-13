import { expect, it } from 'vitest';
import {
  backupRepositoryHost,
  backupSnapshotTags,
  parseBackupRetentionPreview,
  backupSnapshotInventory,
} from './backup-retention.js';
const owner = 'a'.repeat(64),
  kind = 'state' as const,
  operationId = '9f99d9b4-4dac-423a-956c-afd953993c2d';
const snapshot = (id: string) => ({
  id: id.repeat(64),
  hostname: backupRepositoryHost(owner),
  paths: ['/checkpoint.tar'],
  tags: backupSnapshotTags(owner, kind, operationId),
  time: '2026-10-11T03:30:00+11:00',
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const group = (keep = [snapshot('b')], remove = [snapshot('c')]) => ({
  tags: null,
  host: backupRepositoryHost(owner),
  paths: ['/checkpoint.tar'],
  keep,
  remove,
  reasons: [],
});
it('selects exact original IDs from the pinned policy preview and preserves unrelated inventory', () => {
  const inventory = backupSnapshotInventory(
    bytes([snapshot('b'), snapshot('c'), { id: 'd'.repeat(64), hostname: 'foreign' }]),
  );
  expect(parseBackupRetentionPreview(bytes([group()]), owner, kind, inventory)).toEqual({
    keep: ['b'.repeat(64)],
    remove: ['c'.repeat(64)],
  });
});
it('accepts the real empty-output form only when no matching snapshots exist', () => {
  expect(parseBackupRetentionPreview(Buffer.alloc(0), owner, kind, [])).toEqual({ keep: [], remove: [] });
  expect(() => parseBackupRetentionPreview(Buffer.alloc(0), owner, kind, [snapshot('b')])).toThrow(
    'backup_retention_unavailable',
  );
});
it.each(['foreign', 'path', 'mixed-kind', 'undeclared', 'missing', 'duplicate', 'empty-keep'] as const)(
  'denies %s removal plans before mutation',
  (reason) => {
    const preview = group(),
      inventory = [snapshot('b'), snapshot('c')];
    if (reason === 'foreign') preview.remove[0].tags[0] = 'cos-owner=' + 'f'.repeat(64);
    if (reason === 'path') preview.remove[0].paths = ['/unrelated'];
    if (reason === 'mixed-kind') preview.remove[0].tags.push('cos-kind=credentials');
    if (reason === 'undeclared') preview.remove[0].id = 'e'.repeat(64);
    if (reason === 'missing') preview.remove = [];
    if (reason === 'duplicate') preview.remove = preview.keep;
    if (reason === 'empty-keep') {
      preview.remove.push(...preview.keep);
      preview.keep = [];
    }
    expect(() => parseBackupRetentionPreview(bytes([preview]), owner, kind, inventory)).toThrow(
      'backup_retention_unavailable',
    );
  },
);
it('rejects ambiguous or unbounded repository inventories', () => {
  for (const value of [
    {},
    [snapshot('b'), snapshot('b')],
    [{ id: 'latest' }],
    Array.from({ length: 8193 }, () => snapshot('b')),
  ])
    expect(() => backupSnapshotInventory(bytes(value))).toThrow('backup_retention_unavailable');
});
