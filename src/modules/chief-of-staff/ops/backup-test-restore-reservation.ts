import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { BACKUP_LIMITS } from './backup-policy.js';
import { readPinnedBackupStaging } from './backup-capacity.js';
import type { CoordinatedTestRestoreReservation, CoordinatedTestRestoreStart } from './coordinated-backup.js';
export type BackupTestRestoreBinding = {
  requestId: string;
  targetDigest: string;
  repositoryId: string;
  repositoryOwnerDigest: string;
  queueOwnerDigest: string;
  operationId: string;
  snapshotId: string;
  archiveSha256: string;
  archiveBytes: number;
  snapshotDigest: string;
  checkpointDigest: string;
  sourceDatabaseFingerprint: string;
  scopeId: string;
  journal: { installationDigest: string; generation: string };
};
type Record = {
  contract: 'cos-backup-test-restore-reservation/v1';
  binding: BackupTestRestoreBinding;
  start: CoordinatedTestRestoreStart;
};
const hex = /^[a-f0-9]{64}$/,
  uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  fields = [
    'requestId',
    'targetDigest',
    'repositoryId',
    'repositoryOwnerDigest',
    'queueOwnerDigest',
    'operationId',
    'snapshotId',
    'archiveSha256',
    'archiveBytes',
    'snapshotDigest',
    'checkpointDigest',
    'sourceDatabaseFingerprint',
    'scopeId',
    'journal',
  ];
const exact = (value: unknown, keys: string[]) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function validStart(start: CoordinatedTestRestoreStart, binding: BackupTestRestoreBinding): boolean {
  return (
    exact(start, [
      'format',
      'checkpointDigest',
      'sandboxDatabaseFingerprint',
      'testMarkerDigest',
      'scopeId',
      'journal',
    ]) &&
    start.format === 'cos-sandbox-restore-start/v1' &&
    start.checkpointDigest === binding.checkpointDigest &&
    hex.test(start.sandboxDatabaseFingerprint) &&
    start.sandboxDatabaseFingerprint !== binding.sourceDatabaseFingerprint &&
    hex.test(start.testMarkerDigest) &&
    start.scopeId === binding.scopeId &&
    digest(start.journal) === digest(binding.journal)
  );
}
/** Trusted composition only. The caller holds the actual encrypted staging
 * accessor and state queue writer throughout this operation. This small live
 * sibling survives an unknown database commit; no recovered file or lease can
 * replace it. There is no deletion, adoption of incomplete files or path fallback. */
export async function withPinnedBackupTestRestoreReservation<T>(
  directory: string,
  binding: BackupTestRestoreBinding,
  assertCaller: () => void,
  operation: (port: CoordinatedTestRestoreReservation) => Promise<T>,
): Promise<T> {
  let stageFd: number | undefined,
    fileFd: number | undefined,
    active = false,
    initialFile: fs.Stats | undefined,
    contentHash: string | undefined;
  const unavailable = (): never => {
    throw Error('backup_test_restore_reservation_unavailable');
  };
  try {
    if (
      process.platform !== 'linux' ||
      !/^\/proc\/self\/fd\/\d+$/.test(directory) ||
      typeof assertCaller !== 'function' ||
      typeof operation !== 'function' ||
      !exact(binding, fields) ||
      !uuid.test(binding.requestId) ||
      !uuid.test(binding.operationId) ||
      !fields
        .filter((key) => !['requestId', 'operationId', 'archiveBytes', 'scopeId', 'journal'].includes(key))
        .every((key) => hex.test(binding[key as keyof BackupTestRestoreBinding] as string)) ||
      !Number.isSafeInteger(binding.archiveBytes) ||
      binding.archiveBytes < 2048 ||
      binding.archiveBytes > BACKUP_LIMITS.staging + 2 * 1024 ** 2 ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(binding.scopeId) ||
      !exact(binding.journal, ['installationDigest', 'generation']) ||
      binding.journal.installationDigest !== binding.targetDigest ||
      !uuid.test(binding.journal.generation)
    )
      unavailable();
    assertCaller();
    const bindingDigest = digest(binding);
    stageFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const initialStage = fs.fstatSync(stageFd),
      stage = '/proc/self/fd/' + stageFd,
      file = path.join(stage, '.cos-test-restore-' + binding.requestId + '.json');
    if (
      !initialStage.isDirectory() ||
      initialStage.uid !== process.getuid?.() ||
      (initialStage.mode & 0o7777) !== 0o700
    )
      unavailable();
    const stageCurrent = () => {
      if (!active) unavailable();
      assertCaller();
      if (digest(binding) !== bindingDigest) unavailable();
      for (const stat of [fs.fstatSync(stageFd!), fs.statSync(directory)])
        if (
          !stat.isDirectory() ||
          stat.dev !== initialStage.dev ||
          stat.ino !== initialStage.ino ||
          stat.uid !== initialStage.uid ||
          (stat.mode & 0o7777) !== 0o700
        )
          unavailable();
    };
    active = true;
    const readBytes = (): Buffer => {
      const before = fs.fstatSync(fileFd!),
        named = fs.lstatSync(file);
      if (
        !initialFile ||
        !before.isFile() ||
        before.dev !== initialStage.dev ||
        before.uid !== initialStage.uid ||
        before.nlink !== 1 ||
        (before.mode & 0o7777) !== 0o600 ||
        before.size < 1 ||
        before.size > 16384 ||
        [before, named].some(
          (stat) =>
            stat.dev !== initialFile!.dev ||
            stat.ino !== initialFile!.ino ||
            stat.size !== initialFile!.size ||
            stat.mode !== initialFile!.mode ||
            stat.uid !== initialFile!.uid ||
            stat.nlink !== 1 ||
            stat.mtimeMs !== initialFile!.mtimeMs ||
            stat.ctimeMs !== initialFile!.ctimeMs,
        )
      )
        unavailable();
      const bytes = Buffer.alloc(before.size + 1);
      try {
        const count = fs.readSync(fileFd!, bytes, 0, bytes.length, 0),
          after = fs.fstatSync(fileFd!);
        if (
          count !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          after.size !== before.size ||
          (contentHash && hash(bytes.subarray(0, count)) !== contentHash)
        )
          unavailable();
        return Buffer.from(bytes.subarray(0, count));
      } finally {
        bytes.fill(0);
      }
    };
    const readRecord = (): Record => {
      const bytes = readBytes();
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record;
        if (
          !exact(value, ['contract', 'binding', 'start']) ||
          value.contract !== 'cos-backup-test-restore-reservation/v1' ||
          digest(value.binding) !== bindingDigest ||
          !validStart(value.start, binding)
        )
          unavailable();
        contentHash ??= hash(bytes);
        return value;
      } finally {
        bytes.fill(0);
      }
    };
    stageCurrent();
    if (fs.lstatSync(file, { throwIfNoEntry: false })) {
      fileFd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      initialFile = fs.fstatSync(fileFd);
      readRecord();
    }
    const current = () => {
      stageCurrent();
      if (fileFd === undefined) {
        if (fs.lstatSync(file, { throwIfNoEntry: false })) unavailable();
      } else {
        const bytes = readBytes();
        bytes.fill(0);
      }
      stageCurrent();
    };
    const capacity = (growth: number) => {
      current();
      const usage = readPinnedBackupStaging(stage);
      if (
        usage.bytes + growth > BACKUP_LIMITS.staging ||
        usage.free < growth + BACKUP_LIMITS.vaultReserve ||
        fs.readdirSync(stage).filter((name) => name.startsWith('.cos-test-restore-')).length > 256
      )
        unavailable();
      current();
    };
    capacity(0);
    const safe = <U>(use: () => U): U => {
      try {
        return use();
      } catch {
        // eslint-disable-next-line preserve-caught-error -- Borrowed methods expose no private file, binding or mount diagnostics.
        throw Error('backup_test_restore_reservation_unavailable');
      }
    };
    const port: CoordinatedTestRestoreReservation = Object.freeze({
      assertCurrent: () => safe(current),
      read: () =>
        safe(() => {
          current();
          const value = fileFd === undefined ? undefined : readRecord().start;
          current();
          return value;
        }),
      create: (start) =>
        safe(() => {
          current();
          if (fileFd !== undefined || !validStart(start, binding)) unavailable();
          const bytes = Buffer.from(
            JSON.stringify({ contract: 'cos-backup-test-restore-reservation/v1', binding, start }) + '\n',
          );
          try {
            if (
              bytes.length > 16384 ||
              fs.readdirSync(stage).filter((name) => name.startsWith('.cos-test-restore-')).length >= 256
            )
              unavailable();
            capacity(Math.ceil(bytes.length / 4096) * 4096 + 8192);
            fileFd = fs.openSync(
              file,
              fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
              0o600,
            );
            fs.writeFileSync(fileFd, bytes);
            fs.fsyncSync(fileFd);
            fs.fsyncSync(stageFd!);
            initialFile = fs.fstatSync(fileFd);
            contentHash = hash(bytes);
            current();
            readRecord();
            capacity(0);
          } finally {
            bytes.fill(0);
          }
        }),
    });
    const result = await operation(port);
    current();
    capacity(0);
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Import callbacks and retained reservation paths remain private.
    throw Error('backup_test_restore_reservation_unavailable');
  } finally {
    active = false;
    try {
      if (fileFd !== undefined) fs.closeSync(fileFd);
    } finally {
      if (stageFd !== undefined) fs.closeSync(stageFd);
    }
  }
}
