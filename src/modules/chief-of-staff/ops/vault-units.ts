import path from 'node:path';
export type VaultUnitInput = { userId: number; service: string; calendarRoot: string };
/** systemd path escaping: a literal dash must not be confused with a path separator. */
function mountUnit(directory: string): string {
  return (
    directory
      .slice(1)
      .split('/')
      .map((part) => part.replace(/-/g, '\\x2d'))
      .join('-') + '.mount'
  );
}
/** Root-owned fixed storage units plus one drop-in for the bound existing user service.
 * Ordering does not require successful Google storage for ordinary NanoClaw messaging.
 */
export function vaultUnits(input: VaultUnitInput): Record<string, string> {
  if (
    !Number.isSafeInteger(input.userId) ||
    input.userId < 1 ||
    input.userId > 2147483647 ||
    !/^[a-zA-Z0-9_.@-]+\.service$/.test(input.service) ||
    !/^\/home\/[a-zA-Z0-9_.-]+\/(?:[a-zA-Z0-9_.-]+\/)*calendar$/.test(input.calendarRoot) ||
    path.resolve(input.calendarRoot) !== input.calendarRoot
  )
    throw new Error('vault_units_unverified');
  const mount = mountUnit('/var/lib/nanoclaw-cos/vault'),
    bind = mountUnit(input.calendarRoot);
  return {
    'nanoclaw-cos-vault.service': `[Unit]\nDescription=NanoClaw CoS encrypted credential volume\nDefaultDependencies=no\nAfter=systemd-udevd.service\nConflicts=shutdown.target\nBefore=${mount} user@${input.userId}.service shutdown.target\nRequiresMountsFor=/var/lib/nanoclaw-cos /etc/nanoclaw-cos\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nLimitCORE=0\nMemorySwapMax=0\nExecStart=/usr/sbin/cryptsetup open --type luks2 --key-file /etc/nanoclaw-cos/vault.key /var/lib/nanoclaw-cos/vault.luks nanoclaw-cos-vault\nExecStop=/usr/sbin/cryptsetup close nanoclaw-cos-vault\n\n[Install]\nWantedBy=multi-user.target\n`,
    [mount]: `[Unit]\nDescription=NanoClaw CoS encrypted credential filesystem\nRequires=nanoclaw-cos-vault.service\nBindsTo=nanoclaw-cos-vault.service\nAfter=nanoclaw-cos-vault.service\nBefore=user@${input.userId}.service\n\n[Mount]\nWhat=/dev/mapper/nanoclaw-cos-vault\nWhere=/var/lib/nanoclaw-cos/vault\nType=ext4\nOptions=nosuid,nodev,noexec\nDirectoryMode=0000\n\n[Install]\nWantedBy=multi-user.target\n`,
    [bind]: `[Unit]\nDescription=NanoClaw CoS Calendar credential bind\nRequires=${mount}\nBindsTo=${mount}\nAfter=${mount}\nBefore=user@${input.userId}.service\n\n[Mount]\nWhat=/var/lib/nanoclaw-cos/vault/google/calendar\nWhere=${input.calendarRoot}\nType=none\nOptions=bind,nosuid,nodev,noexec\nDirectoryMode=0000\n\n[Install]\nWantedBy=multi-user.target\n`,
    'owner-service.conf': '[Service]\nLimitCORE=0\nMemorySwapMax=0\n',
  };
}
