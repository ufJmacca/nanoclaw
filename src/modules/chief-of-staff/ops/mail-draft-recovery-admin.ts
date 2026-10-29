import fs from 'node:fs';
import { digest } from '../domain/contracts.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from '../mail-drafts/oauth.js';
import { openTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import { produceMailDraftRecoveryProof, readMailDraftRecoveryProof } from '../mail-drafts/recovery.js';
import type { MailDraftHostGrant } from '../mail-drafts/profile.js';
import type { RecoveredTargetVaultIdentity } from './backup-recovered-state.js';
import type { BackupTestDatabase } from './backup-test-database.js';
import type { BackupOwnerRestoreArguments } from './backup-owner-restore-arguments.js';
import { targetBinding } from './target-host.js';
import { calendarAdminDirectory as directory } from './calendar-admin.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { readMailDraftAccountConsent } from './mail-draft-consent.js';

/** Fixed owner composition within the existing retained helper's protected, healthy
 * installation and separate marked test-database lifetime. Neither restore grants writes. */
export async function restoreOwnerMailDraftBaseline(input: {
  target: RecoveredTargetVaultIdentity;
  args: Extract<BackupOwnerRestoreArguments, { command: 'mail-draft-restore-check' }>;
  sandbox: BackupTestDatabase;
  checkDatabase(): Promise<void>;
}): Promise<Record<string, unknown>> {
  try {
    const { target, args, sandbox } = input,
      settings = target.settings,
      installation = digest(targetBinding(settings)),
      originalArgs = digest(args),
      caller = target.current;
    if (
      args.scopeId !== target.binding.scopeId ||
      args.queueOperationId !== target.queueOperationId ||
      args.backupReleaseId !== target.recovery.releaseId ||
      args.snapshotDigest !== target.expectedSnapshotDigest ||
      ![20, 21].includes(target.recovery.software.schemaVersion)
    )
      throw Error('draft_restore_request_changed');
    const journal = openTargetDraftJournal(settings.stateRoot, installation);
    try {
      const consent = readMailDraftAccountConsent(
          settings.stateRoot,
          installation,
          target.binding,
          args.writerBindingId,
          journal,
        ),
        consentDigest = digest(consent);
      const current = () => {
        caller();
        journal.assertCurrent();
        if (
          digest(args) !== originalArgs ||
          target.current !== caller ||
          digest(
            readMailDraftAccountConsent(
              settings.stateRoot,
              installation,
              target.binding,
              args.writerBindingId,
              journal,
            ),
          ) !== consentDigest
        )
          throw Error('draft_restore_owner_changed');
      };
      const check = async () => {
        current();
        await input.checkDatabase();
        current();
      };
      await check();
      const proof = await produceMailDraftRecoveryProof({
        target: { ...target, current },
        journal,
        selection: consent.selection,
        stateRequestId: args.requestId,
        credentialCaptureOperationId: args.captureOperationId,
        credentialRequestId: args.credentialRequestId,
        sandbox,
        checkDatabase: check,
      });
      await check();
      const proofDigest = digest(proof),
        root = directory(settings.stateRoot + '/mail-drafts', 'restore-proofs'),
        name = proofDigest + '.json';
      if (fs.lstatSync(root + '/' + name, { throwIfNoEntry: false })) {
        if (digest(readPrivate(root + '/' + name)) !== proofDigest) throw Error('draft_restore_proof_conflict');
      } else writeAtomic(root, name, proof);
      const grant: MailDraftHostGrant = {
        scopeId: target.binding.scopeId,
        ownerId: target.binding.ownerId,
        agentGroupId: target.binding.agentGroupId,
        sessionId: target.binding.sessionId,
        id: args.writerBindingId,
        version: 1,
        backupOperationId: proof.backupOperationId,
        targetBackupDigest: proof.state.snapshotDigest,
        writeEnabled: false,
        binding: {
          format: 'cos-mail-draft-binding/v1',
          provider: 'google',
          readerBindingId: consent.selection.readerBindingId,
          mailboxDigest: consent.selection.mailboxDigest,
          readerClientDigest: consent.selection.readerClientDigest,
          writerClientDigest: consent.selection.writerClientDigest,
          credentialReference: consent.selection.writerReference,
          nativeBindingDigest: consent.nativeBindingDigest,
          journalGeneration: journal.generation,
          maxPerDay: 5,
          timeZone: 'Australia/Sydney',
          replyMode: 'plain_text_reply',
          permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
          recoveryProofDigest: proofDigest,
        },
      };
      current();
      if (digest(readMailDraftRecoveryProof(settings.stateRoot, installation, journal, grant)) !== proofDigest)
        throw Error('draft_restore_proof_conflict');
      await check();
      return {
        status: 'mail_draft_restore_verified',
        request_id: args.requestId,
        writer_binding_id: args.writerBindingId,
        recovery_proof_digest: proofDigest,
        snapshot_digest: proof.state.snapshotDigest,
        credential_set_digest: proof.credentials.setDigest,
        credentials_activated: false,
        admission_restored: false,
        draft_journal_restored: false,
        writer_activated: false,
      };
    } finally {
      journal.close();
    }
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private state, credential, native owner, journal and restore diagnostics remain in their protected evidence.
    throw Error('mail_draft_owner_restore_unavailable');
  }
}
