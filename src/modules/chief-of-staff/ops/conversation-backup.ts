import { backupPrivateHistory, verifyPrivateHistory } from './private-history-backup.js';

/** Private Pi-only snapshots under maintenance, with all native writers stopped.
 * The historical receipt format and credential exclusions remain unchanged. */
export const backupConversations = (source: string, receiptRoot: string) =>
  backupPrivateHistory(source, receiptRoot, 'conversation');
export const verifyConversationBackup = (source: string, receiptRoot: string) =>
  verifyPrivateHistory(source, receiptRoot, 'conversation');
