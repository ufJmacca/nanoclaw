import { expect, it } from 'vitest';
import { vaultUnits } from './vault-units.js';
const input = {
  userId: 1000,
  service: 'nanoclaw-fixture.service',
  calendarRoot: '/home/fixture/.config/nanoclaw-cos/state/calendar',
};
it('orders automatic unlock, ext4 and the real Calendar bind before cold-start owner services', () => {
  const units = vaultUnits(input);
  const unlock = units['nanoclaw-cos-vault.service'];
  const mountName = 'var-lib-nanoclaw\\x2dcos-vault.mount';
  const bindName = 'home-fixture-.config-nanoclaw\\x2dcos-state-calendar.mount';
  expect(unlock).toContain('cryptsetup open --type luks2');
  expect(unlock).toContain('--key-file /etc/nanoclaw-cos/vault.key');
  expect(unlock).toContain('ExecStartPost=/usr/bin/chmod 0600 /dev/mapper/nanoclaw-cos-vault');
  expect(units[mountName]).toContain('BindsTo=nanoclaw-cos-vault.service');
  expect(units[mountName]).toContain('What=/dev/mapper/nanoclaw-cos-vault');
  expect(units[mountName]).toContain('Where=/var/lib/nanoclaw-cos/vault');
  expect(units[mountName]).toContain('Type=ext4');
  expect(units[mountName]).toContain('DirectoryMode=0000');
  expect(units[bindName]).toContain('What=/var/lib/nanoclaw-cos/vault/google/calendar');
  expect(units[bindName]).toContain('Options=bind,nosuid,nodev,noexec');
  expect(units[bindName]).toContain('Before=user@1000.service');
  expect(units[bindName]).toContain('BindsTo=' + mountName);
  expect(units['owner-service.conf']).toContain('LimitCORE=0');
  expect(units['owner-service.conf']).toContain('MemorySwapMax=0');
  expect(Object.values(units).join('\n')).not.toMatch(/swapoff|swapon|sysctl|chmod.*777|sudoers|Requires=user@/);
});
it.each([
  { userId: 0 },
  { userId: NaN },
  { service: 'foreign\nExecStart=/bin/sh' },
  { calendarRoot: '/tmp/../private' },
  { calendarRoot: '/' },
  { calendarRoot: '/private/%p/calendar' },
  { calendarRoot: '/var/lib/nanoclaw-cos/vault/google/calendar' },
])('rejects unsafe unit configuration: %j', (patch) => {
  expect(() => vaultUnits({ ...input, ...patch })).toThrow('vault_units_unverified');
});
