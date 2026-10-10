import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { streamBackupArchive } from './backup-archive.js';
import { createVaultBackupQueue, type BackupQueue } from './backup-queue.js';
import type { BackupKind } from './backup-policy.js';

/** Pure transport for admitted queues; the installed command below always uses the vault factory. */
export async function streamQueuedBackup(
  queue: Pick<BackupQueue, 'withPending'>,
  kind: BackupKind,
  operationId: string,
  emit: (bytes: Buffer) => Promise<void>,
): Promise<{ bytes: number; sha256: string }> {
  try {
    if (
      !['state', 'credentials'].includes(kind) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)
    )
      throw Error('invalid_producer_identity');
    return await queue.withPending(kind, operationId, (directory, receipt) =>
      streamBackupArchive(directory, receipt, emit),
    );
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Filesystem, queue and transport diagnostics are private.
    throw Error('backup_producer_unavailable');
  }
}
/** Invoked by Restic --stdin-from-command. Arguments contain path identities, never credentials.
 * No success message may be written to stdout: it carries only the borrowed archive stream. */
export async function backupArchiveProducerCommand(
  args: string[],
  emit: (bytes: Buffer) => Promise<void>,
): Promise<{ bytes: number; sha256: string }> {
  try {
    if (!Array.isArray(args) || args.length !== 5 || args.some((value) => typeof value !== 'string'))
      throw Error('invalid_producer_input');
    const [targetRoot, installationRoot, dataRoot, kind, operationId] = args;
    for (const root of [targetRoot, installationRoot, dataRoot])
      if (
        !path.isAbsolute(root) ||
        path.resolve(root) !== root ||
        root === '/' ||
        Buffer.byteLength(root) > 4096 ||
        /[\0\r\n]/.test(root)
      )
        throw Error('invalid_producer_root');
    if (
      !['state', 'credentials'].includes(kind) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)
    )
      throw Error('invalid_producer_identity');
    const queue = createVaultBackupQueue({ targetRoot, installationRoot, dataRoot });
    return await streamQueuedBackup(queue, kind as BackupKind, operationId, emit);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- The command cannot leak vault paths, account data or private failures.
    throw Error('backup_producer_unavailable');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.on('error', () => {}); // A closed Restic pipe is handled by the write callback.
  backupArchiveProducerCommand(
    process.argv.slice(2),
    (bytes) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
      }),
  ).catch(() => {
    process.stderr.write('backup_producer_unavailable\n');
    process.exitCode = 77;
  });
}
