import type { VaultRootConfiguration } from './vault-root-config.js';
import type { BackupNasSetupRequest } from './backup-nas-setup-wire.js';
import {
  backupNasProcessInvocation,
  executeBackupNasProcess,
  type BackupNasProcessControls,
} from './backup-nas-process.js';
export type BackupNasInspectionProcessControls = BackupNasProcessControls;
export function backupNasInspectionInvocation(input: VaultRootConfiguration, selected: BackupNasSetupRequest) {
  return backupNasProcessInvocation('inspection', input, selected);
}
export function executeBackupNasInitializationInspection(
  input: VaultRootConfiguration,
  selected: BackupNasSetupRequest,
  check: () => Promise<void>,
  controls: BackupNasInspectionProcessControls = {},
): Promise<unknown> {
  return executeBackupNasProcess('inspection', input, selected, check, controls);
}
