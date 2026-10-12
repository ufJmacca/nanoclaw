import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { BackupMountBinding } from './backup-policy.js';
import type { SignedBackupRepository } from './backup-nas-access.js';
import type { BackupRepositoryLease } from './backup-repository-lease.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { withPinnedBackupRepository } from './backup-nas-access.js';
import { backupNasMountCommand } from './backup-nas-units.js';
export type BackupRepositoryInitializationPorts = {
  roots: CalendarStorageRoots;
  filesystemUuid: string;
  credentialReference: string;
  mount: BackupMountBinding;
  operationId: string;
  directory: string;
  share: SignedBackupRepository;
  writer: BackupRepositoryLease;
  check(): Promise<void>;
  restic(repository: SignedBackupRepository): { create(): Promise<void>; identify(): Promise<string> };
  /** Explicit source-only admission port. Installed composition never overrides it. */
  openRepository?<T>(
    share: SignedBackupRepository,
    work: (repository: SignedBackupRepository) => Promise<T>,
  ): Promise<T>;
};
type Inode = Readonly<{ device: number; inode: number | string }>;
type Journal = Readonly<{
  contract: 'cos-backup-repository-initialization/v1';
  bindingDigest: string;
  operationId: string;
  phase: 'reserved' | 'claimed' | 'initializing' | 'identified' | 'bound';
  share: Inode;
  repository: Inode | null;
  repositoryId: string | null;
}>;
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const maximumSafe = BigInt(Number.MAX_SAFE_INTEGER);
const maximumInode = (1n << 64n) - 1n;
const inode = (stat: fs.BigIntStats): Inode => {
  // Node's native bigint stat buffer exposes high-bit Linux ino_t values as
  // signed int64. Normalize that representation, never persisted journal data.
  if (stat.ino < -(1n << 63n) || stat.ino > maximumInode) throw Error('initialization_inode_bounds');
  const value = stat.ino < 0n ? BigInt.asUintN(64, stat.ino) : stat.ino;
  if (stat.dev < 0n || stat.dev > maximumSafe || value < 1n) throw Error('initialization_inode_bounds');
  return Object.freeze({
    device: Number(stat.dev),
    // Preserve the existing representation for legacy safe identities.
    inode: value <= maximumSafe ? Number(value) : value.toString(),
  });
};
const validInode = (value: unknown): boolean =>
  typeof value === 'number'
    ? Number.isSafeInteger(value) && value > 0
    : typeof value === 'string' &&
      /^[1-9][0-9]{0,19}$/.test(value) &&
      BigInt(value) > maximumSafe &&
      BigInt(value) <= maximumInode;
const pinned = (fd: number) => '/proc/self/fd/' + fd;
function validateJournal(value: unknown, bindingDigest: string): Journal {
  const identity = (input: unknown) =>
    object(input) &&
    Object.keys(input).sort().join(',') === 'device,inode' &&
    Number.isSafeInteger(input.device) &&
    Number(input.device) >= 0 &&
    validInode(input.inode);
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'bindingDigest,contract,operationId,phase,repository,repositoryId,share' ||
    value.contract !== 'cos-backup-repository-initialization/v1' ||
    value.bindingDigest !== bindingDigest ||
    !uuid(value.operationId) ||
    !['reserved', 'claimed', 'initializing', 'identified', 'bound'].includes(String(value.phase)) ||
    !identity(value.share) ||
    (value.phase === 'reserved' ? value.repository !== null : !identity(value.repository)) ||
    (['identified', 'bound'].includes(String(value.phase)) ? !hash(value.repositoryId) : value.repositoryId !== null)
  )
    throw Error('initialization_journal_conflict');
  return Object.freeze({
    ...value,
    share: Object.freeze({ ...(value.share as Inode) }),
    repository: value.repository ? Object.freeze({ ...(value.repository as Inode) }) : null,
  }) as Journal;
}
/** The encrypted journal is evidence of this operation's original inode, never
 * authority. Every call must independently admit current vault/credential/NAS
 * scopes and hold the actual writer. Unknown or partial resources stay held. */
export async function initializePinnedBackupRepository(
  input: BackupRepositoryInitializationPorts,
): Promise<Record<string, unknown>> {
  let directoryFd: number | undefined;
  try {
    if (
      process.platform !== 'linux' ||
      !uuid(input.operationId) ||
      !uuid(input.filesystemUuid) ||
      !uuid(input.credentialReference) ||
      typeof input.check !== 'function' ||
      typeof input.restic !== 'function' ||
      Object.keys(input.roots).sort().join(',') !== 'dataRoot,installationRoot,targetRoot' ||
      Object.values(input.roots).some(
        (root) => !path.isAbsolute(root) || path.resolve(root) !== root || root === '/' || /[\0\r\n]/.test(root),
      ) ||
      Object.keys(input.mount).sort().join(',') !== 'host,mount,share' ||
      input.mount.share !== 'nanoclaw-cos-backups' ||
      !path.isAbsolute(input.mount.mount) ||
      path.resolve(input.mount.mount) !== input.mount.mount ||
      input.mount.mount === '/'
    )
      throw Error('invalid_initialization_scope');
    backupNasMountCommand({ host: input.mount.host, userId: 1, groupId: 1 });
    const directory = input.directory,
      alias = /^\/proc\/self\/fd\/\d+$/.test(directory);
    if (
      !path.isAbsolute(directory) ||
      path.resolve(directory) !== directory ||
      directory === '/' ||
      (!alias && fs.realpathSync(directory) !== directory)
    )
      throw Error('unsafe_initialization_directory');
    input.writer.assertCurrent();
    input.share.assertCurrent();
    directoryFd = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (alias ? 0 : fs.constants.O_NOFOLLOW),
    );
    const heldDirectory = directoryFd,
      parent = fs.fstatSync(heldDirectory),
      shareStat = fs.fstatSync(input.share.fd),
      shareIdentity = inode(fs.fstatSync(input.share.fd, { bigint: true })),
      bindingDigest = digest({
        rootsDigest: digest(input.roots),
        filesystemUuid: input.filesystemUuid,
        mount: input.mount,
        credentialReference: input.credentialReference,
      });
    const baseGuard = () => {
      input.writer.assertCurrent();
      input.share.assertCurrent();
      for (const stat of [fs.fstatSync(heldDirectory), fs.statSync(directory)])
        if (
          !stat.isDirectory() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o700 ||
          stat.dev !== parent.dev ||
          stat.ino !== parent.ino
        )
          throw Error('initialization_parent_changed');
      if (!alias && fs.realpathSync(directory) !== directory) throw Error('initialization_parent_changed');
    };
    baseGuard();
    const journalName = 'backup-repository-initialization.json',
      profileName = 'backup-repository.json',
      observed = new Map<string, { stat: fs.Stats; digest: string } | null>();
    const metadata = (name: string, ownReplacement = false): unknown => {
      baseGuard();
      const file = path.join(pinned(heldDirectory), name),
        named = fs.lstatSync(file, { throwIfNoEntry: false }),
        previous = observed.get(name);
      if (!named) {
        if (previous) throw Error('initialization_metadata_removed');
        observed.set(name, null);
        return null;
      }
      if (previous === null && !ownReplacement) throw Error('initialization_metadata_appeared');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let bytes: Buffer | undefined;
      try {
        const before = fs.fstatSync(fd);
        const verify = (stat: fs.Stats) => {
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.uid !== parent.uid ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.dev !== parent.dev ||
            stat.dev !== before.dev ||
            stat.ino !== before.ino ||
            stat.size < 1 ||
            stat.size > 8192 ||
            stat.size !== before.size ||
            stat.mtimeMs !== before.mtimeMs ||
            stat.ctimeMs !== before.ctimeMs
          )
            throw Error('initialization_metadata_changed');
          if (
            previous &&
            !ownReplacement &&
            (stat.dev !== previous.stat.dev ||
              stat.ino !== previous.stat.ino ||
              stat.size !== previous.stat.size ||
              stat.mtimeMs !== previous.stat.mtimeMs ||
              stat.ctimeMs !== previous.stat.ctimeMs)
          )
            throw Error('initialization_metadata_changed');
        };
        verify(before);
        verify(named);
        bytes = Buffer.alloc(before.size + 1);
        if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== before.size) throw Error('initialization_metadata_changed');
        verify(fs.fstatSync(fd));
        verify(fs.lstatSync(file));
        baseGuard();
        const value: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, before.size)),
          ),
          fingerprint = digest(value);
        if (previous && !ownReplacement && fingerprint !== previous.digest)
          throw Error('initialization_metadata_changed');
        observed.set(name, { stat: before, digest: fingerprint });
        return value;
      } finally {
        bytes?.fill(0);
        fs.closeSync(fd);
      }
    };
    let journalValue = metadata(journalName),
      profileValue = metadata(profileName);
    const current = async () => {
      baseGuard();
      metadata(journalName);
      metadata(profileName);
      await input.check();
      metadata(profileName);
      metadata(journalName);
      baseGuard();
    };
    const write = (name: string, value: unknown, replace: boolean) => {
      baseGuard();
      metadata(journalName);
      metadata(profileName);
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      if (bytes.length > 8192) throw Error('initialization_metadata_bounds');
      const file = path.join(pinned(heldDirectory), name),
        stage = replace ? file + '.' + randomUUID() + '.partial' : file;
      const fd = fs.openSync(
        stage,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        bytes.fill(0);
        fs.closeSync(fd);
      }
      if (replace) {
        baseGuard();
        metadata(journalName);
        metadata(profileName);
        fs.renameSync(stage, file);
      }
      fs.fsyncSync(heldDirectory);
      metadata(name, true);
      baseGuard();
    };
    let record: Journal;
    const resticPath = path.join(pinned(input.share.fd), 'restic');
    if (journalValue === null) {
      await current();
      if (profileValue !== null || fs.lstatSync(resticPath, { throwIfNoEntry: false }))
        throw Error('unclaimed_repository');
      record = {
        contract: 'cos-backup-repository-initialization/v1',
        bindingDigest,
        operationId: input.operationId,
        phase: 'reserved',
        share: shareIdentity,
        repository: null,
        repositoryId: null,
      };
      write(journalName, record, false);
      journalValue = record;
    } else record = validateJournal(journalValue, bindingDigest);
    if (record.phase !== 'bound' && record.operationId !== input.operationId)
      throw Error('initialization_operation_conflict');
    if (record.phase !== 'bound' && digest(record.share) !== digest(shareIdentity))
      throw Error('initialization_share_changed');
    const persist = async (next: Journal) => {
      await current();
      const selected = validateJournal(next, bindingDigest);
      write(journalName, selected, true);
      record = selected;
      await current();
    };
    if (record.phase === 'reserved') {
      await current();
      if (fs.lstatSync(resticPath, { throwIfNoEntry: false })) throw Error('unclaimed_repository');
      fs.mkdirSync(resticPath, { mode: 0o700 });
      fs.fsyncSync(input.share.fd);
      await current();
      const stat = fs.lstatSync(resticPath, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.uid !== BigInt(process.getuid!()) ||
        (stat.mode & 0o7777n) !== 0o700n ||
        stat.dev !== BigInt(shareStat.dev)
      )
        throw Error('unsafe_created_repository');
      await persist({ ...record, phase: 'claimed', repository: inode(stat) });
    }
    return await (input.openRepository ?? withPinnedBackupRepository)(input.share, async (repository) => {
      const wasBound = record.phase === 'bound';
      const check = async () => {
        repository.assertCurrent();
        await current();
        repository.assertCurrent();
        if (!wasBound && digest(inode(fs.fstatSync(repository.fd, { bigint: true }))) !== digest(record.repository))
          throw Error('initialization_repository_changed');
      };
      await check();
      const utility = input.restic(repository);
      if (record.phase === 'claimed') {
        if (fs.readdirSync(pinned(repository.fd)).length) throw Error('unclaimed_repository_content');
        await persist({ ...record, phase: 'initializing' });
        await check();
        await utility.create();
        await check();
      }
      // An uncertain initialize is never repeated. Only authenticated config
      // and full integrity readback from this claimed inode can reconcile it.
      const repositoryId = await utility.identify();
      await check();
      if (!hash(repositoryId) || (record.repositoryId !== null && record.repositoryId !== repositoryId))
        throw Error('initialization_identity_conflict');
      if (record.phase === 'initializing') await persist({ ...record, phase: 'identified', repositoryId });
      if (!['identified', 'bound'].includes(record.phase)) throw Error('initialization_phase_conflict');
      const profile = {
        contract: 'cos-backup-repository/v1',
        rootsDigest: digest(input.roots),
        filesystemUuid: input.filesystemUuid,
        repositoryId,
        mount: Object.freeze({ ...input.mount }),
      };
      profileValue = metadata(profileName);
      if (profileValue !== null && digest(profileValue) !== digest(profile)) throw Error('repository_profile_conflict');
      await check();
      if (profileValue === null) {
        if (wasBound) throw Error('bound_repository_profile_missing');
        write(profileName, profile, false);
      } else {
        const fd = fs.openSync(
          path.join(pinned(heldDirectory), profileName),
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        try {
          const stat = fs.fstatSync(fd),
            expected = observed.get(profileName);
          if (!expected || !stat.isFile() || stat.dev !== expected.stat.dev || stat.ino !== expected.stat.ino)
            throw Error('profile_sync_identity_changed');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.fsyncSync(heldDirectory);
      }
      await check();
      if (!wasBound) await persist({ ...record, phase: 'bound' });
      await check();
      return Object.freeze({
        contract: 'cos-backup-repository-initialization-result/v1',
        status: wasBound ? 'backup_repository_bound' : 'backup_repository_initialized',
        operationId: record.operationId,
        bindingDigest,
        repositoryId,
        repositoryVersion: 2,
      });
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private endpoint, metadata, credential and utility diagnostics are not public status.
    throw Error('backup_repository_initialization_unavailable');
  } finally {
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
  }
}
