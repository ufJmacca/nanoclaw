import { expect, it } from 'vitest';
import { backupNasMountCommand, backupNasMountService } from './backup-nas-units.js';
import { verifySignedBackupMount } from './backup-policy.js';
const input = { host: '192.168.56.12', userId: 1000, groupId: 1000 };
it('opens the dedicated signed share using only inherited credential descriptor 3', () => {
  const command = backupNasMountCommand(input);
  expect(Object.isFrozen(command)).toBe(true);
  expect(Object.isFrozen(command.args)).toBe(true);
  expect(command.command).toBe('/usr/sbin/mount.cifs');
  expect(command.args.slice(0, 3)).toEqual(['//192.168.56.12/nanoclaw-cos-backups', '/var/lib/nanoclaw-cos/nas', '-o']);
  const options = command.args[3].split(',');
  for (const option of [
    'rw',
    'credentials=/proc/self/fd/3',
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
    expect(options).toContain(option);
  expect(command.args.join(' ')).not.toMatch(/vault\/backup-credentials|password=/);
});
it('uses command options compatible with independent signed-kernel-mount admission', () => {
  const options = backupNasMountCommand(input).args[3] + ',username=nanoclaw-cos-backup,addr=' + input.host;
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
it('runs the sealed helper on demand under scoped memory controls, independently of the owner runtime', () => {
  const service = backupNasMountService({ artifactDigest: 'a'.repeat(64) });
  expect(service.name).toBe('nanoclaw-cos-backup-mount.service');
  expect(service.contents).toContain('Type=oneshot');
  expect(service.contents).toContain('RemainAfterExit=yes');
  expect(service.contents).toContain(
    'ExecStart=/opt/nanoclaw-cos/vault/' +
      'a'.repeat(64) +
      '/node /opt/nanoclaw-cos/vault/' +
      'a'.repeat(64) +
      '/gateway.mjs --backup-mount',
  );
  expect(service.contents).toContain(
    'ExecStop=/opt/nanoclaw-cos/vault/' +
      'a'.repeat(64) +
      '/node /opt/nanoclaw-cos/vault/' +
      'a'.repeat(64) +
      '/gateway.mjs --backup-unmount',
  );
  expect(service.contents).toContain('BindsTo=var-lib-nanoclaw\\x2dcos-vault.mount');
  expect(service.contents).toContain('After=network-online.target var-lib-nanoclaw\\x2dcos-vault.mount');
  expect(service.contents).toContain('ConditionPathIsMountPoint=/var/lib/nanoclaw-cos/vault');
  for (const setting of [
    'LimitCORE=0',
    'MemorySwapMax=0',
    'UMask=0077',
    'TimeoutStartSec=30s',
    'TimeoutStopSec=10s',
    'KillMode=control-group',
    'StandardOutput=null',
    'StandardError=null',
  ])
    expect(service.contents).toContain(setting);
  expect(service.contents).not.toMatch(
    /\[Install\]|\[Mount\]|WantedBy=|RequiredBy=|user@|nanoclaw-v2|google|swapoff|sysctl|password=|sudoers|fstab|credentials=/i,
  );
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
])('refuses unadmitted mount command input %j', (patch) => {
  expect(() => backupNasMountCommand({ ...input, ...patch })).toThrow(/^backup_nas_unit_unavailable$/);
});
it.each([
  { artifactDigest: 'foreign' },
  { artifactDigest: 'a'.repeat(64) + '\nExecStart=/bin/sh' },
  { artifactDigest: 'A'.repeat(64) },
  { artifactDigest: 'a'.repeat(64), host: '192.168.56.12' },
  { artifactDigest: 'a'.repeat(64), credentials: '/tmp/password' },
  { artifactDigest: 'a'.repeat(64), command: '/bin/sh' },
])('refuses an unsealed service selector %j', (input) => {
  expect(() => backupNasMountService(input)).toThrow(/^backup_nas_unit_unavailable$/);
});
