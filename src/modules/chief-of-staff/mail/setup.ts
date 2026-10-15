import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { checkedClient, type GoogleOAuthClient } from '../calendar/oauth-core.js';
import { credentialRootMarker } from '../calendar/credential-core.js';
import { accessFenceRootMarker } from '../calendar/access-fences.js';
import { verifyVaultStorage, withVaultDirectory } from '../ops/vault-storage.js';
import { verifyVaultMemory } from '../ops/vault-memory.js';
import { digest } from '../domain/contracts.js';
import { MAIL_READER_ROOT_MARKER, mailReaderRootIdentity, withMailReaderStorage } from './storage.js';
type Step = 'intent' | 'directories' | 'client' | 'markers' | 'proof';
const intentName = '.cos-mail-reader-initializing';
const directoryProofName = '.cos-mail-reader-setup-directories';
const descriptor = (fd: number) => '/proc/self/fd/' + fd;
const uuid = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
/** flock the held encrypted parent inode itself; no named lock file can be
 * redirected to an unmounted underlay. Closing our descriptor releases it. */
async function parentLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd],
        env: { PATH: '/usr/bin:/bin' },
        timeout: 5000,
      });
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve() : reject(Error('mail_setup_busy'))));
    });
    return await operation();
  } finally {
    fs.closeSync(fd);
  }
}
/** Trusted owner setup only. No runtime, model or worker calls this. The caller
 * supplies fresh installed administration authority; fixture seams never supply
 * production memory, mount or authority defaults. No OAuth consent is implied. */
export async function initializeMailProfile(
  roots: CalendarStorageRoots,
  client: GoogleOAuthClient,
  authority: { operationId: string; assertAuthority(): void },
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
  hooks: { afterStep?(step: Step): Promise<void> } = {},
): Promise<{ status: 'ready' }> {
  let clientBytes: Buffer | undefined;
  try {
    if (!authority || !uuid(authority.operationId) || typeof authority.assertAuthority !== 'function')
      throw Error('setup_authority_required');
    authority.assertAuthority();
    memory();
    roots = Object.freeze({ ...roots });
    client = checkedClient(client);
    clientBytes = Buffer.from(
      JSON.stringify({
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
      }) + '\n',
    );
    const policy = verifyVaultStorage(roots, inspect),
      namedRoot = path.join(policy.vaultRoot, 'google/calendar/mail-reader');
    return await withVaultDirectory(
      roots,
      'google/calendar',
      (parent, parentCurrent) =>
        parentLock(parent, async () => {
          const handles: number[] = [],
            directories: Array<{ named: string; fd: number; ino: number }> = [];
          const device = fs.statSync(parent).dev;
          const current = () => {
            authority.assertAuthority();
            parentCurrent();
            for (const { named, fd, ino } of directories) {
              const held = fs.fstatSync(fd),
                now = fs.lstatSync(named);
              if (
                !held.isDirectory() ||
                !now.isDirectory() ||
                held.dev !== device ||
                now.dev !== device ||
                held.ino !== ino ||
                now.ino !== ino ||
                held.uid !== process.getuid?.() ||
                now.uid !== held.uid ||
                (held.mode & 0o7777) !== 0o700 ||
                (now.mode & 0o7777) !== 0o700 ||
                fs.realpathSync(named) !== named
              )
                throw Error('setup_directory_changed');
            }
            parentCurrent();
          };
          const pin = (parent: string, name: string, named: string) => {
            current();
            try {
              fs.mkdirSync(parent + '/' + name, { mode: 0o700 });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            const fd = fs.openSync(
              parent + '/' + name,
              fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
            );
            handles.push(fd);
            const stat = fs.fstatSync(fd);
            if (!Number.isSafeInteger(stat.ino) || stat.ino < 1) throw Error('setup_directory_identity');
            directories.push({ named, fd, ino: stat.ino });
            current();
            return fd;
          };
          const shape = (fd: number, allowed: string[]) => {
            if (fs.readdirSync(descriptor(fd)).some((name) => !allowed.includes(name)))
              throw Error('unowned_setup_files');
          };
          const ensure = (directory: number, name: string, bytes: Buffer) => {
            current();
            const file = descriptor(directory) + '/' + name;
            let fd: number;
            try {
              fd = fs.openSync(
                file,
                fs.constants.O_RDWR |
                  fs.constants.O_CREAT |
                  fs.constants.O_EXCL |
                  fs.constants.O_NOFOLLOW |
                  fs.constants.O_NONBLOCK,
                0o600,
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            }
            let prefix: Buffer | undefined;
            try {
              const stat = fs.fstatSync(fd),
                named = fs.lstatSync(file);
              if (
                !stat.isFile() ||
                stat.dev !== device ||
                stat.uid !== process.getuid?.() ||
                (stat.mode & 0o7777) !== 0o600 ||
                stat.nlink !== 1 ||
                stat.size > bytes.length ||
                named.dev !== stat.dev ||
                named.ino !== stat.ino
              )
                throw Error('unsafe_setup_file');
              prefix = Buffer.alloc(stat.size);
              if (
                fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length ||
                !prefix.equals(bytes.subarray(0, prefix.length))
              )
                throw Error('foreign_setup_bytes');
              const stable = fs.fstatSync(fd);
              if (stable.size !== stat.size || stable.mtimeMs !== stat.mtimeMs || stable.ctimeMs !== stat.ctimeMs)
                throw Error('setup_file_changed');
              current();
              let offset = stat.size;
              while (offset < bytes.length) {
                const now = fs.lstatSync(file);
                if (now.dev !== stat.dev || now.ino !== stat.ino || now.nlink !== 1) throw Error('setup_file_changed');
                current();
                const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
                if (!count) throw Error('setup_write_incomplete');
                offset += count;
              }
              fs.fsyncSync(fd);
              fs.fsyncSync(directory);
              current();
              const now = fs.lstatSync(file);
              if (now.dev !== stat.dev || now.ino !== stat.ino || now.size !== bytes.length || now.nlink !== 1)
                throw Error('setup_file_changed');
            } finally {
              prefix?.fill(0);
              fs.closeSync(fd);
            }
          };
          try {
            const root = pin(parent, 'mail-reader', namedRoot),
              rootPath = descriptor(root);
            const names = fs.readdirSync(rootPath);
            shape(root, [
              intentName,
              directoryProofName,
              MAIL_READER_ROOT_MARKER,
              'credentials',
              'access-denials',
              'oauth-client.json',
            ]);
            const verifyCompleted = () =>
              withMailReaderStorage(
                roots,
                async (storage) => {
                  current();
                  if (digest(checkedClient(storage.readClient() as GoogleOAuthClient)) !== digest(client))
                    throw Error('setup_client_changed');
                  for (const [child, marker] of [
                    ['credentials', credentialRootMarker('mail_reader')],
                    ['access-denials', accessFenceRootMarker()],
                  ] as const) {
                    storage.assertCurrent();
                    const directory = fs.openSync(
                      storage.directory + '/' + child,
                      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
                    );
                    let fd: number | undefined, bytes: Buffer | undefined;
                    try {
                      fd = fs.openSync(
                        descriptor(directory) + '/' + marker.name,
                        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
                      );
                      const stat = fs.fstatSync(fd),
                        expected = Buffer.from(marker.contents);
                      if (
                        !stat.isFile() ||
                        stat.dev !== device ||
                        stat.uid !== process.getuid?.() ||
                        (stat.mode & 0o7777) !== 0o600 ||
                        stat.nlink !== 1 ||
                        stat.size !== expected.length
                      )
                        throw Error('setup_marker_changed');
                      bytes = Buffer.alloc(expected.length + 1);
                      if (
                        fs.readSync(fd, bytes, 0, bytes.length, 0) !== expected.length ||
                        !bytes.subarray(0, expected.length).equals(expected)
                      )
                        throw Error('setup_marker_changed');
                      const after = fs.fstatSync(fd);
                      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
                        throw Error('setup_marker_changed');
                      storage.assertCurrent();
                      current();
                    } finally {
                      bytes?.fill(0);
                      if (fd !== undefined) fs.closeSync(fd);
                      fs.closeSync(directory);
                    }
                  }
                  return { status: 'ready' as const };
                },
                inspect,
                memory,
              );
            if (!names.includes(intentName) && names.includes(MAIL_READER_ROOT_MARKER)) {
              return await verifyCompleted();
            }
            if (names.length && !names.includes(intentName)) throw Error('unowned_mail_setup');
            const intent = Buffer.from(
              JSON.stringify({
                contract: 'cos-mail-profile-setup/v1',
                targetDigest: digest(roots.targetRoot),
                operationId: authority.operationId,
                filesystemUuid: policy.volume.filesystemUuid,
                profileInode: fs.fstatSync(root).ino,
                clientSha256: createHash('sha256').update(clientBytes!).digest('hex'),
              }) + '\n',
            );
            ensure(root, intentName, intent);
            const step = async (value: Step) => {
              current();
              await hooks.afterStep?.(value);
              current();
            };
            await step('intent');
            const credentials = pin(rootPath, 'credentials', namedRoot + '/credentials'),
              fences = pin(rootPath, 'access-denials', namedRoot + '/access-denials');
            const credentialMarker = credentialRootMarker('mail_reader'),
              fenceMarker = accessFenceRootMarker();
            shape(credentials, [credentialMarker.name]);
            shape(fences, [fenceMarker.name]);
            ensure(
              root,
              directoryProofName,
              Buffer.from(
                JSON.stringify({
                  contract: 'cos-mail-profile-setup-directories/v1',
                  intentDigest: createHash('sha256').update(intent).digest('hex'),
                  credentialsInode: fs.fstatSync(credentials).ino,
                  accessDenialsInode: fs.fstatSync(fences).ino,
                }) + '\n',
              ),
            );
            await step('directories');
            ensure(root, 'oauth-client.json', clientBytes!);
            await step('client');
            ensure(credentials, credentialMarker.name, Buffer.from(credentialMarker.contents));
            ensure(fences, fenceMarker.name, Buffer.from(fenceMarker.contents));
            await step('markers');
            ensure(
              root,
              MAIL_READER_ROOT_MARKER,
              Buffer.from(
                JSON.stringify(
                  mailReaderRootIdentity(roots, {
                    filesystemUuid: policy.volume.filesystemUuid,
                    directoryInodes: {
                      profile: fs.fstatSync(root).ino,
                      credentials: fs.fstatSync(credentials).ino,
                      accessDenials: fs.fstatSync(fences).ino,
                    },
                    clientSha256: createHash('sha256').update(clientBytes!).digest('hex'),
                  }),
                ) + '\n',
              ),
            );
            await step('proof');
            current();
            fs.unlinkSync(rootPath + '/' + directoryProofName);
            fs.fsyncSync(root);
            fs.unlinkSync(rootPath + '/' + intentName);
            fs.fsyncSync(root);
            current();
            return await verifyCompleted();
          } finally {
            for (const fd of handles.reverse()) fs.closeSync(fd);
          }
        }),
      inspect,
      memory,
    );
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Client bytes, private paths and nested setup diagnostics never cross this owner boundary.
    throw Error('mail_profile_initialization_unavailable');
  } finally {
    clientBytes?.fill(0);
  }
}
