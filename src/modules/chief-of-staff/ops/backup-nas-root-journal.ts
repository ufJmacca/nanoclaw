import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';
import { backupNasMountJournal, type BackupNasMountJournal } from './backup-nas-mount-state.js';
import { BackupRepositoryWriter } from './backup-repository-lease.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { verifyVaultMemory } from './vault-memory.js';
type Paths = Readonly<{ configRoot: string; controlRoot: string; storageRoot: string; mount: string }>;
export type BackupNasRootJournalControls = {
  /** Mandatory installed composition checks current root configuration and sealed artifact.
   * Mount also retains the owner credential lease; recovery requires separate fresh maintenance.
   */
  assertAuthority(): Promise<void>;
  assertMemory?(): void;
  /** Source-only filesystem fixtures; no installed path or role selector. */
  paths?: Paths;
};
export type BackupNasRootJournalLease = Readonly<{
  scope: Readonly<{ configurationDigest: string; bindingDigest: string }>;
  assertCurrent(): Promise<void>;
  readJournal(): BackupNasMountJournal;
  writeJournal(value: BackupNasMountJournal): Promise<void>;
}>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const inode = (stat: fs.Stats) => ({ device: stat.dev, inode: stat.ino });
/** Existing G01 parent claims and NAS metadata only. No bootstrap, configuration or
 * underlay is created or repaired. The real kernel writer covers every journal read,
 * durable replacement and awaited operation; stored metadata never grants authority.
 */
export async function withBackupNasRootJournal<T>(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  operation: (lease: BackupNasRootJournalLease) => Promise<T>,
  controls: BackupNasRootJournalControls,
): Promise<T> {
  const descriptors = new Set<number>();
  let active = false;
  let pendingWrite: Promise<void> | undefined;
  const close = (fd: number) => {
    if (descriptors.delete(fd)) fs.closeSync(fd);
  };
  try {
    const role = () => {
      (controls.assertMemory ?? verifyVaultMemory)();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
        throw Error('root_required');
    };
    role();
    const vault = vaultRootConfiguration(input),
      nas = backupNasRootConfiguration(selected, vault);
    const scope = Object.freeze({
      configurationDigest: digest(nas),
      bindingDigest: digest({ host: nas.host, share: 'nanoclaw-cos-backups', mount: '/var/lib/nanoclaw-cos/nas' }),
    });
    const paths = Object.freeze({
      ...(controls.paths ?? {
        configRoot: '/etc/nanoclaw-cos',
        controlRoot: '/etc/nanoclaw-cos/control',
        storageRoot: '/var/lib/nanoclaw-cos',
        mount: '/var/lib/nanoclaw-cos/nas',
      }),
    });
    if (
      Object.keys(paths).sort().join(',') !== 'configRoot,controlRoot,mount,storageRoot' ||
      paths.controlRoot !== paths.configRoot + '/control' ||
      paths.mount !== paths.storageRoot + '/nas' ||
      Object.values(paths).some(
        (directory) =>
          !path.isAbsolute(directory) ||
          path.resolve(directory) !== directory ||
          directory === '/' ||
          fs.realpathSync(path.dirname(directory)) !== path.dirname(directory),
      )
    )
      throw Error('unsafe_root_paths');
    const roots = (
      [
        ['configRoot', 0o700],
        ['controlRoot', 0o700],
        ['storageRoot', 0o711],
      ] as const
    ).map(([key, mode]) => {
      const directory = paths[key],
        before = fs.lstatSync(directory);
      const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      descriptors.add(fd);
      return { directory, before, fd, mode };
    });
    const [config, control, storage] = roots;
    const guard = () => {
      role();
      for (const root of roots) {
        for (const stat of [fs.fstatSync(root.fd), fs.lstatSync(root.directory)])
          if (
            !stat.isDirectory() ||
            stat.uid !== 0 ||
            (stat.mode & 0o7777) !== root.mode ||
            stat.dev !== root.before.dev ||
            stat.ino !== root.before.ino
          )
            throw Error('root_parent_changed');
        if (fs.realpathSync(root.directory) !== root.directory) throw Error('root_parent_changed');
      }
    };
    guard();
    const metadata = (root: (typeof roots)[number], name: string) => {
      guard();
      const file = '/proc/self/fd/' + root.fd + '/' + name;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      descriptors.add(fd);
      const before = fs.fstatSync(fd);
      const check = () => {
        guard();
        for (const stat of [fs.fstatSync(fd), fs.lstatSync(file)])
          if (
            !stat.isFile() ||
            stat.uid !== 0 ||
            stat.nlink !== 1 ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.dev !== root.before.dev ||
            stat.dev !== before.dev ||
            stat.ino !== before.ino ||
            stat.size < 1 ||
            stat.size > 4096 ||
            stat.size !== before.size ||
            stat.mtimeMs !== before.mtimeMs ||
            stat.ctimeMs !== before.ctimeMs
          )
            throw Error('root_metadata_changed');
      };
      check();
      const bytes = Buffer.alloc(before.size + 1);
      try {
        if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== before.size) throw Error('root_metadata_changed');
        check();
        const value: unknown = JSON.parse(bytes.subarray(0, before.size).toString('utf8'));
        return { fd, value, before, check };
      } finally {
        bytes.fill(0);
      }
    };
    const bootstrap = metadata(config!, 'vault-bootstrap.json'),
      claim = bootstrap.value;
    const configuration = metadata(config!, 'backup-nas.json');
    if (digest(backupNasRootConfiguration(configuration.value, vault)) !== scope.configurationDigest)
      throw Error('root_nas_configuration_changed');
    if (
      !object(claim) ||
      Object.keys(claim).sort().join(',') !== 'claims,contract,identityDigest,phase' ||
      claim.contract !== 'cos-vault-root-state/v1' ||
      claim.phase !== 'complete' ||
      claim.identityDigest !== vaultRootStateDigest(vault) ||
      !object(claim.claims) ||
      Object.keys(claim.claims).sort().join(',') !== 'control,storage'
    )
      throw Error('accepted_vault_claim_required');
    for (const [key, root] of [
      ['control', control!],
      ['storage', storage!],
    ] as const)
      if (
        !object(claim.claims[key]) ||
        Object.keys(claim.claims[key]).sort().join(',') !== 'device,inode' ||
        digest(claim.claims[key]) !== digest(inode(root.before))
      )
        throw Error('root_claim_changed');
    const authority = async () => {
      guard();
      bootstrap.check();
      configuration.check();
      await controls.assertAuthority();
      configuration.check();
      bootstrap.check();
      guard();
    };
    await authority();
    const writer = new BackupRepositoryWriter(
      digest({ contract: 'cos-backup-nas-mount-writer/v1', configurationDigest: scope.configurationDigest }),
      async (work) => {
        guard();
        const result = await work('/proc/self/fd/' + control!.fd);
        guard();
        return result;
      },
    );
    return await writer.exclusive(async (writerLease) => {
      let read = metadata(control!, 'nas-mount.json');
      let record = backupNasMountJournal(read.value, scope);
      const originalUnderlay = digest(record.underlay);
      active = true;
      const valid = () => {
        if (!active) throw Error('root_journal_released');
        writerLease.assertCurrent();
        guard();
        bootstrap.check();
        configuration.check();
        read.check();
        if (digest(backupNasMountJournal(read.value, scope)) !== digest(record)) throw Error('journal_changed');
      };
      const assertCurrent = async () => {
        try {
          valid();
          await authority();
          valid();
        } catch {
          active = false;
          // eslint-disable-next-line preserve-caught-error -- Private filesystem and live authority diagnostics do not cross this boundary.
          throw Error('backup_nas_root_journal_unavailable');
        }
      };
      const readJournal = () => {
        try {
          valid();
          return record;
        } catch {
          active = false;
          // eslint-disable-next-line preserve-caught-error -- Journal contents and private resource diagnostics remain private.
          throw Error('backup_nas_root_journal_unavailable');
        }
      };
      let writing = false;
      const replaceJournal = async (value: BackupNasMountJournal) => {
        let temporaryFd: number | undefined, created: fs.Stats | undefined, bytes: Buffer | undefined;
        const temporary = '/proc/self/fd/' + control!.fd + '/.nas-mount.' + randomUUID() + '.tmp';
        let published = false;
        try {
          const next = backupNasMountJournal(value, scope);
          if (digest(next.underlay) !== originalUnderlay) throw Error('underlay_claim_changed');
          bytes = Buffer.from(JSON.stringify(next) + '\n');
          if (bytes.length > 4096) throw Error('journal_bounds');
          await assertCurrent();
          temporaryFd = fs.openSync(
            temporary,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
          );
          created = fs.fstatSync(temporaryFd);
          const checkTemporary = () => {
            valid();
            for (const stat of [fs.fstatSync(temporaryFd!), fs.lstatSync(temporary)])
              if (
                !stat.isFile() ||
                stat.uid !== 0 ||
                stat.nlink !== 1 ||
                (stat.mode & 0o7777) !== 0o600 ||
                stat.dev !== control!.before.dev ||
                stat.dev !== created!.dev ||
                stat.ino !== created!.ino
              )
                throw Error('temporary_journal_changed');
          };
          checkTemporary();
          fs.writeFileSync(temporaryFd, bytes);
          fs.fsyncSync(temporaryFd);
          await assertCurrent();
          checkTemporary();
          fs.renameSync(temporary, '/proc/self/fd/' + control!.fd + '/nas-mount.json');
          published = true;
          close(read.fd);
          read = metadata(control!, 'nas-mount.json');
          record = backupNasMountJournal(read.value, scope);
          if (read.before.dev !== created.dev || read.before.ino !== created.ino || digest(record) !== digest(next))
            throw Error('published_journal_changed');
          fs.fsyncSync(read.fd);
          fs.fsyncSync(control!.fd);
          await assertCurrent();
        } catch {
          active = false;
          // eslint-disable-next-line preserve-caught-error -- Uncertain replacement or sync never acknowledges success or exposes private diagnostics.
          throw Error('backup_nas_root_journal_unavailable');
        } finally {
          bytes?.fill(0);
          try {
            if (!published && created) {
              const stat = fs.lstatSync(temporary, { throwIfNoEntry: false });
              if (
                stat?.isFile() &&
                stat.uid === 0 &&
                stat.nlink === 1 &&
                stat.dev === created.dev &&
                stat.ino === created.ino
              )
                fs.unlinkSync(temporary);
            }
          } finally {
            if (temporaryFd !== undefined) fs.closeSync(temporaryFd);
          }
        }
      };
      const writeJournal = (value: BackupNasMountJournal): Promise<void> => {
        if (writing || !active) {
          active = false;
          return Promise.reject(Error('backup_nas_root_journal_unavailable'));
        }
        writing = true;
        pendingWrite = replaceJournal(value).finally(() => {
          writing = false;
        });
        // A callback cannot turn fire-and-forget work into a successful root receipt.
        void pendingWrite.catch(() => {});
        return pendingWrite;
      };
      await assertCurrent();
      // A previous process may have seen bytes before its directory sync failed. Repeat durability before use.
      fs.fsyncSync(read.fd);
      fs.fsyncSync(control!.fd);
      await assertCurrent();
      const lease = Object.freeze({ scope, assertCurrent, readJournal, writeJournal });
      const result = await operation(lease);
      if (writing) throw Error('journal_write_unfinished');
      await assertCurrent();
      return result;
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Callback, root ownership and kernel writer diagnostics remain private.
    throw Error('backup_nas_root_journal_unavailable');
  } finally {
    active = false;
    // Revocation prevents any next publication; finish owned temporary cleanup before closing its parent descriptors.
    if (pendingWrite) await pendingWrite.catch(() => {});
    for (const fd of [...descriptors].reverse()) close(fd);
  }
}
