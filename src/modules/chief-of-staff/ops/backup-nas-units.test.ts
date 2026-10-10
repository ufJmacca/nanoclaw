import { expect, it } from 'vitest';
import { backupNasMountUnit } from './backup-nas-units.js';
import { verifySignedBackupMount } from './backup-policy.js';
const input = { host: '192.168.56.12', userId: 1000, groupId: 1000 };
it('mounts only the dedicated share with mandatory SMB2.1 signing and vault credentials', () => {
  const unit = backupNasMountUnit(input);
  expect(unit.name).toBe('var-lib-nanoclaw\\x2dcos-nas.mount');
  expect(unit.contents).toContain('What=//192.168.56.12/nanoclaw-cos-backups');
  expect(unit.contents).toContain('Where=/var/lib/nanoclaw-cos/nas');
  expect(unit.contents).toContain('Type=cifs');
  expect(unit.contents).toContain('credentials=/var/lib/nanoclaw-cos/vault/backup-credentials/smb-credentials');
  for (const option of [
    'rw',
    'vers=2.1',
    'sec=ntlmsspi',
    'uid=1000',
    'gid=1000',
    'forceuid',
    'forcegid',
    'file_mode=0600',
    'dir_mode=0700',
    'nosuid',
    'nodev',
    'noexec',
    'nodfs',
    'soft',
  ])
    expect(unit.contents.match(/^Options=(.*)$/m)?.[1].split(',')).toContain(option);
  expect(unit.contents).toContain('LimitCORE=0');
  expect(unit.contents).toContain('MemorySwapMax=0');
  expect(unit.contents).toContain('DirectoryMode=0000');
  expect(unit.contents).toContain('TimeoutSec=20s');
});
it('requires live credential/vault admission and confines NAS failures to on-demand backup mounting', () => {
  const { contents } = backupNasMountUnit(input);
  expect(contents).toContain('Requires=nanoclaw-cos-backup-mount-admission.service');
  expect(contents).toContain('BindsTo=var-lib-nanoclaw\\x2dcos-vault.mount');
  expect(contents).toContain(
    'After=network-online.target var-lib-nanoclaw\\x2dcos-vault.mount nanoclaw-cos-backup-mount-admission.service',
  );
  expect(contents).not.toMatch(
    /\[Install\]|WantedBy=|RequiredBy=|user@|nanoclaw-v2|google|swapoff|sysctl|password=|sudoers|fstab/i,
  );
  expect(contents).toContain('StandardOutput=null');
  expect(contents).toContain('StandardError=null');
});
it('produces mount options compatible with the independent existing signed-mount admission policy', () => {
  const { contents } = backupNasMountUnit(input);
  const options = contents.match(/^Options=(.*)$/m)![1] + ',username=nanoclaw-cos-backup,addr=' + input.host;
  expect(
    verifySignedBackupMount(
      { host: input.host, share: 'nanoclaw-cos-backups', mount: '/var/lib/nanoclaw-cos/nas' },
      JSON.stringify({
        filesystems: [
          {
            target: '/var/lib/nanoclaw-cos/nas',
            source: '//' + input.host + '/nanoclaw-cos-backups',
            fstype: 'cifs',
            options,
          },
        ],
      }),
    ),
  ).toMatchObject({ status: 'verified', protocol: 'SMB2.1', signing: 'required' });
});
it.each([
  { host: '192.168.56.12\nOptions=guest' },
  { host: 'example.com' },
  { host: '2001:db8::1' },
  { host: '8.8.8.8' },
  { host: '127.0.0.1' },
  { host: '169.254.1.1' },
  { userId: 0 },
  { groupId: 0 },
  { userId: NaN },
  { groupId: 1.5 },
  { userId: 2147483648 },
  { options: 'guest' },
  { mount: '/tmp/override' },
  { share: 'homes' },
  { password: 'PRIVATE_VALUE' },
])('refuses an unsafe or unadmitted unit input %j', (patch) => {
  expect(() => backupNasMountUnit({ ...input, ...patch })).toThrow(/^backup_nas_unit_unavailable$/);
});
