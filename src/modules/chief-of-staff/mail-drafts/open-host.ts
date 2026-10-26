import { digest } from '../domain/contracts.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { MailHostCredentials } from '../mail/config.js';
import { closeMailProfile } from '../mail/host.js';
import { localTarget } from '../ops/target-identity.js';
import { mailDraftSettings, openMailDraftCredentials, type MailDraftHostCredentials } from './config.js';
import { openTargetDraftJournal } from './host-ownership.js';
import type { DraftJournal } from './journal.js';
import { readMailDraftHostProfile } from './profile.js';
import type { MailDraftAuthorityResolver } from './authority.js';
import { readMailDraftRecoveryProof } from './recovery.js';
import { createMailDraftHost } from './host.js';
import type { MailReviewAccess } from '../automation/mail-review-access.js';

/** Installed runtime only. Read existing owned history, sealed owner policy and proofs;
 * never initialize a profile, consent, baseline, model allowance or replacement history.
 * Complete restore work belongs to the trusted owner path; these offline pins need no NAS. */
export async function openMailDraftHost(
  env: NodeJS.ProcessEnv,
  roots: CalendarStorageRoots,
  admitted: () => boolean,
  authority: MailDraftAuthorityResolver,
  reader: MailHostCredentials | undefined,
  adapters: {
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    now?: () => number;
    review?: { authority: MailDraftAuthorityResolver; access: Pick<MailReviewAccess, 'check'> };
  } = {},
): Promise<ReturnType<typeof createMailDraftHost> | undefined> {
  const settings = mailDraftSettings(env);
  if (!settings.enabled) return undefined;
  let journal: DraftJournal | undefined, writer: MailDraftHostCredentials | undefined;
  try {
    if (!reader || typeof authority !== 'function') throw Error('draft_reader_required');
    const installation = digest(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot).binding);
    journal = openTargetDraftJournal(roots.targetRoot, installation);
    const history = journal,
      profile = readMailDraftHostProfile(roots.targetRoot, installation, history),
      profileDigest = digest(profile),
      proofs = new Map(
        profile.grants.map((grant) => [
          grant.id,
          readMailDraftRecoveryProof(roots.targetRoot, installation, history, grant),
        ]),
      );
    const assertProfile = () => {
      const current = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
      if (
        !admitted() ||
        current.lifecycle !== 'protected' ||
        current.maintenance !== false ||
        digest(current.binding) !== installation ||
        digest(readMailDraftHostProfile(roots.targetRoot, installation, history)) !== profileDigest
      )
        throw Error('draft_profile_changed');
      history.assertCurrent();
      reader.verifyStorage();
    };
    assertProfile();
    writer = await openMailDraftCredentials(roots);
    return createMailDraftHost({
      profile,
      journal: history,
      reader,
      writer,
      authority,
      review: adapters.review,
      enabled: () => settings.enabled && admitted(),
      assertProfile,
      assertRecovery: (grant, selected) => {
        assertProfile();
        for (const entry of profile.grants) {
          const current = readMailDraftRecoveryProof(roots.targetRoot, installation, history, entry),
            pinned = proofs.get(entry.id);
          if (!pinned || digest(current) !== digest(pinned)) throw Error('draft_recovery_changed');
        }
        if (grant || selected) {
          if (
            !grant ||
            !selected ||
            selected.id !== grant.id ||
            selected.reader_credential_ref !== proofs.get(grant.id)?.selection.readerReference
          )
            throw Error('draft_recovered_reader_changed');
        }
      },
      fetch: adapters.fetch,
      now: adapters.now,
    });
  } catch {
    // Settle every resource opened here before treating draft setup as unavailable.
    // A retirement failure remains a distinct error; callers cannot silently open over it.
    try {
      if (writer) await closeMailProfile(writer);
    } finally {
      journal?.close();
    }
    // eslint-disable-next-line preserve-caught-error -- Private profile, vault and proof diagnostics stay behind the installed host boundary.
    throw Error('mail_draft_host_unavailable');
  }
}
