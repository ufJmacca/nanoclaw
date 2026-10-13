import path from 'node:path';
import { isIP } from 'node:net';
import { digest } from '../domain/contracts.js';
export const BACKUP_LIMITS = Object.freeze({
  staging: 512 * 1024 ** 2,
  cache: 128 * 1024 ** 2,
  credentials: 128 * 1024 ** 2,
  repository: 20 * 1024 ** 3,
  nasFreeFloor: 1024 ** 4,
  vaultReserve: 2 * 1024 ** 2,
});
export type BackupKind = 'state' | 'credentials';
export type BackupMountBinding = { host: string; share: 'nanoclaw-cos-backups'; mount: string };
export type BackupCapacity = {
  staging: number;
  cache: number;
  credentials: number;
  repository: number;
  nasFree: number;
  vaultFree: number;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Validate the actual kernel mount, rather than a configured fstab entry. No private endpoints enter the proof. */
export function verifySignedBackupMount(binding: BackupMountBinding, text: string) {
  try {
    if (
      !object(binding) ||
      Object.keys(binding).sort().join(',') !== 'host,mount,share' ||
      isIP(binding.host) !== 4 ||
      binding.share !== 'nanoclaw-cos-backups' ||
      !path.isAbsolute(binding.mount) ||
      path.resolve(binding.mount) !== binding.mount ||
      binding.mount === '/' ||
      /[\0\r\n]/.test(binding.mount) ||
      typeof text !== 'string' ||
      Buffer.byteLength(text) > 262144
    )
      throw Error('invalid_binding');
    const value: unknown = JSON.parse(text);
    if (!object(value) || !Array.isArray(value.filesystems) || value.filesystems.length !== 1)
      throw Error('missing_mount');
    const mount = value.filesystems[0];
    if (
      !object(mount) ||
      mount.target !== binding.mount ||
      mount.fstype !== 'cifs' ||
      mount.source !== '//' + binding.host + '/' + binding.share ||
      typeof mount.options !== 'string'
    )
      throw Error('wrong_mount');
    const options = new Map<string, string>();
    for (const option of mount.options.split(',')) {
      const index = option.indexOf('='),
        name = index < 0 ? option : option.slice(0, index);
      if (!/^[a-zA-Z0-9_:.-]+$/.test(name) || options.has(name)) throw Error('ambiguous_options');
      if (['password', 'pass', 'password2', 'pass2'].includes(name.toLowerCase())) throw Error('credential_in_options');
      options.set(name, index < 0 ? '' : option.slice(index + 1));
    }
    if (
      ['rw', 'nosuid', 'nodev', 'noexec', 'nodfs', 'soft'].some((name) => options.get(name) !== '') ||
      ['ro', 'suid', 'dev', 'exec', 'guest', 'multiuser', 'hard'].some((name) => options.has(name)) ||
      options.get('vers') !== '2.1' ||
      options.get('username') !== 'nanoclaw-cos-backup' ||
      options.get('addr') !== binding.host ||
      !(options.get('sec') === 'ntlmsspi' || (options.get('sec') === 'ntlmssp' && options.get('sign') === ''))
    )
      throw Error('unsafe_mount_options');
    return {
      status: 'verified' as const,
      protocol: 'SMB2.1' as const,
      signing: 'required' as const,
      bindingDigest: digest(binding),
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Kernel diagnostics and configured NAS paths are private.
    throw Error('backup_mount_unverified');
  }
}
/** Local capture remains available during a NAS outage. Remote admission additionally reserves encrypted upload growth. */
export function admitBackupCapacity(
  usage: BackupCapacity,
  snapshot: { kind: BackupKind; bytes: number },
  destination: 'local' | 'remote' = 'remote',
): void {
  const reject = (): never => {
    throw Error('backup_capacity_unavailable');
  };
  if (
    !object(usage) ||
    Object.keys(usage).sort().join(',') !== 'cache,credentials,nasFree,repository,staging,vaultFree' ||
    Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0) ||
    !object(snapshot) ||
    Object.keys(snapshot).sort().join(',') !== 'bytes,kind' ||
    !['state', 'credentials'].includes(snapshot.kind) ||
    !Number.isSafeInteger(snapshot.bytes) ||
    snapshot.bytes < 1 ||
    !['local', 'remote'].includes(destination)
  )
    return reject();
  for (const key of ['staging', 'cache', 'credentials', 'repository'] as const)
    if (usage[key] > BACKUP_LIMITS[key]) return reject();
  const area = snapshot.kind === 'state' ? 'staging' : 'credentials';
  if (snapshot.bytes > BACKUP_LIMITS[area]) return reject();
  if (
    destination === 'local' &&
    (usage[area] + snapshot.bytes > BACKUP_LIMITS[area] ||
      usage.vaultFree < snapshot.bytes + BACKUP_LIMITS.vaultReserve)
  )
    return reject();
  // Restic packs, indexes and encrypted metadata require headroom beyond source byte counts.
  const remoteReserve = snapshot.bytes * 2 + 4 * 1024 ** 2;
  if (
    destination === 'remote' &&
    (usage.repository + remoteReserve > BACKUP_LIMITS.repository ||
      usage.nasFree - remoteReserve < BACKUP_LIMITS.nasFreeFloor)
  )
    return reject();
}
