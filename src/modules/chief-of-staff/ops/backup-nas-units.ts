import { isIP } from 'node:net';
/** Root provisioning installs this on-demand unit only after its separate credential
 * admission service is installed and tested. It adds no dependency to the owner runtime.
 * Actual kernel signing, mount identity and repository admission remain mandatory.
 */
export function backupNasMountUnit(input: { host: string; userId: number; groupId: number }) {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'groupId,host,userId' ||
      typeof input.host !== 'string' ||
      isIP(input.host) !== 4 ||
      [input.userId, input.groupId].some((id) => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)
    )
      throw Error('invalid_nas_unit');
    const parts = input.host.split('.').map(Number);
    if (
      !(
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168)
      )
    )
      throw Error('private_lan_required');
    const vault = 'var-lib-nanoclaw\\x2dcos-vault.mount';
    const admission = 'nanoclaw-cos-backup-mount-admission.service';
    const options = [
      'rw',
      'credentials=/var/lib/nanoclaw-cos/vault/backup-credentials/smb-credentials',
      'vers=2.1',
      'sec=ntlmsspi',
      'uid=' + input.userId,
      'gid=' + input.groupId,
      'forceuid',
      'forcegid',
      'file_mode=0600',
      'dir_mode=0700',
      'nosuid',
      'nodev',
      'noexec',
      'nodfs',
      'soft',
    ].join(',');
    return Object.freeze({
      name: 'var-lib-nanoclaw\\x2dcos-nas.mount',
      contents: `[Unit]\nDescription=NanoClaw CoS dedicated signed backup share\nWants=network-online.target\nRequires=${admission}\nBindsTo=${vault}\nAfter=network-online.target ${vault} ${admission}\nConditionPathIsMountPoint=/var/lib/nanoclaw-cos/vault\n\n[Mount]\nWhat=//${input.host}/nanoclaw-cos-backups\nWhere=/var/lib/nanoclaw-cos/nas\nType=cifs\nOptions=${options}\nDirectoryMode=0000\nTimeoutSec=20s\nLimitCORE=0\nMemorySwapMax=0\nUMask=0077\nStandardOutput=null\nStandardError=null\n`,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Selected private NAS endpoints never enter diagnostics.
    throw Error('backup_nas_unit_unavailable');
  }
}
