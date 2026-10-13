import { expect, it } from 'vitest';
import { backupRetentionArguments, backupSnapshotTags, backupRepositoryHost } from './backup-retention.js';

const owner = 'a'.repeat(64),
  operationId = '9f99d9b4-4dac-423a-956c-afd953993c2d';
it.each(['state', 'credentials'] as const)(
  'selects only the exact owner and %s kind while grouping changing operation tags together',
  (kind) => {
    const args = backupRetentionArguments(owner, kind, 'preview');
    expect(args).toEqual([
      'forget',
      '--dry-run',
      '--host',
      backupRepositoryHost(owner),
      '--tag',
      'cos-owner=' + owner + ',cos-kind=' + kind,
      '--group-by',
      'host,paths',
      '--keep-daily',
      '14',
      '--keep-weekly',
      '4',
    ]);
    expect(args).not.toContain('host,tags');
    expect(args.filter((arg) => arg === '--tag')).toHaveLength(1);
  },
);
it('requires an explicit application mode and keeps the same bounded namespace filter', () => {
  expect(backupRetentionArguments(owner, 'state', 'apply')).toEqual(
    backupRetentionArguments(owner, 'state', 'preview').filter((arg) => arg !== '--dry-run'),
  );
  expect(() => backupRetentionArguments(owner, 'state', 'all' as never)).toThrow(/^backup_retention_unavailable$/);
});
it('tags checkpoints with one kind, owner and stable operation without accepting injected selectors', () => {
  expect(backupSnapshotTags(owner, 'credentials', operationId)).toEqual([
    'cos-owner=' + owner,
    'cos-kind=credentials',
    'cos-operation=' + operationId,
  ]);
  expect(() => backupSnapshotTags(owner, 'state', 'x,cos-owner=other')).toThrow(/^backup_retention_unavailable$/);
  expect(() => backupRetentionArguments(owner + ',other', 'state', 'apply')).toThrow(/^backup_retention_unavailable$/);
  expect(() => backupRetentionArguments(owner, 'state,credentials' as never, 'apply')).toThrow(
    /^backup_retention_unavailable$/,
  );
});
