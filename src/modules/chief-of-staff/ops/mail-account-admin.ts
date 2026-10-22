/** Trusted owner account setup, never a model/message capability. */
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { backupCalendarState } from '../calendar/backup.js';
import { checkedClient, GOOGLE_MAIL_READ_SCOPE, type OAuthTransport } from '../calendar/oauth-core.js';
import { object } from '../calendar/normalization.js';
import { initializeMailProfile } from '../mail/setup.js';
import { withMailReaderStorage } from '../mail/storage.js';
import { openMailFences } from '../mail/config.js';
import { MailCredentialOwner } from '../mail/credentials.js';
import { googleMailReader } from '../mail/google-reader.js';
import { consumeMailClientStream } from './mail-client-stream.js';
import { connectOwnerMailStore } from './owner-mail-store.js';
import { createVaultCredentialJournal } from './backup-credential-journal.js';
import type { CredentialJournal } from './backup-credential-event.js';
import { verifyVaultMemory } from './vault-memory.js';
import { readCalendarAdminJson as readJson, calendarAdminDirectory as directory } from './calendar-admin.js';
import { writeAtomic } from './target-state.js';
import type { ReleaseManifest } from './release-manifest.js';
import { authorizeMailProfile } from './mail-authorization.js';

import { parseMailAccountArguments, type MailAccountArguments } from './mail-account-arguments.js';
export {
  isMailAccountCommand,
  parseMailAccountArguments,
  type MailAccountArguments,
} from './mail-account-arguments.js';
export type MailSelection = { mailboxEmail: string; processingProviders: ['codex'] };
export function parseMailSelection(value: unknown): MailSelection {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'mailboxEmail,processingProviders' ||
    typeof value.mailboxEmail !== 'string' ||
    value.mailboxEmail.length > 254 ||
    !/^[a-z0-9][a-z0-9._%+-]{0,127}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$/i.test(value.mailboxEmail) ||
    !Array.isArray(value.processingProviders) ||
    value.processingProviders.length !== 1 ||
    value.processingProviders[0] !== 'codex'
  )
    throw Error('invalid_mail_manifest');
  return { mailboxEmail: value.mailboxEmail.toLowerCase(), processingProviders: ['codex'] };
}
type Options = {
  args: MailAccountArguments;
  roots: CalendarStorageRoots;
  env: NodeJS.ProcessEnv;
  binding: CosBinding;
  release: ReleaseManifest;
  check(): Promise<void>;
  assertAuthority(): void;
};
/** Code-only fixtures; no command or environment can select a transport, storage
 * bypass, identity, alternate database role, client path or callback endpoint.
 */
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
  const root = directory(directory(roots.targetRoot, 'mail-admin'), id),
    expected = { contract: 'cos-mail-admin/v1', requestDigest: digest(request) },
    file = root + '/request.json';
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    if (digest(readJson(file)) !== digest(expected)) throw Error('mail_operation_conflict');
  } else {
    if (fs.readdirSync(root).length) throw Error('mail_operation_conflict');
    writeAtomic(root, 'request.json', expected);
  }
  return root;
}
/** Requires the installed healthy G04 payload plus enclosing target, maintenance,
 * native host and paused private owner checks. Linking leaves all those pauses,
 * model counters and conversation identities unchanged. It reads only /profile.
 */
export async function runMailAccountAdmin(o: Options, d: Dependencies = {}): Promise<Record<string, unknown>> {
  const stream = o.args.command === 'mail-setup' ? (d.stream ?? process.stdin) : undefined;
  try {
    const memory = d.memory ?? verifyVaultMemory;
    const authority = () => {
      memory();
      o.assertAuthority();
    };
    const check = async () => {
      authority();
      await o.check();
      authority();
    };
    await check();
    const args = parseMailAccountArguments(
      o.args.command === 'mail-setup'
        ? [o.args.command, '--scope', o.args.scopeId, '--request-id', o.args.requestId]
        : [
            o.args.command,
            '--scope',
            o.args.scopeId,
            '--request-id',
            o.args.requestId,
            '--binding',
            o.args.bindingId,
            '--manifest',
            o.args.manifestFile,
          ],
    );
    if (
      args.scopeId !== o.binding.scopeId ||
      o.binding.provider !== 'codex' ||
      o.release.slice !== 'G04' ||
      o.release.postgres.minimum !== 19 ||
      o.release.postgres.maximum !== 19
    )
      throw Error('mail_account_operation_unavailable');
    const base = { scope_id: args.scopeId, paused: true, live_model: 'not_invoked' };
    const backup = async (root: string, phase: 'before' | 'after') =>
      backupCalendarState({
        roots: o.roots,
        operationId: 'mail-' + args.requestId + '-' + phase,
        receiptRoot: directory(root, phase),
        check,
        inspect: d.inspect,
        memory,
      });
    if (args.command === 'mail-setup') {
      await consumeMailClientStream(stream!, async (client) => {
        await check();
        const journal = operation(o.roots, args.requestId, {
          command: args.command,
          binding: o.binding,
          clientDigest: digest(client),
        });
        await backup(journal, 'before');
        await check();
        await initializeMailProfile(
          o.roots,
          client,
          { operationId: args.requestId, assertAuthority: authority },
          d.inspect,
          memory,
        );
        await check();
        await backup(journal, 'after');
        await check();
      });
      return { ...base, status: 'configured_paused' };
    }
    let selection: MailSelection;
    try {
      selection = parseMailSelection(readJson(args.manifestFile));
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Private manifest content and paths cannot enter diagnostics.
      throw Error('invalid_mail_manifest');
    }
    let reportedFailure: Error | undefined;
    const result = await withMailReaderStorage(
      o.roots,
      async (storage) => {
        const profile = await openMailFences(o.roots, d.inspect, memory);
        let store: Awaited<ReturnType<typeof connectOwnerMailStore>> | undefined;
        try {
          const current = () => {
            authority();
            storage.assertCurrent();
            profile.verifyStorage();
          };
          const admitted = () => {
            current();
            return true;
          };
          const fetch: OAuthTransport['fetch'] = async (url, init) => {
            await check();
            current();
            const response = await (d.fetch ?? globalThis.fetch)(url, init);
            await check();
            current();
            return response;
          };
          current();
          const client = checkedClient(storage.readClient() as Parameters<typeof checkedClient>[0]);
          const credentials = new MailCredentialOwner(
            storage.root + '/credentials',
            client,
            profile.fences,
            { fetch },
            current,
            d.credentialJournal ?? createVaultCredentialJournal(o.roots, memory),
          );
          profile.fences.assertOpen(args.scopeId, args.bindingId);
          const journal = operation(o.roots, args.bindingId, {
            command: args.command,
            requestId: args.requestId,
            binding: o.binding,
            selection,
            clientDigest: digest(client),
          });
          store = await (d.connect ?? connectOwnerMailStore)(o.env, o.roots, admitted);
          const context = { ...o.binding, ingressId: 'owner-mail-' + args.requestId };
          const coverage = await store.coverage(context);
          await check();
          current();
          if (coverage.status !== 'ok') return { ...base, binding_id: args.bindingId, status: coverage.status };
          await backup(journal, 'before');
          await check();
          current();
          const verifyMailbox = async (token: () => Promise<string>) => {
            const reader = googleMailReader({
              access: async () => {
                await check();
                current();
                return {
                  generation: args.bindingId,
                  mailboxEmail: selection.mailboxEmail,
                  scopes: [GOOGLE_MAIL_READ_SCOPE],
                  auth: 'ready',
                };
              },
              token,
              fetch,
            });
            await reader.profile();
            await check();
            current();
          };
          await authorizeMailProfile({
            root: journal,
            profile: 'mail_reader',
            scopeId: args.scopeId,
            bindingId: args.bindingId,
            reference: args.bindingId,
            client,
            credentials,
            credentialsPresent: () =>
              !!fs.lstatSync(storage.root + '/credentials/' + args.bindingId + '.json', { throwIfNoEntry: false }),
            verifyMailbox,
            check,
            fetch,
            display: d.display,
          });
          const credential = await credentials.inspect(args.scopeId, args.bindingId, args.bindingId);
          await check();
          current();
          await backup(journal, 'after');
          await check();
          current();
          profile.fences.assertOpen(args.scopeId, args.bindingId);
          const result = await store.bind(context, {
            id: args.bindingId,
            provider: 'google',
            ...selection,
            credentialRef: args.bindingId,
            scopes: credential.scopes,
          });
          await check();
          current();
          return { ...base, binding_id: args.bindingId, status: result.status };
          // eslint-disable-next-line no-catch-all/no-catch-all -- Carry only the fixed owner result until the vault callback verifies and closes every held descriptor.
        } catch (error) {
          // Carry only our fixed owner result across the vault callback. The vault
          // deliberately replaces thrown callback/storage diagnostics; it must still
          // verify and close every held descriptor before this result is reported.
          reportedFailure = accountFailure(error);
          return { status: 'unavailable' };
        } finally {
          try {
            await profile.close();
          } finally {
            await store?.database.pool.end();
          }
        }
      },
      d.inspect,
      memory,
    );
    if (reportedFailure) throw reportedFailure;
    return result;
  } catch (error) {
    // Tokens, client bytes, selected accounts, callbacks and nested storage/driver diagnostics stay private.
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
        'mail_operation_conflict',
        'mail_link_uncertain',
        'mail_interactive_terminal_required',
        'mail_client_input_unavailable',
      ].includes(error.message)
      ? error.message
      : 'mail_account_operation_unavailable',
  );
}
