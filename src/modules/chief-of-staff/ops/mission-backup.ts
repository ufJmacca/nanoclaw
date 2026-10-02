import { backupPrivateHistory, verifyPrivateHistory } from './private-history-backup.js';

/** Caller holds maintenance and has stopped all native writers. Pi-private preservation only;
 * these snapshots never restore credentials, active controls or execution authority. */
export const backupMissionState = (targetRoot: string, receiptRoot: string) =>
  backupPrivateHistory(targetRoot, receiptRoot, 'mission');
export const verifyMissionBackup = (targetRoot: string, receiptRoot: string) =>
  verifyPrivateHistory(targetRoot, receiptRoot, 'mission');
