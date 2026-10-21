import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { withVaultDirectory, verifyVaultStorage } from '../ops/vault-storage.js';
import { verifyVaultMemory } from '../ops/vault-memory.js';
import { readPrivate } from '../ops/target-state.js';
export const MAIL_READER_ROOT_MARKER = '.cos-mail-reader';
export type MailReaderRootProof = {
  filesystemUuid: string;
  directoryInodes: { profile: number; credentials: number; accessDenials: number };
  clientSha256: string;
};
export const mailReaderRootIdentity = (roots: CalendarStorageRoots, proof: MailReaderRootProof) => ({
  contract: 'cos-mail-reader-root/v1',
  targetDigest: digest(roots.targetRoot),
  filesystemUuid: proof.filesystemUuid,
  directoryInodes: proof.directoryInodes,
  clientSha256: proof.clientSha256,
});
export type PinnedMailStorage = { root: string; directory: string; readClient(): unknown; assertCurrent(): void };
const privateDirectory = (file: string, device: number) => {
  const stat = fs.lstatSync(file);
  if (
    !stat.isDirectory() ||
    stat.dev !== device ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700 ||
    fs.realpathSync(file) !== file
  )
    throw Error('unsafe_mail_directory');
  return stat;
};
const fileIdentity = (stat: fs.Stats) =>
  digest({
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
/** Dedicated profile beneath the existing encrypted Calendar bind. Its complete
 * subtree is already part of protected Google-state captures. Runtime never
 * rewrites vault-v1 areas or initializes a missing profile proof. */
export async function withMailReaderStorage<T>(
  roots: CalendarStorageRoots,
  operation: (storage: PinnedMailStorage) => Promise<T>,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
): Promise<T> {
  const captured = Object.freeze({ ...roots });
  memory();
  const policy = verifyVaultStorage(captured, inspect),
    root = path.join(policy.vaultRoot, 'google/calendar/mail-reader');
  return withVaultDirectory(
    captured,
    'google/calendar',
    async (parent, current) => {
      const parentStat = fs.statSync(parent),
        handles: number[] = [];
      let active = true;
      try {
        const parentNamed = privateDirectory(path.dirname(root), parentStat.dev);
        if (parentNamed.ino !== parentStat.ino) throw Error('mail_parent_changed');
        const directories = ['', 'credentials', 'access-denials'].map((relative) => {
          current();
          const named = relative ? path.join(root, relative) : root,
            stat = privateDirectory(named, parentStat.dev);
          const fd = fs.openSync(
            relative ? '/proc/self/fd/' + handles[0] + '/' + relative : parent + '/mail-reader',
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
          );
          handles.push(fd);
          const held = fs.fstatSync(fd);
          if (held.dev !== stat.dev || held.ino !== stat.ino) throw Error('mail_directory_changed');
          return { named, stat, fd };
        });
        const directory = '/proc/self/fd/' + handles[0];
        const files = [
          [MAIL_READER_ROOT_MARKER, 4096],
          ['oauth-client.json', 16384],
        ].map(([name, maximum]) => {
          const fd = fs.openSync(
            directory + '/' + name,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
          );
          handles.push(fd);
          const stat = fs.fstatSync(fd),
            named = root + '/' + name;
          if (
            !stat.isFile() ||
            stat.dev !== parentStat.dev ||
            stat.uid !== process.getuid?.() ||
            stat.nlink !== 1 ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.size < 1 ||
            stat.size > Number(maximum) ||
            fileIdentity(fs.lstatSync(named)) !== fileIdentity(stat)
          )
            throw Error('unsafe_mail_configuration');
          return { fd, named, size: stat.size, identity: fileIdentity(stat) };
        });
        const assertCurrent = () => {
          if (!active) throw Error('mail_storage_released');
          current();
          if (
            fs.readdirSync(directory).sort().join(',') !==
            '.cos-mail-reader,access-denials,credentials,oauth-client.json'
          )
            throw Error('mail_configuration_shape');
          for (const { named, stat, fd } of directories) {
            const now = privateDirectory(named, parentStat.dev),
              held = fs.fstatSync(fd);
            if (
              now.ino !== stat.ino ||
              held.ino !== stat.ino ||
              held.dev !== stat.dev ||
              held.uid !== stat.uid ||
              (held.mode & 0o7777) !== 0o700
            )
              throw Error('mail_directory_changed');
          }
          for (const { fd, named, identity } of files)
            if (fileIdentity(fs.fstatSync(fd)) !== identity || fileIdentity(fs.lstatSync(named)) !== identity)
              throw Error('mail_configuration_changed');
          current();
        };
        assertCurrent();
        const readClientBytes = () => {
          assertCurrent();
          const bytes = Buffer.alloc(files[1].size + 1);
          try {
            const count = fs.readSync(files[1].fd, bytes, 0, bytes.length, 0);
            if (count !== files[1].size) throw Error('mail_client_changed');
            assertCurrent();
            return bytes.subarray(0, count);
          } catch (error) {
            bytes.fill(0);
            throw error;
          }
        };
        const bytes = readClientBytes();
        let clientSha256: string;
        try {
          clientSha256 = createHash('sha256').update(bytes).digest('hex');
        } finally {
          bytes.fill(0);
        }
        const directoryInodes = {
          profile: directories[0].stat.ino,
          credentials: directories[1].stat.ino,
          accessDenials: directories[2].stat.ino,
        };
        if (Object.values(directoryInodes).some((ino) => !Number.isSafeInteger(ino) || ino < 1))
          throw Error('mail_directory_identity');
        if (
          digest(readPrivate(directory + '/' + MAIL_READER_ROOT_MARKER, 4096)) !==
          digest(
            mailReaderRootIdentity(captured, {
              filesystemUuid: policy.volume.filesystemUuid,
              directoryInodes,
              clientSha256,
            }),
          )
        )
          throw Error('unowned_mail_root');
        assertCurrent();
        const readClient = () => {
          const bytes = readClientBytes();
          try {
            const client: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            assertCurrent();
            return client;
          } finally {
            bytes.fill(0);
          }
        };
        const result = await operation({ root, directory, readClient, assertCurrent });
        assertCurrent();
        return result;
      } finally {
        active = false;
        for (const fd of handles.reverse()) fs.closeSync(fd);
      }
    },
    inspect,
    memory,
  );
}
