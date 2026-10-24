import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { checkedClient } from '../calendar/oauth-core.js';
import { credentialRootMarker, credentialProfileMetadata } from '../calendar/credential-core.js';
import { accessFenceRootMarker } from '../calendar/access-fences.js';
import { withMailProfileStorage } from '../mail/storage.js';
import { mailProfile, type MailCredentialProfile } from '../mail/profile.js';
import { digest } from '../domain/contracts.js';
import { verifyVaultStorage, withVaultDirectory } from './vault-storage.js';
import { verifyVaultMemory } from './vault-memory.js';
import { readBackupCredentialInstallation } from './backup-credential-install.js';
import { validateBackupRepositoryProfile } from './backup-repository-profile.js';
import { withCredentialPrimarySnapshot } from './credential-primary-source.js';
import { makeCredentialEvent, type CredentialChange, type CredentialEvent } from './backup-credential-event.js';
import { makeRoutedCredentialRecoveryManifest } from './credential-recovery-routing.js';
import { BACKUP_LIMITS } from './backup-policy.js';
export type VaultCredentialSnapshot = {
  ownerDigest: string;
  sources: Array<{ event: CredentialEvent; files: Array<{ name: string; destination: string | null; bytes: Buffer }> }>;
  /** Active or interrupted checks remain forensic state, never a portable grant. */
  openChecks: number;
  assertCurrent(): void;
  assertPrimaryUnchanged(): void;
};
const pinned = (fd: number) => '/proc/self/fd/' + fd;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const signature = (stat: fs.Stats) =>
  digest({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function protect<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Credential paths, contents and private authority diagnostics never leave the trusted reader.
    throw Error('credential_vault_snapshot_unavailable');
  }
}
/** Reads fixed primary vault locations, independently of queue heads. No defaults
 * for owner authority, no provider/model/NAS calls and no state writes. Borrowed
 * bytes form an as-of snapshot, are bounded together and are wiped at exit. A
 * fresh primary comparison, not this capture, is needed for later pruning. */
export async function withVaultCredentialSnapshot<T>(
  roots: CalendarStorageRoots,
  options: { assertAuthority(): void },
  operation: (snapshot: VaultCredentialSnapshot) => Promise<T>,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
): Promise<T> {
  const handles: number[] = [],
    buffers: Buffer[] = [];
  let active = true;
  try {
    roots = Object.freeze({ ...roots });
    options = Object.freeze({ ...options });
    if (typeof options.assertAuthority !== 'function' || typeof operation !== 'function')
      throw Error('authority_required');
    options.assertAuthority();
    memory();
    const policy = verifyVaultStorage(roots, inspect),
      ownerDigest = digest({
        targetDigest: policy.targetDigest,
        filesystemUuid: policy.volume.filesystemUuid,
      });
    return await withVaultDirectory(
      roots,
      'google/calendar',
      async (google, googleCurrent) =>
        withVaultDirectory(
          roots,
          'backup-credentials',
          async (backup, backupCurrent) => {
            let total = 0;
            const mailCurrent: Array<() => void> = [];
            const directories: Array<{ fd: number; file: string; dev: number; ino: number }> = [],
              files: Array<{ fd: number; file: string; identity: string; immutable: boolean }> = [],
              inventories: Array<{ directory: string; names: string[] }> = [],
              primaryChecks: Array<() => void> = [],
              sources: VaultCredentialSnapshot['sources'] = [];
            const current = () =>
              protect(() => {
                if (!active) throw Error('snapshot_released');
                options.assertAuthority();
                memory();
                googleCurrent();
                backupCurrent();
                for (const check of mailCurrent) check();
                for (const directory of directories) {
                  for (const stat of [fs.fstatSync(directory.fd), fs.lstatSync(directory.file)])
                    if (
                      !stat.isDirectory() ||
                      stat.dev !== directory.dev ||
                      stat.ino !== directory.ino ||
                      stat.uid !== process.getuid?.() ||
                      (stat.mode & 0o7777) !== 0o700
                    )
                      throw Error('directory_changed');
                }
                for (const file of files.filter((file) => file.immutable))
                  if (
                    signature(fs.fstatSync(file.fd)) !== file.identity ||
                    signature(fs.lstatSync(file.file)) !== file.identity
                  )
                    throw Error('configuration_changed');
              });
            const unchanged = () =>
              protect(() => {
                current();
                for (const inventory of inventories)
                  if (digest(fs.readdirSync(inventory.directory).sort()) !== digest(inventory.names))
                    throw Error('inventory_changed');
                for (const file of files)
                  if (
                    signature(fs.fstatSync(file.fd)) !== file.identity ||
                    signature(fs.lstatSync(file.file)) !== file.identity
                  )
                    throw Error('primary_changed');
                for (const check of primaryChecks) check();
                current();
              });
            const inventory = (directory: string) => {
              current();
              const names = fs.readdirSync(directory).sort();
              if (names.length > 4096) throw Error('inventory_bounds');
              inventories.push({ directory, names });
              return names;
            };
            const pin = (file: string) => {
              current();
              const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
              handles.push(fd);
              const stat = fs.fstatSync(fd);
              if (stat.dev !== fs.statSync(google).dev) throw Error('foreign_device');
              directories.push({ fd, file, dev: stat.dev, ino: stat.ino });
              current();
              return fd;
            };
            const read = (directory: string, name: string, maximum: number, immutable = false, empty = false) => {
              current();
              const file = directory + '/' + name,
                fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
              handles.push(fd);
              const stat = fs.fstatSync(fd);
              if (
                !stat.isFile() ||
                stat.dev !== fs.statSync(google).dev ||
                stat.uid !== process.getuid?.() ||
                (stat.mode & 0o7777) !== 0o600 ||
                stat.nlink !== 1 ||
                stat.size > maximum ||
                (!empty && stat.size < 1)
              )
                throw Error('unsafe_primary_file');
              total += stat.size;
              if (total > BACKUP_LIMITS.credentials) throw Error('snapshot_byte_bounds');
              const item = { fd, file, identity: signature(stat), immutable };
              files.push(item);
              const bytes = Buffer.alloc(stat.size + 1);
              buffers.push(bytes);
              if (
                fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size ||
                signature(fs.fstatSync(fd)) !== item.identity ||
                signature(fs.lstatSync(file)) !== item.identity
              )
                throw Error('primary_changed');
              current();
              return bytes.subarray(0, stat.size);
            };
            const derived = (value: unknown) => {
              const bytes = Buffer.from(JSON.stringify(value) + '\n');
              buffers.push(bytes);
              total += bytes.length;
              if (total > BACKUP_LIMITS.credentials) throw Error('snapshot_byte_bounds');
              return bytes;
            };
            const add = (
              change: Omit<CredentialChange, 'files'>,
              payload: Array<{ name: string; destination: string | null; bytes: Buffer }>,
            ) => {
              sources.push({ event: makeCredentialEvent({ ...change, files: payload }, ownerDigest), files: payload });
              if (sources.length > 1024) throw Error('snapshot_source_bounds');
            };
            const parse = (bytes: Buffer) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            const googleNames = inventory(google);
            const allowed = [
              'oauth-client.json',
              'credentials',
              'access-denials',
              'writer-oauth-client.json',
              'writer-credentials',
              'writer-access-denials',
              'mail-reader',
              'mail-draft-writer',
            ];
            if (googleNames.some((name) => !allowed.includes(name))) throw Error('unknown_google_state');
            const profiles = (['reader', 'owned_event_writer', 'mail_reader', 'mail_draft_writer'] as const).filter(
              (profile) => {
                const required =
                  profile === 'reader'
                    ? ['oauth-client.json', 'credentials', 'access-denials']
                    : profile === 'owned_event_writer'
                      ? ['writer-oauth-client.json', 'writer-credentials', 'writer-access-denials']
                      : [mailProfile(profile).directory];
                const count = required.filter((name) => googleNames.includes(name)).length;
                if (count && count !== required.length) throw Error('partial_google_profile');
                return count > 0;
              },
            );
            let openChecks = 0;
            const clientIds = new Set<string>();
            const mailDirectories = new Map<MailCredentialProfile, string>();
            const collect = async (index: number): Promise<T> => {
              if (index === profiles.length) {
                const names = inventory(backup),
                  allowed = [
                    'smb-credentials',
                    'restic-password',
                    'backup-credential-installation.json',
                    'backup-repository.json',
                    'backup-repository-initialization.json',
                    'repository.lock',
                    '.cos-writer.lock',
                  ];
                if (names.some((name) => !allowed.includes(name))) throw Error('unknown_backup_state');
                // Coordination metadata is checked and pinned, but never becomes
                // a recoverable credential or portable writer authority.
                for (const name of ['backup-repository-initialization.json', 'repository.lock', '.cos-writer.lock'])
                  if (names.includes(name)) read(backup, name, 16384);
                const installationBytes = read(backup, 'backup-credential-installation.json', 4096, true),
                  installation = readBackupCredentialInstallation(backup, roots, policy.volume.filesystemUuid);
                if (digest(parse(installationBytes)) !== digest(installation)) throw Error('installation_changed');
                add(
                  {
                    sourceKind: 'backup_repository',
                    sourceKey: digest({
                      rootsDigest: installation.rootsDigest,
                      credentialReference: installation.credentialReference,
                    }),
                    generation: 1,
                    phase: 'ready',
                  },
                  [
                    {
                      name: 'smb-credentials',
                      destination: 'backup-credentials/smb-credentials',
                      bytes: read(backup, 'smb-credentials', 4096, true),
                    },
                    {
                      name: 'restic-password',
                      destination: 'backup-credentials/restic-password',
                      bytes: read(backup, 'restic-password', 128, true),
                    },
                    {
                      name: 'backup-credential-installation.json',
                      destination: 'backup-credentials/backup-credential-installation.json',
                      bytes: installationBytes,
                    },
                  ],
                );
                const repositoryBytes = read(backup, 'backup-repository.json', 8192, true),
                  repository = parse(repositoryBytes);
                validateBackupRepositoryProfile(repository, roots, policy.volume.filesystemUuid);
                add(
                  {
                    sourceKind: 'backup_repository',
                    sourceKey: digest({
                      contract: 'cos-backup-repository-recovery/v1',
                      rootsDigest: digest(roots),
                      repositoryId: repository.repositoryId,
                    }),
                    generation: 1,
                    phase: 'ready',
                  },
                  [
                    {
                      name: 'repository.json',
                      destination: 'backup-credentials/backup-repository.json',
                      bytes: repositoryBytes,
                    },
                  ],
                );
                unchanged();
                makeRoutedCredentialRecoveryManifest(ownerDigest, sources);
                const result = await operation({
                  ownerDigest,
                  sources,
                  openChecks,
                  assertCurrent: current,
                  assertPrimaryUnchanged: unchanged,
                });
                current();
                return result;
              }
              const profile = profiles[index],
                selectedMail =
                  profile === 'mail_reader' || profile === 'mail_draft_writer' ? mailProfile(profile) : null,
                mail = selectedMail !== null,
                writer = profile === 'owned_event_writer';
              const root =
                  profile === 'mail_reader' || profile === 'mail_draft_writer' ? mailDirectories.get(profile)! : google,
                base = selectedMail ? 'google/calendar/' + selectedMail.directory : 'google/calendar',
                credentialName = writer ? 'writer-credentials' : 'credentials',
                denialName = writer ? 'writer-access-denials' : 'access-denials',
                clientName = writer ? 'writer-oauth-client.json' : 'oauth-client.json',
                credentials = pin(root + '/' + credentialName),
                denials = pin(root + '/' + denialName),
                clientBytes = read(root, clientName, 16384, true),
                client = checkedClient(parse(clientBytes));
              if (clientIds.has(client.clientId)) throw Error('shared_google_client');
              clientIds.add(client.clientId);
              const marker = credentialRootMarker(profile),
                fenceMarker = accessFenceRootMarker(),
                credentialProfile = read(pinned(credentials), marker.name, 1024, true),
                denialProfile = read(pinned(denials), fenceMarker.name, 1024, true);
              if (
                credentialProfile.toString('utf8') !== marker.contents ||
                denialProfile.toString('utf8') !== fenceMarker.contents
              )
                throw Error('foreign_profile_marker');
              const proof = mail
                ? read(root, selectedMail!.marker, 4096, true)
                : derived({
                    contract: 'cos-google-recovery-configuration/v1',
                    targetDigest: policy.targetDigest,
                    profile,
                    clientSha256: hash(clientBytes),
                  });
              const configurationSource = mail
                ? digest({
                    contract:
                      profile === 'mail_draft_writer'
                        ? 'cos-mail-draft-recovery-configuration/v1'
                        : 'cos-mail-recovery-configuration/v1',
                    targetDigest: policy.targetDigest,
                    profileProofSha256: hash(proof),
                  })
                : digest({
                    contract: 'cos-google-recovery-configuration/v1',
                    targetDigest: policy.targetDigest,
                    profile,
                    profileProofSha256: hash(proof),
                  });
              const sourceKind = credentialProfileMetadata(profile).sourceKind;
              add({ sourceKind, sourceKey: configurationSource, generation: 1, phase: 'ready' }, [
                {
                  name: 'profile-proof.json',
                  destination: mail ? base + '/' + selectedMail!.marker : null,
                  bytes: proof,
                },
                { name: 'oauth-client.json', destination: base + '/' + clientName, bytes: clientBytes },
                {
                  name: 'credential-profile.json',
                  destination: base + '/' + credentialName + '/' + marker.name,
                  bytes: credentialProfile,
                },
                {
                  name: 'denial-profile.txt',
                  destination: base + '/' + denialName + '/' + fenceMarker.name,
                  bytes: denialProfile,
                },
              ]);
              const denialNames = inventory(pinned(denials));
              for (const name of denialNames) {
                if (name === fenceMarker.name) continue;
                if (/^[a-f0-9]{64}\.json\.check\.lock$/.test(name)) {
                  read(pinned(denials), name, 0, false, true);
                  continue;
                }
                const pending = /^[a-f0-9]{64}\.json\.pending$/.test(name);
                if (!pending && !/^[a-f0-9]{64}\.json$/.test(name)) throw Error('unknown_denial_state');
                const bytes = read(pinned(denials), name, 1024),
                  denial = parse(bytes);
                if (!denial || denial.version !== 1 || !hex(denial.scopeDigest) || !uuid(denial.bindingId))
                  throw Error('invalid_denial');
                if (pending) {
                  if (Object.keys(denial).sort().join(',') !== 'bindingId,id,scopeDigest,version' || !uuid(denial.id))
                    throw Error('invalid_pending_check');
                  if (!denialNames.includes(name.slice(0, -8))) openChecks++;
                  continue;
                }
                if (
                  Object.keys(denial).sort().join(',') !== 'at,auth,bindingId,scopeDigest,version' ||
                  !['expired', 'revoked', 'disconnected'].includes(denial.auth) ||
                  typeof denial.at !== 'string' ||
                  denial.at.length > 40 ||
                  !Number.isFinite(Date.parse(denial.at))
                )
                  throw Error('invalid_denial');
                const identity = derived({
                  contract:
                    profile === 'mail_draft_writer'
                      ? 'cos-mail-draft-denial-recovery/v1'
                      : mail
                        ? 'cos-mail-denial-recovery/v1'
                        : 'cos-google-denial-recovery/v1',
                  configurationSource,
                  filename: name,
                  sha256: hash(bytes),
                });
                add(
                  {
                    sourceKind,
                    sourceKey: digest({
                      contract:
                        profile === 'mail_draft_writer'
                          ? 'cos-mail-draft-recovery-denial/v1'
                          : mail
                            ? 'cos-mail-recovery-denial/v1'
                            : 'cos-google-recovery-denial/v1',
                      configurationSource,
                      filename: name,
                    }),
                    generation: 1,
                    phase: 'revoked',
                  },
                  [
                    { name: 'access-denial.json', destination: base + '/' + denialName + '/' + name, bytes },
                    { name: 'denial-identity.json', destination: null, bytes: identity },
                  ],
                );
              }
              return withCredentialPrimarySnapshot(
                {
                  directoryFd: credentials,
                  ownerDigest,
                  clientId: client.clientId,
                  profile,
                  assertScope: current,
                  maximumBytes: BACKUP_LIMITS.credentials - total,
                },
                async (snapshot) => {
                  primaryChecks.push(snapshot.assertPrimaryUnchanged);
                  for (const source of snapshot.sources) {
                    total += source.files.reduce((sum, file) => sum + file.bytes.length, 0);
                    sources.push({
                      event: source.event,
                      files: source.files.map((file) => ({
                        ...file,
                        destination: base + '/' + credentialName + '/' + source.credentialReference + '.json',
                      })),
                    });
                  }
                  if (total > BACKUP_LIMITS.credentials || sources.length > 1024) throw Error('snapshot_bounds');
                  return collect(index + 1);
                },
              );
            };
            const configuredMail = profiles.filter(
              (profile): profile is MailCredentialProfile =>
                profile === 'mail_reader' || profile === 'mail_draft_writer',
            );
            const holdMailProfiles = (index: number): Promise<T> => {
              if (index === configuredMail.length) return collect(0);
              const profile = configuredMail[index];
              return withMailProfileStorage(
                profile,
                roots,
                async (storage) => {
                  mailCurrent.push(storage.assertCurrent);
                  mailDirectories.set(profile, storage.directory);
                  return holdMailProfiles(index + 1);
                },
                inspect,
                memory,
              );
            };
            return holdMailProfiles(0);
          },
          inspect,
          memory,
        ),
      inspect,
      memory,
    );
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Never surface source bytes or nested vault/owner diagnostics.
    throw Error('credential_vault_snapshot_unavailable');
  } finally {
    active = false;
    for (const bytes of buffers) bytes.fill(0);
    for (const fd of handles.reverse()) fs.closeSync(fd);
  }
}
