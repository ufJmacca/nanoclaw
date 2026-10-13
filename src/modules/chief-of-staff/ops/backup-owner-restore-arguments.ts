export type BackupOwnerRestoreArguments = {
  command: 'backup-restore-check';
  scopeId: string;
  requestId: string;
  queueOperationId: string;
  backupReleaseId: string;
  snapshotDigest: string;
};
export function parseBackupOwnerRestoreArguments(args: string[]): BackupOwnerRestoreArguments {
  const invalid = () => Error('invalid_owner_admin_arguments'),
    allowed = ['--scope', '--request-id', '--backup-operation-id', '--backup-release', '--snapshot-digest'],
    values: Record<string, string> = {};
  if (args[0] !== 'backup-restore-check' || args.length !== 11) throw invalid();
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]) throw invalid();
    values[args[i]] = args[i + 1];
  }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(values['--scope'] ?? '') ||
    !uuid.test(values['--request-id'] ?? '') ||
    !uuid.test(values['--backup-operation-id'] ?? '') ||
    !/^release-[a-zA-Z0-9_-]{1,120}$/.test(values['--backup-release'] ?? '') ||
    !/^[a-f0-9]{64}$/.test(values['--snapshot-digest'] ?? '')
  )
    throw invalid();
  return {
    command: 'backup-restore-check',
    scopeId: values['--scope'],
    requestId: values['--request-id'],
    queueOperationId: values['--backup-operation-id'],
    backupReleaseId: values['--backup-release'],
    snapshotDigest: values['--snapshot-digest'],
  };
}
