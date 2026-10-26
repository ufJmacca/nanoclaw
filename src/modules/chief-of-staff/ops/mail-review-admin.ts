import fs from 'node:fs';
import type pg from 'pg';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { GOOGLE_MAIL_READ_SCOPE, GOOGLE_MAIL_DRAFT_SCOPE } from '../calendar/oauth-core.js';
import { openMailCredentials, type MailHostCredentials } from '../mail/config.js';
import { openMailDraftCredentials, type MailDraftHostCredentials } from '../mail-drafts/config.js';
import { openTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import { readMailDraftHostProfile } from '../mail-drafts/profile.js';
import { readMailDraftRecoveryProof } from '../mail-drafts/recovery.js';
import { parseMailReviewHostProfile } from '../automation/mail-review-profile.js';
import { connectChecked } from '../store/preflight.js';
import { parseDatabaseConfig } from '../store/config.js';
import { migrationStatus } from '../store/migrations.js';
import { localTarget, databaseFingerprint } from './target-identity.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { calendarAdminDirectory } from './calendar-admin.js';
import { readMailDraftAccountConsent } from './mail-draft-consent.js';
import { verifyVaultMemory } from './vault-memory.js';
import type { ReleaseManifest } from './release-manifest.js';
import { parseMailReviewAdminArguments, type MailReviewAdminArguments } from './mail-review-admin-arguments.js';
import { publishInitialMailReview } from './mail-review-publication.js';
import { writeMailReviewStandingPolicy } from './mail-review-policy-store.js';

type Options = {
  args: MailReviewAdminArguments;
  env: NodeJS.ProcessEnv;
  roots: CalendarStorageRoots;
  binding: CosBinding;
  release: ReleaseManifest;
  check(): Promise<void>;
  assertAuthority(): void;
  /** Actual retained native owner/account/generation, verified without initializing or renewing history. */
  contextCurrent(generation: string): boolean;
};
/** Installed owner-only setup. Enclosing administration owns fresh paused maintenance/native leases.
 * Reuse the existing writer grant, real consent and recovery; never relink, resume or reserve model use. */
export async function runMailReviewAdmin(o: Options, inspect?: StorageInspection): Promise<Record<string, unknown>> {
  try {
    const args = parseMailReviewAdminArguments([
      o.args.command,
      '--scope',
      o.args.scopeId,
      '--request-id',
      o.args.requestId,
      '--manifest',
      o.args.manifestFile,
    ]);
    const { roots, binding } = o,
      original = digest({ args: o.args, roots: o.roots, binding: o.binding, release: o.release });
    if (
      args.scopeId !== binding.scopeId ||
      binding.provider !== 'codex' ||
      o.release.slice !== 'G06' ||
      o.release.postgres.minimum !== 21 ||
      o.release.postgres.maximum !== 21
    )
      throw Error('mail_review_owner_required');
    const profile = parseMailReviewHostProfile(readPrivate(args.manifestFile)),
      profileDigest = digest(profile),
      target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot),
      installation = digest(target.binding);
    const authority = () => {
      verifyVaultMemory();
      o.assertAuthority();
      if (
        digest({ args: o.args, roots: o.roots, binding: o.binding, release: o.release }) !== original ||
        digest(readPrivate(args.manifestFile)) !== profileDigest ||
        !o.contextCurrent(profile.binding.contextGeneration)
      )
        throw Error('mail_review_owner_changed');
      const current = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
      if (
        digest(current.binding) !== installation ||
        current.lifecycle !== 'protected' ||
        current.releaseId !== o.release.releaseId
      )
        throw Error('mail_review_target_changed');
    };
    const check = async () => {
      authority();
      await o.check();
      authority();
    };
    await check();
    const journal = openTargetDraftJournal(roots.targetRoot, installation);
    let reader: MailHostCredentials | undefined,
      writer: MailDraftHostCredentials | undefined,
      client: pg.Client | undefined;
    try {
      const writerProfile = readMailDraftHostProfile(roots.targetRoot, installation, journal),
        writerProfileDigest = digest(writerProfile);
      const grant = writerProfile.grants.find(
        (item) =>
          item.id === profile.binding.writerBindingId &&
          item.scopeId === binding.scopeId &&
          item.ownerId === binding.ownerId &&
          item.sessionId === binding.sessionId &&
          item.agentGroupId === binding.agentGroupId,
      );
      if (
        !grant ||
        !grant.writeEnabled ||
        grant.version !== profile.binding.writerVersion ||
        digest(grant.binding) !== profile.binding.writerDigest ||
        grant.binding.readerBindingId !== profile.binding.readerBindingId ||
        grant.binding.nativeBindingDigest !== digest(binding) ||
        profile.installationDigest !== installation ||
        profile.journalGeneration !== journal.generation
      )
        throw Error('mail_review_writer_changed');
      const consent = readMailDraftAccountConsent(roots.targetRoot, installation, binding, grant.id, journal),
        consentDigest = digest(consent);
      if (
        profile.binding.writerConsentRef !== consentDigest ||
        consent.selection.mailboxDigest !== profile.binding.mailboxDigest ||
        consent.selection.readerBindingId !== profile.binding.readerBindingId ||
        consent.selection.writerBindingId !== grant.id ||
        consent.selection.writerReference !== grant.binding.credentialReference ||
        consent.selection.readerClientDigest !== grant.binding.readerClientDigest ||
        consent.selection.writerClientDigest !== grant.binding.writerClientDigest
      )
        throw Error('mail_review_consent_changed');
      const recovery = () => {
        const proof = readMailDraftRecoveryProof(roots.targetRoot, installation, journal, grant);
        if (
          digest(proof) !== grant.binding.recoveryProofDigest ||
          digest(proof.selection) !== digest(consent.selection)
        )
          throw Error('mail_review_recovery_changed');
      };
      const current = () => {
        authority();
        journal.assertCurrent();
        recovery();
        if (
          digest(readMailDraftHostProfile(roots.targetRoot, installation, journal)) !== writerProfileDigest ||
          digest(readMailDraftAccountConsent(roots.targetRoot, installation, binding, grant.id, journal)) !==
            consentDigest
        )
          throw Error('mail_review_grant_changed');
      };
      current();
      const directory = calendarAdminDirectory(
          calendarAdminDirectory(roots.targetRoot, 'mail-review-policy-admin'),
          args.requestId,
        ),
        request = {
          contract: 'cos-mail-review-policy-admin/v1',
          requestDigest: digest({ command: args.command, binding, profile }),
        },
        requestFile = directory + '/request.json';
      if (fs.lstatSync(requestFile, { throwIfNoEntry: false })) {
        if (digest(readPrivate(requestFile)) !== digest(request)) throw Error('mail_review_request_conflict');
      } else {
        if (fs.readdirSync(directory).length) throw Error('mail_review_request_conflict');
        writeAtomic(directory, 'request.json', request);
      }
      reader = await openMailCredentials(roots, inspect);
      await check();
      current();
      writer = await openMailDraftCredentials(roots, inspect);
      await check();
      current();
      const heldReader = reader,
        heldWriter = writer;
      const held = () => {
        current();
        if (
          heldReader.closed() ||
          heldWriter.closed() ||
          heldReader.clientId === heldWriter.clientId ||
          digest(heldReader.clientId) !== consent.selection.readerClientDigest ||
          digest(heldWriter.clientId) !== consent.selection.writerClientDigest
        )
          throw Error('mail_review_credentials_changed');
        heldReader.verifyStorage();
        heldWriter.verifyStorage();
        heldReader.fences.assertOpen(binding.scopeId, grant.binding.readerBindingId);
        heldWriter.fences.assertOpen(binding.scopeId, grant.id);
      };
      const ready = async () => {
        await check();
        held();
        const read = await heldReader.credentials.inspect(
          binding.scopeId,
          grant.binding.readerBindingId,
          consent.selection.readerReference,
        );
        held();
        const write = await heldWriter.credentials.inspect(
          binding.scopeId,
          grant.id,
          grant.binding.credentialReference,
        );
        held();
        if (
          read.auth !== 'ready' ||
          digest(read.scopes) !== digest([GOOGLE_MAIL_READ_SCOPE]) ||
          write.auth !== 'ready' ||
          digest(write.scopes) !== digest([GOOGLE_MAIL_DRAFT_SCOPE])
        )
          throw Error('mail_review_credentials_changed');
        await check();
        held();
      };
      await ready();
      client = await connectChecked(o.env, 'runtime', 'migration');
      if (
        (await databaseFingerprint(client, parseDatabaseConfig(o.env, 'runtime', 'migration'))) !==
          target.binding.databaseFingerprint ||
        (await migrationStatus(client)) !== 21
      )
        throw Error('mail_review_database_changed');
      const selectedClient = client;
      await publishInitialMailReview({
        targetRoot: roots.targetRoot,
        installationDigest: installation,
        journal,
        binding,
        profile,
        requestId: args.requestId,
        ready,
        assertAuthority: held,
        writePolicy: (fence) => writeMailReviewStandingPolicy(selectedClient, binding, profile, fence),
      });
      held();
      return {
        status: 'configured_paused',
        scope_id: binding.scopeId,
        paused: true,
        live_model: 'not_invoked',
        policy_id: profile.id,
        morning_schedule_id: profile.binding.morningScheduleId,
        afternoon_schedule_id: profile.binding.afternoonScheduleId,
        main_context_preserved: true,
      };
    } finally {
      try {
        await client?.end();
      } finally {
        try {
          await writer?.close();
        } finally {
          try {
            await reader?.close();
          } finally {
            journal.close();
          }
        }
      }
    }
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private target, native, vault, consent, recovery and database diagnostics cannot leave owner administration.
    throw Error('mail_review_configuration_unavailable');
  }
}
