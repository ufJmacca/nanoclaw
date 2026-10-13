import { isIP } from 'node:net';
/** Fixed command definition only. A root caller supplies an admitted live descriptor
 * as child fd 3 and independently admits the owned mountpoint before execution.
 */
export function backupNasMountCommand(input: { host: string; userId: number; groupId: number }) {
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
    const options = [
      'rw',
      'credentials=/proc/self/fd/3',
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
      command: '/usr/sbin/mount.cifs',
      args: Object.freeze(['//' + input.host + '/nanoclaw-cos-backups', '/var/lib/nanoclaw-cos/nas', '-o', options]),
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Selected private NAS endpoints never enter diagnostics.
    throw Error('backup_nas_unit_unavailable');
  }
}
/** No boot activation or main-runtime dependency. Installed dispatch, root-owned NAS
 * configuration and mountpoint ownership must pass their separate tests before delivery.
 */
export function backupNasMountService(input: { artifactDigest: string }) {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).join(',') !== 'artifactDigest' ||
      typeof input.artifactDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.artifactDigest)
    )
      throw Error('invalid_nas_service');
    const vault = 'var-lib-nanoclaw-cos-vault.mount'.replace('nanoclaw-cos', 'nanoclaw\\x2dcos'),
      root = '/opt/nanoclaw-cos/vault/' + input.artifactDigest;
    return Object.freeze({
      name: 'nanoclaw-cos-backup-mount.service',
      contents: `[Unit]\nDescription=NanoClaw CoS dedicated signed backup share\nWants=network-online.target\nBindsTo=${vault}\nAfter=network-online.target ${vault}\nConditionPathIsMountPoint=/var/lib/nanoclaw-cos/vault\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${root}/node ${root}/gateway.mjs --backup-mount\nExecStop=${root}/node ${root}/gateway.mjs --backup-unmount\nTimeoutStartSec=30s\nTimeoutStopSec=10s\nKillMode=control-group\nLimitCORE=0\nMemorySwapMax=0\nUMask=0077\nStandardOutput=null\nStandardError=null\n`,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- No caller-selected commands or credential paths enter the unit.
    throw Error('backup_nas_unit_unavailable');
  }
}
