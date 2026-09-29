import fs from 'node:fs';
import { createHash } from 'node:crypto';
export function machineFingerprint(): string {
  if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('unsupported_target');
  const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('target_identity_unavailable');
  return createHash('sha256')
    .update('linux-machine-id:' + id)
    .digest('hex');
}
