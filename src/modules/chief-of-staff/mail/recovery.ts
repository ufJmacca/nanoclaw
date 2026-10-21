import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { credentialRootMarker } from '../calendar/credential-core.js';
import { accessFenceRootMarker } from '../calendar/access-fences.js';
import { withVaultDirectory } from '../ops/vault-storage.js';
import { verifyVaultMemory } from '../ops/vault-memory.js';
import { createVaultCredentialJournal } from '../ops/backup-credential-journal.js';
import type { CredentialJournal } from '../ops/backup-credential-event.js';
import { digest } from '../domain/contracts.js';
import { MAIL_READER_ROOT_MARKER, withMailReaderStorage } from './storage.js';
type RecoveryPage = {
  status: 'recorded' | 'not_configured';
  recorded: number;
  next_after: string | null;
  open_checks: number;
};
const descriptor = (fd: number) => '/proc/self/fd/' + fd;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat: fs.Stats) =>
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
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
/** Local encrypted recovery capture only. Immutable configuration and first
 * access-denial records have stable source identities, never one per read poll.
 * Tokens retain their separate credential-owner journal. Transient read-check
 * ownership is reported, not promoted into a credential or restored authority. */
export async function recordMailRecoveryPage(
  roots: CalendarStorageRoots,
  options: { assertAuthority(): void; after?: string },
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
  journal?: CredentialJournal,
): Promise<RecoveryPage> {
  try {
    roots = Object.freeze({ ...roots });
    options = Object.freeze({ ...options });
    if (
      typeof options.assertAuthority !== 'function' ||
      (options.after !== undefined && !/^[a-f0-9]{64}\.json$/.test(options.after)) ||
      (journal !== undefined && typeof journal !== 'function')
    )
      throw Error('invalid_recovery_request');
    options.assertAuthority();
    memory();
    const record = journal ?? createVaultCredentialJournal(roots, memory);
    return await withVaultDirectory(
      roots,
      'google/calendar',
      async (parent, parentCurrent) => {
        parentCurrent();
        options.assertAuthority();
        if (!fs.lstatSync(parent + '/mail-reader', { throwIfNoEntry: false }))
          return { status: 'not_configured', recorded: 0, next_after: null, open_checks: 0 };
        return withMailReaderStorage(
          roots,
          async (storage): Promise<RecoveryPage> => {
            const handles: number[] = [],
              buffers: Buffer[] = [],
              files: Array<{ fd: number; name: string; identity: string }> = [];
            const device = fs.statSync(storage.directory).dev;
            const current = () => {
              options.assertAuthority();
              storage.assertCurrent();
              parentCurrent();
              for (const file of files)
                if (
                  identity(fs.fstatSync(file.fd)) !== file.identity ||
                  identity(fs.lstatSync(file.name)) !== file.identity
                )
                  throw Error('recovery_source_changed');
              storage.assertCurrent();
            };
            const directory = (name: string) => {
              current();
              const fd = fs.openSync(
                storage.directory + '/' + name,
                fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
              );
              handles.push(fd);
              current();
              return fd;
            };
            const hold = (directory: string, name: string, maximum: number) => {
              current();
              const file = directory + '/' + name,
                fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
              handles.push(fd);
              const stat = fs.fstatSync(fd);
              if (
                !stat.isFile() ||
                stat.dev !== device ||
                stat.uid !== process.getuid?.() ||
                stat.nlink !== 1 ||
                (stat.mode & 0o7777) !== 0o600 ||
                stat.size < 1 ||
                stat.size > maximum
              )
                throw Error('unsafe_recovery_file');
              files.push({ fd, name: file, identity: identity(stat) });
              const bytes = Buffer.alloc(stat.size + 1);
              buffers.push(bytes);
              if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) throw Error('recovery_source_changed');
              current();
              return bytes.subarray(0, stat.size);
            };
            const transient = (directory: number, name: string, maximum: number): boolean => {
              let fd: number | undefined;
              try {
                fd = fs.openSync(
                  descriptor(directory) + '/' + name,
                  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
                );
                const stat = fs.fstatSync(fd);
                if (
                  !stat.isFile() ||
                  stat.dev !== device ||
                  stat.uid !== process.getuid?.() ||
                  stat.nlink !== 1 ||
                  (stat.mode & 0o7777) !== 0o600 ||
                  stat.size > maximum
                )
                  throw Error('unsafe_access_check');
                current();
                return true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw error;
              } finally {
                if (fd !== undefined) fs.closeSync(fd);
              }
            };
            try {
              const credentials = directory('credentials'),
                denials = directory('access-denials');
              const profile = hold(storage.directory, MAIL_READER_ROOT_MARKER, 4096),
                client = hold(storage.directory, 'oauth-client.json', 16384);
              const credentialMarker = credentialRootMarker('mail_reader'),
                fenceMarker = accessFenceRootMarker();
              const credentialProfile = hold(descriptor(credentials), credentialMarker.name, 1024),
                denialProfile = hold(descriptor(denials), fenceMarker.name, 1024);
              if (
                credentialProfile.toString('utf8') !== credentialMarker.contents ||
                denialProfile.toString('utf8') !== fenceMarker.contents
              )
                throw Error('recovery_profile_changed');
              const sourceKey = digest({
                contract: 'cos-mail-recovery-configuration/v1',
                targetDigest: digest(roots.targetRoot),
                profileProofSha256: hash(profile),
              });
              let recorded = 0;
              if (options.after === undefined) {
                await record(
                  {
                    sourceKind: 'mail_reader',
                    sourceKey,
                    generation: 1,
                    phase: 'ready',
                    files: [
                      { name: 'profile-proof.json', bytes: profile },
                      { name: 'oauth-client.json', bytes: client },
                      { name: 'credential-profile.json', bytes: credentialProfile },
                      { name: 'denial-profile.txt', bytes: denialProfile },
                    ],
                  },
                  current,
                );
                current();
                recorded++;
              }
              const names: string[] = [],
                reader = fs.opendirSync(descriptor(denials));
              try {
                for (let entry = reader.readSync(); entry; entry = reader.readSync()) {
                  names.push(entry.name);
                  if (names.length > 4096) throw Error('recovery_inventory_limit');
                }
              } finally {
                reader.closeSync();
              }
              const selected = names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
              let openChecks = 0;
              for (const name of names) {
                if (name === fenceMarker.name || /^[a-f0-9]{64}\.json$/.test(name)) continue;
                if (/^[a-f0-9]{64}\.json\.pending$/.test(name)) {
                  if (transient(denials, name, 1024) && !selected.includes(name.slice(0, -8))) openChecks++;
                } else if (/^[a-f0-9]{64}\.json\.check\.lock$/.test(name)) transient(denials, name, 0);
                else throw Error('unknown_recovery_file');
              }
              const remaining = selected.filter((name) => options.after === undefined || name > options.after),
                page = remaining.slice(0, 10);
              for (const name of page) {
                const bytes = hold(descriptor(denials), name, 1024),
                  denial = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<
                    string,
                    unknown
                  >;
                if (
                  !denial ||
                  Object.keys(denial).sort().join(',') !== 'at,auth,bindingId,scopeDigest,version' ||
                  denial.version !== 1 ||
                  !hex(denial.scopeDigest) ||
                  !uuid(denial.bindingId) ||
                  !['expired', 'revoked', 'disconnected'].includes(String(denial.auth)) ||
                  typeof denial.at !== 'string' ||
                  denial.at.length > 40 ||
                  !Number.isFinite(Date.parse(denial.at))
                )
                  throw Error('invalid_recovery_denial');
                const envelope = Buffer.from(
                  JSON.stringify({
                    contract: 'cos-mail-denial-recovery/v1',
                    configurationSource: sourceKey,
                    filename: name,
                    sha256: hash(bytes),
                  }) + '\n',
                );
                buffers.push(envelope);
                await record(
                  {
                    sourceKind: 'mail_reader',
                    sourceKey: digest({
                      contract: 'cos-mail-recovery-denial/v1',
                      configurationSource: sourceKey,
                      filename: name,
                    }),
                    generation: 1,
                    phase: 'revoked',
                    files: [
                      { name: 'access-denial.json', bytes },
                      { name: 'denial-identity.json', bytes: envelope },
                    ],
                  },
                  current,
                );
                current();
                recorded++;
              }
              current();
              return {
                status: 'recorded',
                recorded,
                next_after: remaining.length > 10 ? page[9] : null,
                open_checks: openChecks,
              };
            } finally {
              for (const bytes of buffers) bytes.fill(0);
              for (const fd of handles.reverse()) fs.closeSync(fd);
            }
          },
          inspect,
          memory,
        );
      },
      inspect,
      memory,
    );
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Queue, client, denial and mount diagnostics never escape the private recovery boundary.
    throw Error('mail_recovery_snapshot_unavailable');
  }
}
