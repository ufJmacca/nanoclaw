import path from 'node:path';
import { isIP } from 'node:net';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import type { BackupMountBinding } from './backup-policy.js';
export type BackupRepositoryProfile = {
  contract: 'cos-backup-repository/v1';
  rootsDigest: string;
  filesystemUuid: string;
  repositoryId: string;
  mount: BackupMountBinding;
};
/** Shared structural check only. Actual vault, target, repository and caller
 * authority remain mandatory at each use. Never contacts the NAS. */
export function validateBackupRepositoryProfile(
  value: BackupRepositoryProfile,
  roots: CalendarStorageRoots,
  filesystemUuid: string,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'contract,filesystemUuid,mount,repositoryId,rootsDigest' ||
    value.contract !== 'cos-backup-repository/v1' ||
    value.rootsDigest !== digest(roots) ||
    value.filesystemUuid !== filesystemUuid ||
    typeof value.repositoryId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.repositoryId) ||
    !value.mount ||
    typeof value.mount !== 'object' ||
    Object.keys(value.mount).sort().join(',') !== 'host,mount,share' ||
    typeof value.mount.host !== 'string' ||
    isIP(value.mount.host) !== 4 ||
    value.mount.share !== 'nanoclaw-cos-backups' ||
    typeof value.mount.mount !== 'string' ||
    !path.isAbsolute(value.mount.mount) ||
    path.resolve(value.mount.mount) !== value.mount.mount ||
    value.mount.mount === '/' ||
    /[\0\r\n]/.test(value.mount.mount)
  )
    throw Error('invalid_backup_profile');
}
