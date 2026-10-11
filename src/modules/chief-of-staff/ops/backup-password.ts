import fs from 'node:fs';
import path from 'node:path';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { withVaultDirectory, verifyVaultStorage } from './vault-storage.js';
import { verifyVaultMemory } from './vault-memory.js';
import { readBackupCredentialInstallation } from './backup-credential-install.js';
export type BackupPassword = Readonly<{ fd: number; assertCurrent(): void }>;
/** Trusted transport only. The secret is read by Restic through an inherited descriptor;
 * this process never decodes it, copies it to an argument/environment variable or logs it. */
export async function withVaultResticPassword<T>(
  roots: CalendarStorageRoots,
  operation: (password: BackupPassword) => Promise<T>,
): Promise<T> {
  try {
    return await withVaultDirectory(roots, 'backup-credentials', async (directory, assertVault) => {
      if (typeof assertVault !== 'function') throw Error('vault_scope_required');
      assertVault();
      verifyVaultMemory();
      const policy = verifyVaultStorage(roots);
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
        const root = fs.fstatSync(rootFd);
        if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700)
          throw Error('unsafe_credential_directory');
        const installation = readBackupCredentialInstallation(
          '/proc/self/fd/' + rootFd,
          roots,
          policy.volume.filesystemUuid,
        );
        const file = path.join('/proc/self/fd/' + rootFd, 'restic-password');
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const heldFd = fd,
          initial = fs.fstatSync(heldFd);
        active = true;
        const assertCurrent = () => {
          try {
            if (!active) throw Error('released_credential');
            verifyVaultMemory();
            if (
              digest(
                readBackupCredentialInstallation('/proc/self/fd/' + rootFd, roots, policy.volume.filesystemUuid),
              ) !== digest(installation)
            )
              throw Error('credential_installation_changed');
            assertVault();
            const stat = fs.fstatSync(heldFd),
              current = fs.lstatSync(file),
              currentRoot = fs.statSync(directory);
            if (
              !stat.isFile() ||
              stat.nlink !== 1 ||
              stat.uid !== root.uid ||
              stat.dev !== root.dev ||
              (stat.mode & 0o777) !== 0o600 ||
              stat.size < 32 ||
              stat.size > 4096 ||
              stat.dev !== initial.dev ||
              stat.ino !== initial.ino ||
              stat.size !== initial.size ||
              stat.mtimeMs !== initial.mtimeMs ||
              stat.ctimeMs !== initial.ctimeMs ||
              current.dev !== initial.dev ||
              current.ino !== initial.ino ||
              !currentRoot.isDirectory() ||
              currentRoot.uid !== root.uid ||
              (currentRoot.mode & 0o777) !== 0o700 ||
              currentRoot.dev !== root.dev ||
              currentRoot.ino !== root.ino
            )
              throw Error('credential_changed');
          } catch {
            // eslint-disable-next-line preserve-caught-error -- Credential paths and process diagnostics are private.
            throw Error('backup_password_unavailable');
          }
        };
        const password = Object.freeze({ fd: heldFd, assertCurrent });
        password.assertCurrent();
        const result = await operation(password);
        password.assertCurrent();
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
    // eslint-disable-next-line preserve-caught-error -- Vault callbacks may include secret subprocess diagnostics.
    throw Error('backup_password_unavailable');
  }
}
