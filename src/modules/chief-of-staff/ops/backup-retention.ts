import type { BackupKind } from './backup-policy.js';
function identity(ownerDigest: string, kind?: BackupKind): void {
  if (!/^[a-f0-9]{64}$/.test(ownerDigest) || (kind !== undefined && !['state', 'credentials'].includes(kind)))
    throw Error('backup_retention_unavailable');
}
export function backupRepositoryHost(ownerDigest: string): string {
  identity(ownerDigest);
  return 'nanoclaw-cos-' + ownerDigest.slice(0, 16);
}
export function backupSnapshotTags(ownerDigest: string, kind: BackupKind, operationId: string): string[] {
  identity(ownerDigest, kind);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId))
    throw Error('backup_retention_unavailable');
  return ['cos-owner=' + ownerDigest, 'cos-kind=' + kind, 'cos-operation=' + operationId];
}
/** The uploader separately verifies the repository and writer lease. One comma-separated tag
 * selector requires both owner and kind. Operation tags must never split retention into singleton groups. */
export function backupRetentionArguments(ownerDigest: string, kind: BackupKind, mode: 'preview' | 'apply'): string[] {
  identity(ownerDigest, kind);
  if (!['preview', 'apply'].includes(mode)) throw Error('backup_retention_unavailable');
  return [
    'forget',
    ...(mode === 'preview' ? ['--dry-run'] : []),
    '--host',
    backupRepositoryHost(ownerDigest),
    '--tag',
    'cos-owner=' + ownerDigest + ',cos-kind=' + kind,
    '--group-by',
    'host,paths',
    '--keep-daily',
    '14',
    '--keep-weekly',
    '4',
  ];
}
