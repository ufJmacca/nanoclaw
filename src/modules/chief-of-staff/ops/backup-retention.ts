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

type SnapshotMetadata = Record<string, unknown> & { id: string };
const hex = /^[a-f0-9]{64}$/;
function inventory(value: unknown): SnapshotMetadata[] {
  if (
    !Array.isArray(value) ||
    value.length > 8192 ||
    value.some(
      (snapshot) =>
        !snapshot ||
        typeof snapshot !== 'object' ||
        Array.isArray(snapshot) ||
        typeof snapshot.id !== 'string' ||
        !hex.test(snapshot.id),
    ) ||
    new Set(value.map((snapshot) => snapshot.id)).size !== value.length
  )
    throw Error('backup_retention_unavailable');
  return structuredClone(value);
}
/** Inventory metadata selects original snapshot identities, never source or
 * restore authority. The caller still needs fresh repository/owner scopes. */
export function backupSnapshotInventory(bytes: Buffer): SnapshotMetadata[] {
  try {
    if (bytes.length > 8 * 1024 ** 2) throw Error('inventory_bounds');
    return inventory(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Snapshot metadata stays private.
    throw Error('backup_retention_unavailable');
  }
}
function owned(snapshot: SnapshotMetadata, owner: string, kind: BackupKind) {
  const tags = snapshot.tags,
    operation = Array.isArray(tags)
      ? tags.find((tag) => typeof tag === 'string' && tag.startsWith('cos-operation='))
      : undefined;
  if (
    snapshot.hostname !== backupRepositoryHost(owner) ||
    !Array.isArray(snapshot.paths) ||
    snapshot.paths.length !== 1 ||
    snapshot.paths[0] !== '/checkpoint.tar' ||
    !Array.isArray(tags) ||
    tags.length !== 3 ||
    typeof operation !== 'string' ||
    !/^cos-operation=[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operation) ||
    new Set(tags).size !== 3 ||
    !tags.includes('cos-owner=' + owner) ||
    !tags.includes('cos-kind=' + kind) ||
    typeof snapshot.time !== 'string' ||
    snapshot.time.length > 40 ||
    !Number.isFinite(Date.parse(snapshot.time))
  )
    throw Error('backup_retention_unavailable');
  return JSON.stringify({
    id: snapshot.id,
    hostname: snapshot.hostname,
    paths: snapshot.paths,
    tags: [...tags].sort(),
    time: snapshot.time,
  });
}
/** Restic 0.19.1 forget --dry-run supplies the policy decision. Validate every
 * selected identity against a fresh inventory before any explicit-ID deletion;
 * changing operation tags never split the daily/weekly groups. */
export function parseBackupRetentionPreview(
  bytes: Buffer,
  owner: string,
  kind: BackupKind,
  current: SnapshotMetadata[],
): { keep: string[]; remove: string[] } {
  try {
    identity(owner, kind);
    if (bytes.length > 8 * 1024 ** 2) throw Error('preview_bounds');
    const selected = new Map(
        inventory(current)
          .filter(
            (snapshot) =>
              snapshot.hostname === backupRepositoryHost(owner) &&
              Array.isArray(snapshot.tags) &&
              snapshot.tags.includes('cos-owner=' + owner) &&
              snapshot.tags.includes('cos-kind=' + kind),
          )
          .map((snapshot) => [snapshot.id, owned(snapshot, owner, kind)]),
      ),
      groups: unknown = bytes.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : [],
      keep: string[] = [],
      remove: string[] = [],
      seen = new Set<string>();
    if (!Array.isArray(groups) || groups.length > 1) throw Error('preview_groups');
    for (const group of groups) {
      if (
        !group ||
        typeof group !== 'object' ||
        Array.isArray(group) ||
        Object.keys(group).sort().join(',') !== 'host,keep,paths,reasons,remove,tags' ||
        group.host !== backupRepositoryHost(owner) ||
        !Array.isArray(group.paths) ||
        group.paths.length !== 1 ||
        group.paths[0] !== '/checkpoint.tar' ||
        (group.tags !== null && (!Array.isArray(group.tags) || group.tags.length)) ||
        (group.reasons !== null && !Array.isArray(group.reasons))
      )
        throw Error('preview_group');
      for (const [name, destination] of [
        ['keep', keep],
        ['remove', remove],
      ] as const) {
        const snapshots = inventory(group[name] ?? []);
        for (const snapshot of snapshots) {
          if (seen.has(snapshot.id) || selected.get(snapshot.id) !== owned(snapshot, owner, kind))
            throw Error('preview_identity');
          seen.add(snapshot.id);
          destination.push(snapshot.id);
        }
      }
    }
    if (seen.size !== selected.size || (selected.size > 0 && keep.length === 0) || keep.length > 18)
      throw Error('preview_incomplete');
    return { keep: keep.sort(), remove: remove.sort() };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- An unknown preview cannot authorize deletion.
    throw Error('backup_retention_unavailable');
  }
}
