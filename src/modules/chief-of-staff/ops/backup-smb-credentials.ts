import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { readBackupCredentialInstallation } from './backup-credential-install.js';
import { localTarget } from './target-identity.js';
import { verifyVaultMemory } from './vault-memory.js';
import { verifyVaultStorage, withVaultDirectory } from './vault-storage.js';

export type BackupSmbCredentialLease = Readonly<{
  fd: number;
  filesystemUuid: string;
  installationDigest: string;
  assertCurrent(): void;
}>;
export type BackupSmbCredentialScope = Readonly<{
  filesystemUuid: string;
  credentialReference: string;
  targetDigest: string;
  minimumGeneration: number;
}>;
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const prefix = Buffer.from('username=nanoclaw-cos-backup\npassword=');
const maximum = prefix.length + 64 + 1;

/** Owner-side admission only. A root helper duplicates this live child's held descriptor;
 * mount.cifs receives that descriptor rather than reopening a canonical credential path.
 * Validation stays bounded, never decodes the password and wipes every borrowed read buffer.
 */
export async function withVaultSmbCredentials<T>(
  roots: CalendarStorageRoots,
  expected: BackupSmbCredentialScope,
  operation: (lease: BackupSmbCredentialLease) => Promise<T>,
): Promise<T> {
  try {
    if (
      !expected ||
      typeof expected !== 'object' ||
      Array.isArray(expected) ||
      Object.keys(expected).sort().join(',') !== 'credentialReference,filesystemUuid,minimumGeneration,targetDigest' ||
      !uuid(expected.filesystemUuid) ||
      !uuid(expected.credentialReference) ||
      !/^[a-f0-9]{64}$/.test(expected.targetDigest) ||
      !Number.isSafeInteger(expected.minimumGeneration) ||
      expected.minimumGeneration < 1
    )
      throw Error('invalid_credential_scope');
    // Callers cannot mutate a shared input while the callback is awaited.
    const scope = Object.freeze({ ...expected });
    return await withVaultDirectory(roots, 'backup-credentials', async (directory) => {
      verifyVaultMemory();
      const policy = verifyVaultStorage(roots),
        target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
      if (
        policy.volume.filesystemUuid !== scope.filesystemUuid ||
        target.lifecycle !== 'protected' ||
        !target.releaseId ||
        target.generation < scope.minimumGeneration ||
        digest(target.binding) !== scope.targetDigest
      )
        throw Error('credential_scope_changed');
      const policyDigest = digest(policy),
        targetSnapshot = digest(target);
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
      let fd: number | undefined,
        active = false;
      try {
        const root = fs.fstatSync(rootFd),
          canonical = path.join(policy.vaultRoot, 'backup-credentials');
        if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o7777) !== 0o700)
          throw Error('unsafe_credential_directory');
        const at = '/proc/self/fd/' + rootFd;
        const installation = readBackupCredentialInstallation(at, roots, scope.filesystemUuid);
        if (installation.credentialReference !== scope.credentialReference) throw Error('credential_reference_changed');
        const installationDigest = digest(installation),
          file = path.join(at, 'smb-credentials');
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const heldFd = fd,
          initial = fs.fstatSync(heldFd);
        active = true;
        const assertCurrent = () => {
          try {
            if (!active) throw Error('released_credential');
            verifyVaultMemory();
            if (
              digest(verifyVaultStorage(roots)) !== policyDigest ||
              digest(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot)) !== targetSnapshot ||
              digest(readBackupCredentialInstallation(at, roots, scope.filesystemUuid)) !== installationDigest
            )
              throw Error('credential_authority_changed');
            const heldRoot = fs.fstatSync(rootFd),
              currentRoot = fs.lstatSync(canonical),
              stat = fs.fstatSync(heldFd),
              current = fs.lstatSync(file);
            if (
              !heldRoot.isDirectory() ||
              heldRoot.nlink < 2 ||
              heldRoot.uid !== root.uid ||
              (heldRoot.mode & 0o7777) !== 0o700 ||
              heldRoot.dev !== root.dev ||
              heldRoot.ino !== root.ino ||
              !currentRoot.isDirectory() ||
              currentRoot.uid !== root.uid ||
              (currentRoot.mode & 0o7777) !== 0o700 ||
              currentRoot.dev !== root.dev ||
              currentRoot.ino !== root.ino ||
              !stat.isFile() ||
              stat.nlink !== 1 ||
              stat.uid !== root.uid ||
              stat.dev !== root.dev ||
              (stat.mode & 0o7777) !== 0o600 ||
              stat.size < prefix.length + 16 + 1 ||
              stat.size > maximum ||
              stat.dev !== initial.dev ||
              stat.ino !== initial.ino ||
              stat.size !== initial.size ||
              stat.mtimeMs !== initial.mtimeMs ||
              stat.ctimeMs !== initial.ctimeMs ||
              current.dev !== initial.dev ||
              current.ino !== initial.ino
            )
              throw Error('credential_changed');
          } catch {
            // eslint-disable-next-line preserve-caught-error -- No credential paths or nested private diagnostics cross the boundary.
            throw Error('backup_smb_credentials_unavailable');
          }
        };
        assertCurrent();
        const bytes = Buffer.alloc(maximum + 1);
        try {
          const length = fs.readSync(heldFd, bytes, 0, bytes.length, 0);
          if (length !== initial.size || !bytes.subarray(0, prefix.length).equals(prefix) || bytes[length - 1] !== 10)
            throw Error('invalid_smb_credentials');
          const password = bytes.subarray(prefix.length, length - 1);
          if (!isUtf8(password) || password.includes(0) || password.includes(10) || password.includes(13))
            throw Error('invalid_smb_credentials');
          assertCurrent();
        } finally {
          bytes.fill(0);
        }
        const lease = Object.freeze({
          fd: heldFd,
          filesystemUuid: scope.filesystemUuid,
          installationDigest,
          assertCurrent,
        });
        const result = await operation(lease);
        assertCurrent();
        return result;
      } finally {
        active = false;
        try {
          if (fd !== undefined) fs.closeSync(fd);
        } finally {
          fs.closeSync(rootFd);
        }
      }
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Subprocess callbacks can contain credential-bearing diagnostics.
    throw Error('backup_smb_credentials_unavailable');
  }
}
