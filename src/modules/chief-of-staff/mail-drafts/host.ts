import { digest } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MailHostCredentials } from '../mail/config.js';
import { closeMailProfile } from '../mail/host.js';
import { googleMailReader } from '../mail/google-reader.js';
import { MailReadError } from '../mail/reader.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../mail/oauth.js';
import { checkedClient } from '../calendar/oauth-core.js';
import type { MailDraftHostCredentials } from './config.js';
import type { MailDraftAuthorityResolver } from './authority.js';
import type { DraftJournal } from './journal.js';
import { parseMailDraftHostGrant, type MailDraftHostProfile, type MailDraftHostGrant } from './profile.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
import { googleMailDraftWriter, MailDraftWriteError, type MailDraftResult } from './google-writer.js';
import type { MailDraftDependencies, MailDraftSelection } from './store.js';
import type { MailReviewAccess } from '../automation/mail-review-access.js';

type Options = {
  profile: MailDraftHostProfile;
  journal: DraftJournal;
  reader: MailHostCredentials;
  writer: MailDraftHostCredentials;
  authority: MailDraftAuthorityResolver;
  review?: { authority: MailDraftAuthorityResolver; access: Pick<MailReviewAccess, 'check'> };
  enabled(): boolean;
  /** Installed opener pins the real target/profile and validates actual baseline recovery before assembly. */
  assertProfile(): void;
  /** Cheap immutable recovery pin after the opener's complete validation, never a model input. */
  assertRecovery(grant?: MailDraftHostGrant, selected?: MailDraftSelection): void;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};
const identity = ({
  scopeId,
  ownerId,
  agentGroupId,
  sessionId,
}: KnowledgeContext | MailDraftHostProfile['grants'][number]) => ({ scopeId, ownerId, agentGroupId, sessionId });
const exactScope = (scopes: string[], required: string) =>
  Array.isArray(scopes) && scopes.length === 1 && scopes[0] === required;
/** Code-only assembly of verified installed resources. This factory cannot initialize a
 * profile, perform recovery, grant consent or write PostgreSQL policy. The reader remains
 * owned by MailHost; this lifetime owns the separate writer resource and effect journal. */
export function createMailDraftHost(options: Options): { dependencies: MailDraftDependencies; close(): Promise<void> } {
  const profile = structuredClone(options.profile),
    { journal, reader, writer } = options,
    readerClient = checkedClient({ clientId: reader.clientId }).clientId,
    writerClient = checkedClient({ clientId: writer.clientId }).clientId;
  if (
    profile.format !== 'cos-mail-draft-host/v1' ||
    profile.installationDigest !== journal.installationDigest ||
    profile.journalGeneration !== journal.generation ||
    readerClient === writerClient ||
    !Array.isArray(profile.grants) ||
    profile.grants.length < 1 ||
    profile.grants.length > 10
  )
    throw Error('mail_draft_host_unavailable');
  for (const grant of profile.grants) {
    parseMailDraftHostGrant(grant);
    if (
      grant.binding.journalGeneration !== journal.generation ||
      grant.binding.writerClientDigest !== digest(writerClient) ||
      grant.binding.readerClientDigest !== digest(readerClient)
    )
      throw Error('mail_draft_host_unavailable');
  }
  options.assertProfile();
  options.assertRecovery();
  journal.assertCurrent();
  const shutdown = new AbortController(),
    pending = new Set<Promise<unknown>>();
  let retired = false,
    closing: Promise<void> | undefined;
  const native = (context: KnowledgeContext) => {
    try {
      if (
        shutdown.signal.aborted ||
        !options.enabled() ||
        (context.origin && (context.origin.kind !== 'schedule' || !options.review)) ||
        context.provider !== 'codex' ||
        reader.closed() ||
        writer.closed()
      )
        return null;
      options.assertProfile();
      options.assertRecovery();
      journal.assertCurrent();
      reader.verifyStorage();
      writer.verifyStorage();
      const authority = context.origin ? options.review!.authority(context) : options.authority(context);
      return authority?.contextGeneration === context.generation &&
        authority.draftProfileDigest === digest('cos-mail-draft/v1') &&
        profile.grants.some(
          (grant) =>
            grant.writeEnabled &&
            digest(identity(grant)) === digest(identity(context)) &&
            grant.binding.nativeBindingDigest === authority.bindingDigest,
        )
        ? authority
        : null;
      // eslint-disable-next-line no-catch-all/no-catch-all -- Lost private resource/proof state closes admission without exposing its diagnostics.
    } catch {
      return null;
    }
  };
  const matches = (context: KnowledgeContext, selected: MailDraftSelection): boolean => {
    try {
      if (
        !native(context) ||
        selected.reader_provider !== 'google' ||
        selected.body.provider !== 'google' ||
        !selected.reader_credential_ref ||
        selected.reader_credential_ref === selected.body.credentialReference ||
        selected.body.writerClientDigest !== digest(writerClient) ||
        selected.body.readerClientDigest !== digest(readerClient) ||
        selected.body.mailboxDigest !== digest(selected.mailbox_email.toLowerCase()) ||
        !exactScope(selected.reader_scopes, GOOGLE_MAIL_READ_SCOPE) ||
        selected.reader_auth !== 'ready'
      )
        return false;
      const grant = profile.grants.find(
        (grant) =>
          grant.id === selected.id &&
          grant.version === selected.version &&
          grant.writeEnabled &&
          digest(identity(grant)) === digest(identity(context)) &&
          digest(grant.binding) === digest(selected.body),
      );
      if (!grant) return false;
      options.assertRecovery(grant, selected);
      reader.fences.assertOpen(context.scopeId, selected.body.readerBindingId);
      writer.fences.assertOpen(context.scopeId, selected.id);
      return true;
      // eslint-disable-next-line no-catch-all/no-catch-all -- Current denial/storage failures cannot grant provider access.
    } catch {
      return false;
    }
  };
  const dependencies: MailDraftDependencies = {
    journal,
    authority: (context) => native(context as KnowledgeContext),
    ...(options.review ? { reviewAccess: options.review.access } : {}),
    matches,
    writer(context, selected, checkDatabase, source) {
      const retained = structuredClone(context),
        binding = structuredClone(selected),
        pinnedSource = structuredClone(source),
        authority = structuredClone(native(retained));
      if (!authority || !matches(retained, binding)) return null;
      const admitted = () => digest(native(retained)) === digest(authority) && matches(retained, binding),
        assert = () => {
          if (!admitted()) throw new MailDraftWriteError('mail_draft_not_admitted');
        },
        current = async () => {
          assert();
          if (!(await checkDatabase())) throw new MailDraftWriteError('mail_draft_not_admitted');
          assert();
        };
      const credentials = async (draft: boolean) => {
        await current();
        const value = await (draft ? writer : reader).credentials.inspect(
          retained.scopeId,
          draft ? binding.id : binding.body.readerBindingId,
          draft ? binding.body.credentialReference : binding.reader_credential_ref!,
        );
        await current();
        if (
          value.auth !== 'ready' ||
          !exactScope(value.scopes, draft ? GOOGLE_MAIL_DRAFT_SCOPE : GOOGLE_MAIL_READ_SCOPE)
        )
          throw new MailDraftWriteError('mail_draft_binding_denied');
        return value;
      };
      const token = async (draft: boolean) => {
        await current();
        const value = await (draft ? writer : reader).credentials.token(
          retained.scopeId,
          draft ? binding.id : binding.body.readerBindingId,
          draft ? binding.body.credentialReference : binding.reader_credential_ref!,
          shutdown.signal,
        );
        await current();
        return value;
      };
      const sourceReader = googleMailReader({
        fetch: options.fetch,
        now: options.now,
        signal: shutdown.signal,
        access: async () => {
          const value = await credentials(false);
          return {
            generation: binding.body.readerBindingId + ':' + binding.reader_credential_ref,
            mailboxEmail: binding.mailbox_email,
            scopes: value.scopes,
            auth: value.auth,
          };
        },
        token: () => token(false),
      });
      const adapter = googleMailDraftWriter({
        admitted,
        journal,
        fetch: options.fetch,
        now: options.now,
        signal: shutdown.signal,
        access: async () => {
          const value = await credentials(true);
          return {
            generation: binding.body.credentialReference + ':' + binding.version,
            scopeId: retained.scopeId,
            bindingId: binding.id,
            contextGeneration: retained.generation,
            mailboxEmail: binding.mailbox_email,
            readerMailboxEmail: binding.mailbox_email,
            clientId: writerClient,
            readerClientId: readerClient,
            auth: value.auth,
            scopes: value.scopes,
            writeEnabled: true,
          };
        },
        token: () => token(true),
        sourceReader: {
          replySource: async (id, window) => {
            await current();
            try {
              const fresh = await sourceReader.replySource(id, window);
              await current();
              if (
                fresh.source.id !== id ||
                fresh.source.threadId !== pinnedSource.thread_id ||
                fresh.internalDate !== pinnedSource.internal_date_ms
              )
                throw new MailDraftWriteError('mail_draft_source_denied');
              return fresh;
            } catch (error) {
              if (
                error instanceof MailReadError &&
                [
                  'mail_auth_revoked',
                  'mail_auth_expired',
                  'mail_auth_disconnected',
                  'mail_scope_denied',
                  'mail_access_changed',
                  'mail_wrong_account',
                ].includes(error.code)
              )
                reader.fences.deny(
                  retained.scopeId,
                  binding.body.readerBindingId,
                  error.code === 'mail_auth_expired'
                    ? 'expired'
                    : error.code === 'mail_auth_disconnected'
                      ? 'disconnected'
                      : 'revoked',
                );
              throw error;
            }
          },
        },
      });
      const run = (task: () => Promise<MailDraftResult>): Promise<MailDraftResult> => {
        const work = (async () => {
          assert();
          let result: MailDraftResult | undefined, failure: unknown;
          await reader.fences.runCheck(retained.scopeId, binding.body.readerBindingId, async () => {
            try {
              await writer.fences.runCheck(retained.scopeId, binding.id, async () => {
                try {
                  result = await task();
                  // eslint-disable-next-line no-catch-all/no-catch-all -- Preserve private failures until both access checks settle; only fixed errors leave this adapter.
                } catch (error) {
                  failure = error;
                  if (error instanceof MailDraftWriteError && error.code === 'mail_draft_wrong_account')
                    writer.fences.deny(retained.scopeId, binding.id, 'revoked');
                }
              });
              // eslint-disable-next-line no-catch-all/no-catch-all -- Settle this reader's check after a writer busy/fence failure, retaining its original error privately.
            } catch (error) {
              failure = error;
            }
          });
          if (failure instanceof MailDraftWriteError) throw failure;
          if (failure || !result) throw new MailDraftWriteError('mail_draft_unavailable');
          return result;
        })();
        pending.add(work);
        void work.finally(() => pending.delete(work)).catch(() => {});
        return work;
      };
      return {
        create: (request) => run(() => adapter.create(request)),
        status: (operationId) => run(() => adapter.status(operationId)),
      };
    },
  };
  return {
    dependencies,
    async close() {
      if (retired) return;
      if (closing) return closing;
      shutdown.abort();
      const work = (async () => {
        await Promise.allSettled([...pending]);
        await closeMailProfile(writer);
        journal.close();
        retired = true;
      })();
      closing = work;
      try {
        await work;
      } finally {
        if (closing === work) closing = undefined;
      }
    },
  };
}
