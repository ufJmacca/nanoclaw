import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { withVaultCredentialSnapshot } from './credential-vault-snapshot.js';
import { credentialSource, type CredentialJournal } from './backup-credential-event.js';
import { createVaultCredentialJournal } from './backup-credential-journal.js';
import { verifyVaultMemory } from './vault-memory.js';
import fs from 'node:fs';
import { digest } from '../domain/contracts.js';
import { withVaultDirectory, verifyVaultStorage } from './vault-storage.js';
import { BackupRepositoryWriter } from './backup-repository-lease.js';
import { writeAtomic } from './target-state.js';
import { readPinnedBackupJournals } from './backup-capacity.js';
import { BACKUP_LIMITS } from './backup-policy.js';
export type CredentialRecoveryPage = {
  contract: 'cos-credential-recovery-page/v1';
  ownerDigest: string;
  status: 'recorded';
  recorded: number;
  next_after: string | null;
  open_checks: number;
};
/** Bounded local encrypted journal work only. Tokens keep their credential
 * owner's existing journal; this covers actual immutable profile/configuration,
 * repository credentials and permanent denials independently of queue heads.
 * An opaque cursor only chooses the next checked page; it grants no file,
 * source, repository, restore or cleanup authority. Completion wraps to start.
 * The optional ports are code-only fixtures; installed defaults use real vault,
 * memory and queue guards. No provider/model/NAS or service operation occurs. */
export async function recordVaultCredentialRecoveryPage(
  roots: CalendarStorageRoots,
  options: { assertAuthority(): void; after?: string },
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
  journal?: CredentialJournal,
): Promise<CredentialRecoveryPage> {
  try {
    roots = Object.freeze({ ...roots });
    options = Object.freeze({ ...options });
    if (
      typeof options.assertAuthority !== 'function' ||
      (options.after !== undefined && !/^[a-f0-9]{64}$/.test(options.after)) ||
      (journal !== undefined && typeof journal !== 'function')
    )
      throw Error('invalid_credential_page');
    options.assertAuthority();
    memory();
    const record = journal ?? createVaultCredentialJournal(roots, memory);
    return await withVaultCredentialSnapshot(
      roots,
      { assertAuthority: options.assertAuthority },
      async (snapshot) => {
        const selected = snapshot.sources
          .filter((source) => !source.event.files.some((file) => file.name === 'credential.json'))
          .map((source) => ({ source, key: credentialSource(source.event) }))
          .sort((a, b) => a.key.localeCompare(b.key));
        const remaining = selected.filter((item) => options.after === undefined || item.key > options.after),
          page = remaining.slice(0, 10);
        for (const { source } of page) {
          snapshot.assertCurrent();
          const event = source.event;
          await record(
            {
              sourceKind: event.sourceKind,
              sourceKey: event.sourceKey,
              generation: event.generation,
              phase: event.phase,
              files: source.files.map(({ name, bytes }) => ({ name, bytes })),
            },
            snapshot.assertCurrent,
          );
          snapshot.assertCurrent();
        }
        snapshot.assertCurrent();
        return {
          contract: 'cos-credential-recovery-page/v1',
          ownerDigest: snapshot.ownerDigest,
          status: 'recorded',
          recorded: page.length,
          next_after: remaining.length > page.length ? page.at(-1)!.key : null,
          open_checks: snapshot.openChecks,
        };
      },
      inspect,
      memory,
    );
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Raw credentials, private source/journal paths and nested failure details remain within the trusted operation.
    throw Error('credential_recovery_page_unavailable');
  }
}
type Cursor = {
  contract: 'cos-credential-recovery-cursor/v1';
  ownerDigest: string;
  targetDigest: string;
  releaseId: string;
  generation: number;
  after: string | null;
};
const cursorName = 'credential-recovery-page.json';
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
/** Installed paging composition. Progress is an encrypted, bounded hint bound
 * to the actual vault owner and current release/generation, never authority.
 * Its separate live kernel writer serializes cursor use outside strict queue
 * directories. A changed release/generation starts from the beginning; foreign
 * or unsafe state is held. Queued source events remain independently idempotent. */
export async function recordScheduledCredentialRecoveryPage(
  roots: CalendarStorageRoots,
  options: { releaseId: string; generation: number; assertAuthority(): void },
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
  journal?: CredentialJournal,
): Promise<CredentialRecoveryPage> {
  try {
    roots = Object.freeze({ ...roots });
    options = Object.freeze({ ...options });
    if (
      typeof options.assertAuthority !== 'function' ||
      !/^release-[a-zA-Z0-9_-]{1,120}$/.test(options.releaseId) ||
      !Number.isSafeInteger(options.generation) ||
      options.generation < 1
    )
      throw Error('invalid_page_scope');
    options.assertAuthority();
    memory();
    const policy = verifyVaultStorage(roots, inspect),
      ownerDigest = digest({ targetDigest: policy.targetDigest, filesystemUuid: policy.volume.filesystemUuid });
    return await withVaultDirectory(
      roots,
      'journals',
      async (directory, vaultCurrent) => {
        const capacity = () => {
          options.assertAuthority();
          vaultCurrent();
          const usage = readPinnedBackupJournals(directory),
            reserve = 64 * 1024;
          if (usage.bytes + reserve > BACKUP_LIMITS.credentials || usage.free < reserve + BACKUP_LIMITS.vaultReserve)
            throw Error('credential_cursor_capacity');
          options.assertAuthority();
          vaultCurrent();
        };
        capacity();
        const writer = new BackupRepositoryWriter(
          digest({ contract: 'cos-credential-page-writer/v1', ownerDigest }),
          async (operation) => operation(directory),
          '.cos-writer.lock',
        );
        return writer.exclusive(async (lease) => {
          let fd: number | undefined, observed: string | undefined;
          const file = directory + '/' + cursorName;
          const current = () => {
            options.assertAuthority();
            vaultCurrent();
            lease.assertCurrent();
            if (
              fd !== undefined &&
              (fileIdentity(fs.fstatSync(fd)) !== observed || fileIdentity(fs.lstatSync(file)) !== observed)
            )
              throw Error('credential_cursor_changed');
            if (fd === undefined && fs.lstatSync(file, { throwIfNoEntry: false }))
              throw Error('credential_cursor_unclaimed');
          };
          const open = () => {
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            const stat = fs.fstatSync(fd);
            if (
              !stat.isFile() ||
              stat.dev !== fs.statSync(directory).dev ||
              stat.uid !== process.getuid?.() ||
              stat.nlink !== 1 ||
              (stat.mode & 0o7777) !== 0o600 ||
              stat.size < 1 ||
              stat.size > 4096
            )
              throw Error('unsafe_credential_cursor');
            observed = fileIdentity(stat);
            const bytes = Buffer.alloc(stat.size + 1);
            try {
              if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) throw Error('credential_cursor_changed');
              current();
              return JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, stat.size)),
              ) as Cursor;
            } finally {
              bytes.fill(0);
            }
          };
          try {
            let previous: Cursor | undefined;
            if (fs.lstatSync(file, { throwIfNoEntry: false })) previous = open();
            if (
              previous !== undefined &&
              (!previous ||
                typeof previous !== 'object' ||
                Array.isArray(previous) ||
                Object.keys(previous).sort().join(',') !==
                  'after,contract,generation,ownerDigest,releaseId,targetDigest' ||
                previous.contract !== 'cos-credential-recovery-cursor/v1' ||
                previous.ownerDigest !== ownerDigest ||
                previous.targetDigest !== policy.targetDigest ||
                !/^release-[a-zA-Z0-9_-]{1,120}$/.test(previous.releaseId) ||
                !Number.isSafeInteger(previous.generation) ||
                previous.generation < 1 ||
                !(
                  previous.after === null ||
                  (typeof previous.after === 'string' && /^[a-f0-9]{64}$/.test(previous.after))
                ))
            )
              throw Error('foreign_credential_cursor');
            current();
            const after =
              previous?.releaseId === options.releaseId && previous.generation === options.generation
                ? previous.after
                : null;
            const page = await recordVaultCredentialRecoveryPage(
              roots,
              { assertAuthority: current, ...(after == null ? {} : { after }) },
              inspect,
              memory,
              journal,
            );
            capacity();
            current();
            if (page.ownerDigest !== ownerDigest) throw Error('credential_page_owner_changed');
            const next: Cursor = {
              contract: 'cos-credential-recovery-cursor/v1',
              ownerDigest,
              targetDigest: policy.targetDigest,
              releaseId: options.releaseId,
              generation: options.generation,
              after: page.next_after,
            };
            writeAtomic(directory, cursorName, next);
            if (fd !== undefined) fs.closeSync(fd);
            fd = undefined;
            observed = undefined;
            if (digest(open()) !== digest(next)) throw Error('credential_cursor_publication_changed');
            current();
            return page;
          } finally {
            if (fd !== undefined) fs.closeSync(fd);
          }
        });
      },
      inspect,
      memory,
    );
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Cursor and scope diagnostics are private hints and cannot expose credential or filesystem data.
    throw Error('credential_recovery_page_unavailable');
  }
}
