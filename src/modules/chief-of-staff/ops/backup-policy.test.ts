import { expect, it } from 'vitest';
import { BACKUP_LIMITS, admitBackupCapacity, verifySignedBackupMount } from './backup-policy.js';
const binding = { host: '192.0.2.10', share: 'nanoclaw-cos-backups' as const, mount: '/var/lib/nanoclaw-cos/nas' };
const mount = () => ({
  filesystems: [
    {
      target: binding.mount,
      source: '//' + binding.host + '/' + binding.share,
      fstype: 'cifs',
      options:
        'rw,nosuid,nodev,noexec,vers=2.1,sec=ntlmssp,sign,soft,nodfs,username=nanoclaw-cos-backup,addr=192.0.2.10',
    },
  ],
});
it('accepts only the exact dedicated mounted share with mandatory signing and SMB2.1', () => {
  expect(verifySignedBackupMount(binding, JSON.stringify(mount()))).toMatchObject({
    status: 'verified',
    protocol: 'SMB2.1',
    signing: 'required',
  });
});
it.each([
  'missing',
  'underlay',
  'unsigned',
  'downgraded',
  'wrong-host',
  'wrong-share',
  'admin',
  'wrong-target',
  'read-only',
  'dfs',
  'unsafe',
  'duplicate',
  'ambiguous',
  'password',
  'huge',
  'malformed',
])('denies %s with a fixed redacted error', (reason) => {
  const value = mount(),
    item = value.filesystems[0];
  if (reason === 'missing') value.filesystems = [];
  if (reason === 'underlay') item.fstype = 'ext4';
  if (reason === 'unsigned') item.options = item.options.replace(',sign,', ',');
  if (reason === 'downgraded') item.options = item.options.replace('vers=2.1', 'vers=2.0');
  if (reason === 'wrong-host') item.source = '//192.0.2.11/' + binding.share;
  if (reason === 'wrong-share') item.source = '//' + binding.host + '/unrelated';
  if (reason === 'admin') item.options = item.options.replace('username=nanoclaw-cos-backup', 'username=admin');
  if (reason === 'wrong-target') item.target += '/subdirectory';
  if (reason === 'read-only') item.options = item.options.replace('rw,', 'ro,');
  if (reason === 'dfs') item.options = item.options.replace(',nodfs,', ',');
  if (reason === 'unsafe') item.options = item.options.replace(',noexec,', ',exec,');
  if (reason === 'duplicate') item.options += ',vers=2.0';
  if (reason === 'ambiguous') value.filesystems.push({ ...item });
  if (reason === 'password') item.options += ',password=PRIVATE_SENTINEL';
  const text =
    reason === 'huge' ? 'x'.repeat(262145) : reason === 'malformed' ? '{PRIVATE_SENTINEL' : JSON.stringify(value);
  expect(() => verifySignedBackupMount(binding, text)).toThrow(/^backup_mount_unverified$/);
});
it('binds the resolved server address too and accepts the kernel ntlmsspi spelling', () => {
  const value = mount();
  value.filesystems[0].options = value.filesystems[0].options.replace('sec=ntlmssp,sign', 'sec=ntlmsspi');
  expect(verifySignedBackupMount(binding, JSON.stringify(value)).signing).toBe('required');
  value.filesystems[0].options = value.filesystems[0].options.replace('addr=192.0.2.10', 'addr=192.0.2.11');
  expect(() => verifySignedBackupMount(binding, JSON.stringify(value))).toThrow(/^backup_mount_unverified$/);
});
const capacity = () => ({
  staging: 0,
  cache: 0,
  credentials: 0,
  repository: 0,
  nasFree: 2 * 1024 ** 4,
  vaultFree: 1024 ** 3,
});
it('enforces the agreed vault, repository and free-space limits before allocating or uploading', () => {
  expect(BACKUP_LIMITS).toMatchObject({
    staging: 512 * 1024 ** 2,
    cache: 128 * 1024 ** 2,
    credentials: 128 * 1024 ** 2,
    repository: 20 * 1024 ** 3,
    nasFreeFloor: 1024 ** 4,
  });
  expect(admitBackupCapacity(capacity(), { kind: 'state', bytes: 512 * 1024 ** 2 })).toBeUndefined();
  expect(admitBackupCapacity(capacity(), { kind: 'credentials', bytes: 128 * 1024 ** 2 })).toBeUndefined();
});
it.each([
  'staging',
  'cache',
  'credentials',
  'repository',
  'nasFree',
  'vaultFree',
  'negative',
  'fraction',
  'unknown',
  'overflow',
])('denies exhausted or malformed %s capacity', (reason) => {
  const usage = capacity();
  if (['staging', 'cache', 'credentials', 'repository'].includes(reason))
    usage[reason as 'staging'] = BACKUP_LIMITS[reason as 'staging'] + 1;
  if (reason === 'nasFree') usage.nasFree = BACKUP_LIMITS.nasFreeFloor;
  if (reason === 'vaultFree') usage.vaultFree = 0;
  if (reason === 'negative') usage.staging = -1;
  if (reason === 'fraction') usage.cache = 0.5;
  if (reason === 'overflow') usage.repository = Number.MAX_SAFE_INTEGER + 1;
  if (reason === 'unknown') Object.assign(usage, { plaintextFallback: true });
  expect(() =>
    admitBackupCapacity(usage, { kind: 'state', bytes: 1024 }, reason === 'vaultFree' ? 'local' : 'remote'),
  ).toThrow(/^backup_capacity_unavailable$/);
});
it('reserves upload expansion against the repository cap and NAS free-space floor', () => {
  const usage = capacity();
  usage.repository = BACKUP_LIMITS.repository - 1024;
  expect(() => admitBackupCapacity(usage, { kind: 'state', bytes: 1024 })).toThrow(/^backup_capacity_unavailable$/);
  usage.repository = 0;
  usage.nasFree = BACKUP_LIMITS.nasFreeFloor + 1024;
  expect(() => admitBackupCapacity(usage, { kind: 'credentials', bytes: 1024 })).toThrow(
    /^backup_capacity_unavailable$/,
  );
});
it('admits bounded local capture while the NAS is unavailable', () => {
  const usage = capacity();
  usage.nasFree = 0;
  expect(admitBackupCapacity(usage, { kind: 'state', bytes: 1024 }, 'local')).toBeUndefined();
  expect(() => admitBackupCapacity(usage, { kind: 'state', bytes: 1024 }, 'remote')).toThrow(
    /^backup_capacity_unavailable$/,
  );
});
it('can upload a queued full checkpoint without reserving its local bytes a second time', () => {
  const usage = capacity();
  usage.staging = BACKUP_LIMITS.staging;
  usage.vaultFree = BACKUP_LIMITS.vaultReserve;
  expect(admitBackupCapacity(usage, { kind: 'state', bytes: BACKUP_LIMITS.staging }, 'remote')).toBeUndefined();
  expect(() => admitBackupCapacity(usage, { kind: 'state', bytes: 1 }, 'local')).toThrow(
    /^backup_capacity_unavailable$/,
  );
});
