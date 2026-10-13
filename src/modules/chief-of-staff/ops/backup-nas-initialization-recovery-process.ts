import type { VaultRootConfiguration } from './vault-root-config.js';
import type { BackupNasInitializationRecoveryRequest } from './backup-nas-initialization-recovery-wire.js';
import {
  backupNasProcessInvocation,
  executeBackupNasProcess,
  type BackupNasProcessControls,
} from './backup-nas-process.js';
export type BackupNasInitializationRecoveryProcessControls = BackupNasProcessControls;
export function backupNasInitializationRecoveryInvocation(
  input: VaultRootConfiguration,
  request: BackupNasInitializationRecoveryRequest,
) {
  return backupNasProcessInvocation('initialization', input, request);
}
export function executeBackupNasInitializationRecovery(
  input: VaultRootConfiguration,
  request: BackupNasInitializationRecoveryRequest,
  check: () => Promise<void>,
  controls: BackupNasInitializationRecoveryProcessControls = {},
): Promise<unknown> {
  return executeBackupNasProcess('initialization', input, request, check, controls);
}
