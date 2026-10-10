import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { localTarget } from './target-identity.js';
import { writeAtomic } from './target-state.js';
import { verifyVaultStorage, withVaultDirectory } from './vault-storage.js';
import { verifyVaultMemory } from './vault-memory.js';
import { consumeBackupCredentials } from './backup-credential-wire.js';

type Installation = {
  contract: 'cos-backup-credential-installation/v1';
  rootsDigest: string;
  filesystemUuid: string;
  operationId: string;
  credentialReference: string;
  phase: 'preparing' | 'ready';
};
const journal = 'backup-credential-installation.json';
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const pinned = (fd: number) => '/proc/self/fd/' + fd;
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
function privateFile(stat: fs.Stats, root: fs.Stats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== root.uid ||
    stat.dev !== root.dev ||
    (stat.mode & 0o777) !== 0o600
  )
    throw Error('unsafe_backup_credential_file');
}
function readInstallation(
  directory: string,
  roots: CalendarStorageRoots,
  filesystemUuid: string,
  preparing: boolean,
): Installation {
  const root = fs.statSync(directory);
  if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700)
    throw Error('unsafe_backup_credential_directory');
  const file = path.join(directory, journal);
  const fd = fs.openSync(file, flags);
  let bytes: Buffer | undefined;
  try {
    const stat = fs.fstatSync(fd);
    privateFile(stat, root);
    if (stat.size < 1 || stat.size > 4096) throw Error('installation_bounds');
    bytes = Buffer.alloc(stat.size + 1);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) throw Error('installation_changed');
    const after = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino
    )
      throw Error('installation_changed');
    const value: Installation = JSON.parse(bytes.subarray(0, stat.size).toString('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'contract,credentialReference,filesystemUuid,operationId,phase,rootsDigest' ||
      value.contract !== 'cos-backup-credential-installation/v1' ||
      value.rootsDigest !== digest(roots) ||
      !uuid(filesystemUuid) ||
      value.filesystemUuid !== filesystemUuid ||
      !uuid(value.operationId) ||
      !uuid(value.credentialReference) ||
      (value.phase !== 'ready' && !(preparing && value.phase === 'preparing'))
    )
      throw Error('installation_conflict');
    return Object.freeze(value);
  } finally {
    bytes?.fill(0);
    fs.closeSync(fd);
  }
}
/** The marker records completion, never authority. Callers still verify the live vault and process protections. */
export function readBackupCredentialInstallation(
  directory: string,
  roots: CalendarStorageRoots,
  filesystemUuid: string,
): Installation {
  try {
    return readInstallation(directory, roots, filesystemUuid, false);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Credential paths and private setup metadata are not diagnostics.
    throw Error('backup_credential_installation_unavailable');
  }
}

/** Fresh owner/OS-operation authority is mandatory. The input buffer transfers ownership.
 * Exclusive writes preserve existing credentials. Interrupted preparation remains closed
 * and can resume only with the same operation, recovery reference and exact bytes.
 */
export async function installBackupCredentials(input: {
  roots: CalendarStorageRoots;
  operationId: string;
  credentialReference: string;
  bytes: Buffer;
  check(): Promise<void>;
  assertAuthority(): void;
}) {
  try {
    verifyVaultMemory();
    input.assertAuthority();
    if (!uuid(input.operationId) || !uuid(input.credentialReference)) throw Error('invalid_credential_installation');
    const { roots } = input;
    const policy = verifyVaultStorage(roots);
    const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
    if (target.lifecycle !== 'protected' || !target.maintenance || !uuid(target.maintenanceId) || !target.releaseId)
      throw Error('protected_maintenance_required');
    const identity = {
      contract: 'cos-backup-credential-installation/v1' as const,
      rootsDigest: digest(roots),
      filesystemUuid: policy.volume.filesystemUuid,
      operationId: input.operationId,
      credentialReference: input.credentialReference,
    };
    return await withVaultDirectory(roots, 'backup-credentials', async (directory) => {
      const alias = /^\/proc\/self\/fd\/\d+$/.test(directory);
      if (
        !path.isAbsolute(directory) ||
        path.resolve(directory) !== directory ||
        (!alias && fs.realpathSync(directory) !== directory)
      )
        throw Error('unsafe_credential_directory');
      const rootFd = fs.openSync(
        directory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (alias ? 0 : fs.constants.O_NOFOLLOW),
      );
      try {
        const root = fs.fstatSync(rootFd),
          canonical = path.join(policy.vaultRoot, 'backup-credentials');
        const guard = () => {
          verifyVaultMemory();
          input.assertAuthority();
          const current = fs.lstatSync(canonical),
            held = fs.fstatSync(rootFd);
          if (
            !current.isDirectory() ||
            current.uid !== process.getuid?.() ||
            (current.mode & 0o777) !== 0o700 ||
            current.dev !== root.dev ||
            current.ino !== root.ino ||
            held.nlink < 2 ||
            digest(verifyVaultStorage(roots)) !== digest(policy) ||
            digest(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot)) !== digest(target)
          )
            throw Error('credential_authority_changed');
        };
        const check = async () => {
          guard();
          await input.check();
          guard();
        };
        const writeNew = (name: string, bytes: Buffer) => {
          guard();
          const fd = fs.openSync(
            path.join(pinned(rootFd), name),
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            fs.fchmodSync(fd, 0o600);
            privateFile(fs.fstatSync(fd), root);
            guard();
            fs.writeFileSync(fd, bytes);
            fs.fsyncSync(fd);
            guard();
          } finally {
            fs.closeSync(fd);
          }
          fs.fsyncSync(rootFd);
          guard();
        };
        const matches = (name: string, expected: Buffer) => {
          guard();
          const file = path.join(pinned(rootFd), name);
          const fd = fs.openSync(file, flags);
          const bytes = Buffer.alloc(expected.length + 1);
          try {
            const initial = fs.fstatSync(fd);
            privateFile(initial, root);
            if (
              initial.size !== expected.length ||
              fs.readSync(fd, bytes, 0, bytes.length, 0) !== expected.length ||
              !timingSafeEqual(bytes.subarray(0, expected.length), expected)
            )
              throw Error('credential_replay_conflict');
            // A previous write may have reached page cache but failed its durability check.
            fs.fsyncSync(fd);
            fs.fsyncSync(rootFd);
            const after = fs.fstatSync(fd),
              current = fs.lstatSync(file);
            if (
              after.size !== initial.size ||
              after.mtimeMs !== initial.mtimeMs ||
              after.ctimeMs !== initial.ctimeMs ||
              current.dev !== initial.dev ||
              current.ino !== initial.ino
            )
              throw Error('credential_changed');
            guard();
          } finally {
            bytes.fill(0);
            fs.closeSync(fd);
          }
        };
        await check();
        await consumeBackupCredentials(input.bytes, async ({ smbPassword, resticPassword }) => {
          const smb = Buffer.concat([
            Buffer.from('username=nanoclaw-cos-backup\npassword='),
            smbPassword,
            Buffer.from('\n'),
          ]);
          const restic = Buffer.concat([resticPassword, Buffer.from('\n')]);
          try {
            await check();
            const at = pinned(rootFd),
              file = path.join(at, journal);
            let marker: Installation;
            if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
              for (const name of ['smb-credentials', 'restic-password', 'backup-repository.json'])
                if (fs.lstatSync(path.join(at, name), { throwIfNoEntry: false }))
                  throw Error('unclaimed_backup_credentials');
              marker = { ...identity, phase: 'preparing' };
              const bytes = Buffer.from(JSON.stringify(marker) + '\n');
              try {
                writeNew(journal, bytes);
              } finally {
                bytes.fill(0);
              }
            } else marker = readInstallation(at, roots, identity.filesystemUuid, true);
            if (digest({ ...marker, phase: undefined }) !== digest({ ...identity, phase: undefined }))
              throw Error('credential_installation_scope_conflict');
            for (const [name, bytes] of [
              ['smb-credentials', smb],
              ['restic-password', restic],
            ] as const) {
              await check();
              if (!fs.lstatSync(path.join(at, name), { throwIfNoEntry: false })) {
                if (marker.phase !== 'preparing') throw Error('completed_credential_missing');
                writeNew(name, bytes);
              }
              matches(name, bytes);
            }
            await check();
            if (marker.phase === 'preparing') {
              if (digest(readInstallation(at, roots, identity.filesystemUuid, true)) !== digest(marker))
                throw Error('installation_marker_changed');
              guard();
              writeAtomic(at, journal, { ...identity, phase: 'ready' });
            }
            matches('smb-credentials', smb);
            matches('restic-password', restic);
            readBackupCredentialInstallation(at, roots, identity.filesystemUuid);
            await check();
          } finally {
            smb.fill(0);
            restic.fill(0);
          }
        });
        guard();
        return Object.freeze({
          contract: 'cos-backup-credential-installation-result/v1' as const,
          status: 'ready' as const,
          rootsDigest: identity.rootsDigest,
          filesystemUuid: identity.filesystemUuid,
        });
      } finally {
        fs.closeSync(rootFd);
      }
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Neither credential contents nor nested filesystem/authority errors leave this boundary.
    throw Error('backup_credential_installation_unavailable');
  } finally {
    if (Buffer.isBuffer(input.bytes)) input.bytes.fill(0);
  }
}
