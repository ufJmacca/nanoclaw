import type { VaultRootConfiguration } from './vault-root-config.js';
import type { BackupNasSetupRequest } from './backup-nas-setup-wire.js';
import {
  backupNasProcessInvocation,
  executeBackupNasProcess,
  type BackupNasProcessControls,
} from './backup-nas-process.js';
export type BackupNasSetupProcessControls = BackupNasProcessControls;
export function backupNasSetupInvocation(input: VaultRootConfiguration, selected: BackupNasSetupRequest) {
  return backupNasProcessInvocation('setup', input, selected);
}
export function executeBackupNasSetup(
  input: VaultRootConfiguration,
  selected: BackupNasSetupRequest,
  check: () => Promise<void>,
  controls: BackupNasSetupProcessControls = {},
): Promise<unknown> {
  return executeBackupNasProcess('setup', input, selected, check, controls);
}
