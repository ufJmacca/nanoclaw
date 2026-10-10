import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { verifyVaultMemory } from './vault-memory.js';
import { backupNasInitializationResource } from './backup-nas-initialization-recovery-scope.js';
import {
  backupNasInitializationRetirementJournal,
  type BackupNasInitializationRetirementJournal,
  type BackupNasInitializationRetirementScope,
} from './backup-nas-initialization-retirement-state.js';
export type BackupNasInitializationRetirementJournalLease = Readonly<{
  assertCurrent(): Promise<void>;
  readJournal(): BackupNasInitializationRetirementJournal | null;
  writeJournal(value: BackupNasInitializationRetirementJournal): Promise<void>;
}>;
export type BackupNasInitializationRetirementJournalControls = {
  /** The caller holds and revalidates the accepted G01 control parent, actual
   * kernel writer, resource descriptor and fresh resource-bound permission.
   * A journal is durable progress metadata, never permission or ownership.
   */
  controlFd: number;
  assertAuthority(): Promise<void>;
  /** Source-only fixture. Installed composition uses the default protection. */
  assertMemory?(): void;
};
/** Only the digest-derived private journal is writable. No resource path,
 * command or operation receipt selects an effect. The caller owns the parent
 * descriptor; this adapter retains its own journal descriptors across awaits.
 */
export async function withBackupNasInitializationRetirementJournal<T>(
  input: BackupNasInitializationRetirementScope,
  controls: BackupNasInitializationRetirementJournalControls,
  operation: (lease: BackupNasInitializationRetirementJournalLease) => Promise<T>,
): Promise<T> {
  const descriptors = new Set<number>();
  const close = (fd: number) => {
    if (descriptors.delete(fd)) fs.closeSync(fd);
  };
  let active = false,
    writing = false,
    pendingWrite: Promise<void> | undefined;
  try {
    const role = () => {
      (controls.assertMemory ?? verifyVaultMemory)();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
        throw Error('root_required');
    };
    role();
    if (!input || Reflect.ownKeys(input).sort().join(',') !== 'nasDigest,resource,vaultStateDigest')
      throw Error('retirement_scope_required');
    const { nasDigest, vaultStateDigest, resource } = input;
    const scope = Object.freeze({ nasDigest, vaultStateDigest, resource: backupNasInitializationResource(resource) });
    backupNasInitializationRetirementJournal(
      { contract: 'cos-backup-nas-initialization-retirement/v1', ...scope, phase: 'retiring' },
      scope,
    );
    const parentFd = controls.controlFd;
    if (!Number.isSafeInteger(parentFd) || parentFd < 0) throw Error('control_descriptor_required');
    const parent = fs.fstatSync(parentFd);
    const guard = () => {
      role();
      const stat = fs.fstatSync(parentFd);
      if (
        !stat.isDirectory() ||
        stat.uid !== 0 ||
        (stat.mode & 0o7777) !== 0o700 ||
        stat.dev !== parent.dev ||
        stat.ino !== parent.ino
      )
        throw Error('control_parent_changed');
    };
    guard();
    const root = '/proc/self/fd/' + parentFd,
      filename = 'nas-initialization-retirement.' + digest(scope) + '.json',
      destination = root + '/' + filename;
    const open = (file: string) => {
      guard();
      const first = fs.lstatSync(file),
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      descriptors.add(fd);
      const before = fs.fstatSync(fd);
      const checkStat = (stat: fs.Stats) => {
        if (
          !stat.isFile() ||
          stat.uid !== 0 ||
          (stat.mode & 0o7777) !== 0o600 ||
          stat.nlink !== 1 ||
          stat.dev !== parent.dev ||
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size < 1 ||
          stat.size > 4096 ||
          stat.size !== before.size ||
          stat.mtimeMs !== before.mtimeMs ||
          stat.ctimeMs !== before.ctimeMs
        )
          throw Error('retirement_journal_changed');
      };
      checkStat(first);
      const check = () => {
        guard();
        checkStat(fs.fstatSync(fd));
        checkStat(fs.lstatSync(file));
      };
      check();
      const bytes = Buffer.alloc(before.size + 1);
      try {
        if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== before.size) throw Error('retirement_journal_changed');
        check();
        const text = bytes.subarray(0, before.size).toString('utf8');
        return { fd, before, text, value: backupNasInitializationRetirementJournal(JSON.parse(text), scope), check };
      } finally {
        bytes.fill(0);
      }
    };
    let read = fs.lstatSync(destination, { throwIfNoEntry: false }) ? open(destination) : undefined;
    active = true;
    const check = () => {
      if (!active) throw Error('retirement_journal_released');
      guard();
      if (read) read.check();
      else if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw Error('retirement_journal_appeared');
    };
    const assertCurrent = async () => {
      try {
        check();
        await controls.assertAuthority();
        check();
      } catch {
        active = false;
        // eslint-disable-next-line preserve-caught-error -- Root metadata and native proof diagnostics remain private.
        throw Error('backup_nas_initialization_retirement_journal_unavailable');
      }
    };
    const readJournal = () => {
      check();
      return read ? backupNasInitializationRetirementJournal(read.value, scope) : null;
    };
    const replace = async (value: BackupNasInitializationRetirementJournal) => {
      let fd: number | undefined,
        created: fs.Stats | undefined,
        published = false;
      const next = backupNasInitializationRetirementJournal(value, scope),
        temporary = root + '/.nas-initialization-retirement.' + randomUUID() + '.tmp',
        bytes = Buffer.from(JSON.stringify(next) + '\n');
      try {
        await assertCurrent();
        if (read?.value.phase === 'retired' && next.phase !== 'retired') throw Error('retirement_phase_reversal');
        fd = fs.openSync(
          temporary,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
        created = fs.fstatSync(fd);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        const ready = open(temporary);
        if (
          ready.before.dev !== created.dev ||
          ready.before.ino !== created.ino ||
          ready.text !== bytes.toString('utf8')
        )
          throw Error('retirement_journal_write_changed');
        await assertCurrent();
        ready.check();
        check();
        if (read) fs.renameSync(temporary, destination);
        else {
          fs.linkSync(temporary, destination);
          fs.unlinkSync(temporary);
        }
        published = true;
        close(ready.fd);
        if (read) close(read.fd);
        read = open(destination);
        if (read.before.dev !== created.dev || read.before.ino !== created.ino || digest(read.value) !== digest(next))
          throw Error('retirement_journal_write_changed');
        fs.fsyncSync(read.fd);
        fs.fsyncSync(parentFd);
        await assertCurrent();
      } catch {
        active = false;
        // eslint-disable-next-line preserve-caught-error -- Failed publication or sync never acknowledges private progress.
        throw Error('backup_nas_initialization_retirement_journal_unavailable');
      } finally {
        bytes.fill(0);
        try {
          if (!published && created) {
            const stat = fs.lstatSync(temporary, { throwIfNoEntry: false });
            if (
              stat?.isFile() &&
              stat.uid === 0 &&
              stat.nlink === 1 &&
              stat.dev === created.dev &&
              stat.ino === created.ino
            ) {
              fs.unlinkSync(temporary);
              fs.fsyncSync(parentFd);
            }
          }
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
    };
    const writeJournal = (value: BackupNasInitializationRetirementJournal) => {
      if (writing || !active) {
        active = false;
        return Promise.reject(Error('backup_nas_initialization_retirement_journal_unavailable'));
      }
      writing = true;
      pendingWrite = replace(value).finally(() => {
        writing = false;
      });
      void pendingWrite.catch(() => {});
      return pendingWrite;
    };
    await assertCurrent();
    if (read) {
      fs.fsyncSync(read.fd);
      fs.fsyncSync(parentFd);
      await assertCurrent();
    }
    const result = await operation(Object.freeze({ assertCurrent, readJournal, writeJournal }));
    if (writing) throw Error('retirement_journal_write_unfinished');
    await assertCurrent();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- No callback, resource or root path diagnostics escape the private adapter.
    throw Error('backup_nas_initialization_retirement_journal_unavailable');
  } finally {
    active = false;
    if (pendingWrite) await pendingWrite.catch(() => {});
    for (const fd of [...descriptors].reverse()) close(fd);
  }
}
