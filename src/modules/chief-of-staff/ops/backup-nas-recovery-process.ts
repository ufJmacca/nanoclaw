import type { VaultRootConfiguration } from './vault-root-config.js';
import type { BackupNasRecoveryRequest } from './backup-nas-recovery-wire.js';
import {
  backupNasProcessInvocation,
  executeBackupNasProcess,
  type BackupNasProcessControls,
} from './backup-nas-process.js';
export type BackupNasRecoveryProcessControls = BackupNasProcessControls;
export function backupNasRecoveryInvocation(input: VaultRootConfiguration, selected: BackupNasRecoveryRequest) {
  return backupNasProcessInvocation('recovery', input, selected);
}
export function executeBackupNasRecovery(
  input: VaultRootConfiguration,
  selected: BackupNasRecoveryRequest,
  check: () => Promise<void>,
  controls: BackupNasRecoveryProcessControls = {},
): Promise<unknown> {
  return executeBackupNasProcess('recovery', input, selected, check, controls);
}
