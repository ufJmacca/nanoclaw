/** Trusted paused owner setup. Linking credentials never enables saved drafts. */
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import {
  checkedClient,
  GOOGLE_MAIL_READ_SCOPE,
  GOOGLE_MAIL_DRAFT_SCOPE,
  type OAuthTransport,
} from '../calendar/oauth-core.js';
import { backupCalendarState } from '../calendar/backup.js';
import { object } from '../calendar/normalization.js';
import { openMailFences, openMailProfile, type MailHostFences } from '../mail/config.js';
import { withMailReaderStorage } from '../mail/storage.js';
import { MailCredentialOwner } from '../mail/credentials.js';
import { googleMailReader } from '../mail/google-reader.js';
import { initializeMailDraftProfile } from '../mail-drafts/setup.js';
import { withMailDraftWriterStorage } from '../mail-drafts/storage.js';
import { MailDraftCredentialOwner } from '../mail-drafts/credentials.js';
import { initializeTargetDraftJournal, openTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import { verifyMailDraftMailbox } from '../mail-drafts/account.js';
import { consumeMailClientStream } from './mail-client-stream.js';
import { connectOwnerMailStore } from './owner-mail-store.js';
import { authorizeMailProfile } from './mail-authorization.js';
import { parseMailSelection } from './mail-account-admin.js';
import { readMailDraftAccountConsent, type MailDraftAccountConsent } from './mail-draft-consent.js';
import { createVaultCredentialJournal } from './backup-credential-journal.js';
import type { CredentialJournal } from './backup-credential-event.js';
import { verifyVaultMemory } from './vault-memory.js';
import { readCalendarAdminJson as readJson, calendarAdminDirectory as directory } from './calendar-admin.js';
import { writeAtomic } from './target-state.js';
import { localTarget } from './target-identity.js';
import type { ReleaseManifest } from './release-manifest.js';
import { parseMailDraftAccountArguments, type MailDraftAccountArguments } from './mail-draft-account-arguments.js';

type Options = {
  args: MailDraftAccountArguments;
  roots: CalendarStorageRoots;
  env: NodeJS.ProcessEnv;
  binding: CosBinding;
  release: ReleaseManifest;
  check(): Promise<void>;
  assertAuthority(): void;
};
/** Code-only fixture seams; command arguments cannot select transports, roots, clients or roles. */
type Dependencies = {
  inspect?: StorageInspection;
  memory?: () => void;
  stream?: Readable;
  credentialJournal?: CredentialJournal;
  connect?: typeof connectOwnerMailStore;
  fetch?: OAuthTransport['fetch'];
  display?(url: string): void | Promise<void>;
};
function operation(roots: CalendarStorageRoots, id: string, request: unknown): string {
  const root = directory(directory(roots.targetRoot, 'mail-draft-admin'), id),
    expected = { contract: 'cos-mail-draft-admin/v1', requestDigest: digest(request) },
    file = root + '/request.json';
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    if (digest(readJson(file)) !== digest(expected)) throw Error('mail_draft_operation_conflict');
  } else {
    if (fs.readdirSync(root).length) throw Error('mail_draft_operation_conflict');
    writeAtomic(root, 'request.json', expected);
  }
  return root;
}
export async function runMailDraftAccountAdmin(o: Options, d: Dependencies = {}): Promise<Record<string, unknown>> {
  const stream = o.args.command === 'mail-draft-setup' ? (d.stream ?? process.stdin) : undefined;
  try {
    const args = parseMailDraftAccountArguments(
      o.args.command === 'mail-draft-setup'
        ? [o.args.command, '--scope', o.args.scopeId, '--request-id', o.args.requestId]
        : [
            o.args.command,
            '--scope',
            o.args.scopeId,
            '--request-id',
            o.args.requestId,
            '--reader-binding',
            o.args.readerBindingId,
            '--writer-binding',
            o.args.writerBindingId,
            '--manifest',
            o.args.manifestFile,
          ],
    );
    const schema = o.release.slice === 'G06' ? 21 : o.release.slice === 'G05' ? 20 : null;
    if (
      args.scopeId !== o.binding.scopeId ||
      o.binding.provider !== 'codex' ||
      schema === null ||
      o.release.postgres.minimum !== schema ||
      o.release.postgres.maximum !== schema
    )
      throw Error('mail_draft_account_operation_unavailable');
    const memory = d.memory ?? verifyVaultMemory,
      target = localTarget(o.roots.targetRoot, o.roots.installationRoot, o.roots.dataRoot),
      installationDigest = digest(target.binding);
    const authority = () => {
      memory();
      o.assertAuthority();
      const current = localTarget(o.roots.targetRoot, o.roots.installationRoot, o.roots.dataRoot);
      if (
        digest(current.binding) !== installationDigest ||
        current.lifecycle !== 'protected' ||
        current.releaseId !== o.release.releaseId
      )
        throw Error('mail_draft_account_operation_unavailable');
    };
    const check = async () => {
      authority();
      await o.check();
      authority();
    };
    await check();
    const base = { scope_id: args.scopeId, paused: true, live_model: 'not_invoked', write_enabled: false };
    const backup = async (root: string, phase: 'before' | 'after') =>
      backupCalendarState({
        roots: o.roots,
        operationId: 'mail-draft-' + args.requestId + '-' + phase,
        receiptRoot: directory(root, phase),
        check,
        inspect: d.inspect,
        memory,
      });
    if (args.command === 'mail-draft-setup') {
      let setupFailure: Error | undefined;
      await consumeMailClientStream(stream!, async (client) => {
        try {
          await check();
          const journal = operation(o.roots, args.requestId, {
            command: args.command,
            binding: o.binding,
            installationDigest,
            clientDigest: digest(client),
          });
          await backup(journal, 'before');
          await check();
          // Mark the one-time witness initialization before creating it. A lost root after an
          // interrupted attempt is never silently replaced with an empty daily history.
          const ownerRoot = directory(o.roots.targetRoot, 'mail-draft-admin'),
            marker = ownerRoot + '/witness-attempted.json',
            expected = { contract: 'cos-mail-draft-witness-attempt/v1', installationDigest, requestId: args.requestId };
          if (fs.lstatSync(marker, { throwIfNoEntry: false })) {
            if (digest(readJson(marker)) !== digest(expected)) throw Error('mail_draft_operation_conflict');
            const witness = openTargetDraftJournal(o.roots.targetRoot, installationDigest);
            witness.close();
          } else {
            if (fs.lstatSync(o.roots.targetRoot + '/mail-drafts', { throwIfNoEntry: false }))
              throw Error('mail_draft_operation_conflict');
            writeAtomic(ownerRoot, 'witness-attempted.json', expected);
            const witness = initializeTargetDraftJournal(o.roots.targetRoot, installationDigest);
            witness.close();
          }
          await check();
          await initializeMailDraftProfile(
            o.roots,
            client,
            { operationId: args.requestId, assertAuthority: authority },
            d.inspect,
            memory,
          );
          await check();
          await backup(journal, 'after');
          await check();
          // eslint-disable-next-line no-catch-all/no-catch-all -- Retain only a fixed setup result until the private input buffer is erased.
        } catch (error) {
          setupFailure = accountFailure(error);
        }
      });
      if (setupFailure) throw setupFailure;
      return { ...base, status: 'configured_paused' };
    }
    const selection = parseMailSelection(readJson(args.manifestFile)),
      witness = openTargetDraftJournal(o.roots.targetRoot, installationDigest);
    let reportedFailure: Error | undefined;
    try {
      const result = await withMailReaderStorage(
        o.roots,
        (readerStorage) =>
          withMailDraftWriterStorage(
            o.roots,
            async (storage) => {
              let readerProfile: MailHostFences | undefined,
                writerProfile: MailHostFences | undefined,
                store: Awaited<ReturnType<typeof connectOwnerMailStore>> | undefined;
              try {
                readerProfile = await openMailFences(o.roots, d.inspect, memory);
                writerProfile = await openMailProfile('mail_draft_writer', o.roots, () => ({}), d.inspect, memory);
                const current = () => {
                  authority();
                  witness.assertCurrent();
                  readerStorage.assertCurrent();
                  storage.assertCurrent();
                  readerProfile!.verifyStorage();
                  writerProfile!.verifyStorage();
                  readerProfile!.fences.assertOpen(args.scopeId, args.readerBindingId);
                  writerProfile!.fences.assertOpen(args.scopeId, args.writerBindingId);
                };
                current();
                const readerClient = checkedClient(readerStorage.readClient() as Parameters<typeof checkedClient>[0]),
                  client = checkedClient(storage.readClient() as Parameters<typeof checkedClient>[0]);
                if (readerClient.clientId === client.clientId) throw Error('mail_draft_account_operation_unavailable');
                store = await (d.connect ?? connectOwnerMailStore)(o.env, o.roots, () => {
                  current();
                  return true;
                });
                const context = { ...o.binding, ingressId: 'owner-mail-draft-' + args.requestId },
                  selected = await store.connection(context, args.readerBindingId);
                await check();
                current();
                if (selected.status !== 'ok' || !object(selected.binding))
                  throw Error('mail_draft_account_operation_unavailable');
                const b = selected.binding;
                if (
                  b.id !== args.readerBindingId ||
                  b.provider !== 'google' ||
                  b.auth !== 'ready' ||
                  b.mailboxEmail !== selection.mailboxEmail ||
                  !Array.isArray(b.scopes) ||
                  b.scopes.length !== 1 ||
                  b.scopes[0] !== GOOGLE_MAIL_READ_SCOPE ||
                  !Array.isArray(b.processingProviders) ||
                  b.processingProviders.length !== 1 ||
                  b.processingProviders[0] !== 'codex' ||
                  typeof b.credentialRef !== 'string' ||
                  b.credentialRef === args.writerBindingId
                )
                  throw Error('mail_draft_account_operation_unavailable');
                const reference = b.credentialRef,
                  selectedDigest = digest(selected);
                const checked = async () => {
                  await check();
                  current();
                  if (digest(await store!.connection(context, args.readerBindingId)) !== selectedDigest)
                    throw Error('mail_draft_account_operation_unavailable');
                  await check();
                  current();
                };
                const fetch: OAuthTransport['fetch'] = async (url, init) => {
                  await checked();
                  const result = await (d.fetch ?? globalThis.fetch)(url, init);
                  await checked();
                  return result;
                };
                const journal = operation(o.roots, args.writerBindingId, {
                  command: args.command,
                  requestId: args.requestId,
                  binding: o.binding,
                  installationDigest,
                  selection,
                  readerBindingId: args.readerBindingId,
                  selectedDigest,
                  readerClientDigest: digest(readerClient),
                  clientDigest: digest(client),
                  journalGeneration: witness.generation,
                });
                const credentialJournal = d.credentialJournal ?? createVaultCredentialJournal(o.roots, memory),
                  readerCredentials = new MailCredentialOwner(
                    readerStorage.root + '/credentials',
                    readerClient,
                    readerProfile.fences,
                    { fetch },
                    current,
                    credentialJournal,
                  ),
                  credentials = new MailDraftCredentialOwner(
                    storage.root + '/credentials',
                    client,
                    writerProfile.fences,
                    { fetch },
                    current,
                    credentialJournal,
                  );
                await checked();
                const readerCredential = await readerCredentials.inspect(args.scopeId, args.readerBindingId, reference);
                if (
                  readerCredential.auth !== 'ready' ||
                  readerCredential.scopes.length !== 1 ||
                  readerCredential.scopes[0] !== GOOGLE_MAIL_READ_SCOPE
                )
                  throw Error('mail_draft_account_operation_unavailable');
                const reader = googleMailReader({
                  access: async () => {
                    await checked();
                    return {
                      generation: args.readerBindingId,
                      mailboxEmail: selection.mailboxEmail,
                      scopes: [GOOGLE_MAIL_READ_SCOPE],
                      auth: 'ready',
                    };
                  },
                  token: () => readerCredentials.token(args.scopeId, args.readerBindingId, reference),
                  fetch,
                });
                await reader.profile();
                await checked();
                await backup(journal, 'before');
                await checked();
                await authorizeMailProfile({
                  root: journal,
                  profile: 'mail_draft_writer',
                  scopeId: args.scopeId,
                  bindingId: args.writerBindingId,
                  reference: args.writerBindingId,
                  client,
                  credentials,
                  credentialsPresent: () =>
                    !!fs.lstatSync(storage.root + '/credentials/' + args.writerBindingId + '.json', {
                      throwIfNoEntry: false,
                    }),
                  check: checked,
                  fetch,
                  display: d.display,
                  verifyMailbox: (token) => verifyMailDraftMailbox(selection.mailboxEmail, token, { current, fetch }),
                });
                await checked();
                const credential = await credentials.inspect(args.scopeId, args.writerBindingId, args.writerBindingId);
                if (
                  credential.auth !== 'ready' ||
                  credential.scopes.length !== 1 ||
                  credential.scopes[0] !== GOOGLE_MAIL_DRAFT_SCOPE
                )
                  throw Error('mail_draft_account_operation_unavailable');
                await checked();
                await backup(journal, 'after');
                await checked();
                const consent: MailDraftAccountConsent = {
                  format: 'cos-mail-draft-account-consent/v1',
                  installationDigest,
                  nativeBindingDigest: digest(o.binding),
                  journalGeneration: witness.generation,
                  requestId: args.requestId,
                  readerConnectionDigest: selectedDigest,
                  selection: {
                    scopeId: args.scopeId,
                    readerBindingId: args.readerBindingId,
                    writerBindingId: args.writerBindingId,
                    readerReference: reference,
                    writerReference: args.writerBindingId,
                    mailboxDigest: digest(selection.mailboxEmail),
                    readerClientDigest: digest(readerClient.clientId),
                    writerClientDigest: digest(client.clientId),
                  },
                };
                if (fs.lstatSync(journal + '/consent.json', { throwIfNoEntry: false })) {
                  if (
                    digest(
                      readMailDraftAccountConsent(
                        o.roots.targetRoot,
                        installationDigest,
                        o.binding,
                        args.writerBindingId,
                        witness,
                      ),
                    ) !== digest(consent)
                  )
                    throw Error('mail_draft_operation_conflict');
                } else writeAtomic(journal, 'consent.json', consent);
                await checked();
                readMailDraftAccountConsent(
                  o.roots.targetRoot,
                  installationDigest,
                  o.binding,
                  args.writerBindingId,
                  witness,
                );
                return {
                  ...base,
                  status: 'linked_paused',
                  reader_binding_id: args.readerBindingId,
                  writer_binding_id: args.writerBindingId,
                };
                // eslint-disable-next-line no-catch-all/no-catch-all -- Carry only fixed owner results until both held vault callbacks and resources close.
              } catch (error) {
                reportedFailure = accountFailure(error);
                return { status: 'unavailable' };
              } finally {
                try {
                  await writerProfile?.close();
                } finally {
                  try {
                    await readerProfile?.close();
                  } finally {
                    await store?.database.pool.end();
                  }
                }
              }
            },
            d.inspect,
            memory,
          ),
        d.inspect,
        memory,
      );
      if (reportedFailure) throw reportedFailure;
      return result;
    } finally {
      witness.close();
    }
  } catch (error) {
    // Tokens, selected accounts, callback URLs and storage/driver diagnostics stay private.
    throw accountFailure(error);
  } finally {
    stream?.destroy();
  }
}
function accountFailure(error: unknown): Error {
  return Error(
    error instanceof Error &&
      [
        'invalid_admin_arguments',
        'invalid_mail_manifest',
        'mail_draft_operation_conflict',
        'mail_draft_link_uncertain',
        'mail_draft_interactive_terminal_required',
        'mail_client_input_unavailable',
      ].includes(error.message)
      ? error.message
      : 'mail_draft_account_operation_unavailable',
  );
}
