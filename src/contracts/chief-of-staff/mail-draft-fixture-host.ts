/** Explicit synthetic Gmail wire adapter. No live OAuth, credentials, model or network is present. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { cosBoundary, type CosBinding } from '../../cos-boundary.js';
import { getSession } from '../../db/sessions.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import type { CalendarAccessFences } from '../../modules/chief-of-staff/calendar/access-fences.js';
import type { MailDraftAuthority } from '../../modules/chief-of-staff/mail-drafts/authority.js';
import type { MailDraftDependencies } from '../../modules/chief-of-staff/mail-drafts/store.js';
import { validMailDraftBinding, type MailDraftBinding } from '../../modules/chief-of-staff/mail-drafts/binding.js';
import { DraftJournal } from '../../modules/chief-of-staff/mail-drafts/journal.js';
import { googleMailDraftWriter } from '../../modules/chief-of-staff/mail-drafts/google-writer.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from '../../modules/chief-of-staff/mail-drafts/oauth.js';
import { subscriptionActivation } from '../../modules/chief-of-staff/bridge/model-policy.js';
import {
  privateConversationDirectory,
  readConversationOwner,
} from '../../modules/chief-of-staff/ops/conversation-ownership.js';
import { readPrivate, writeAtomic } from '../../modules/chief-of-staff/ops/target-state.js';

export type MailDraftFixtureConfiguration = {
  authority: MailDraftAuthority;
  writerId: string;
  policy: MailDraftBinding;
  mailboxEmail: string;
  sources: Array<{
    id: string;
    threadId: string;
    internalDate: number;
    headers: Array<{ name: string; value: string }>;
  }>;
};
const modes = ['success', 'timeout-after-create', 'edited', 'missing', 'sent'] as const;
type Mode = (typeof modes)[number];
type Saved = {
  id: string;
  message: {
    id: string;
    threadId: string;
    labelIds: string[];
    payload: {
      mimeType: 'text/plain';
      headers: Array<{ name: string; value: string }>;
      body: { data: string; size: number };
    };
  };
};
type ProviderState = {
  mode: Mode;
  writes: number;
  unreadable: string | null;
  last: string | null;
  drafts: Record<string, Saved>;
};
export function createMailDraftFixtureHost(
  root: string,
  native: Database.Database,
  binding: CosBinding,
  input: MailDraftFixtureConfiguration,
  readerFences?: CalendarAccessFences,
) {
  assert.equal(process.env.COS_FIXTURE_HOST_PROCESS, 'S01');
  assert.equal(input.policy.provider, 'fixture');
  assert(validMailDraftBinding(input.policy));
  assert.equal(input.authority.bindingDigest, digest(binding));
  assert.equal(input.policy.nativeBindingDigest, digest(binding));
  assert.equal(input.authority.draftProfileDigest, digest('cos-mail-draft/v1'));
  assert.equal(input.policy.mailboxDigest, digest(input.mailboxEmail));
  assert.equal(input.policy.readerClientDigest, digest('reader-fixture.apps.googleusercontent.com'));
  assert.equal(input.policy.writerClientDigest, digest('writer-fixture.apps.googleusercontent.com'));
  assert(input.sources.length > 0 && input.sources.length <= 20);
  privateConversationDirectory(root);
  const directory = path.join(root, 'mail-draft-fixture');
  privateConversationDirectory(directory);
  const journal = new DraftJournal(
      path.join(directory, 'effects'),
      digest({ fixture: true, binding }),
      input.policy.journalGeneration,
    ),
    stateFile = path.join(directory, 'provider.json');
  if (!fs.lstatSync(stateFile, { throwIfNoEntry: false }))
    writeAtomic(directory, 'provider.json', { mode: 'success', writes: 0, unreadable: null, last: null, drafts: {} });
  const read = () => readPrivate<ProviderState>(stateFile),
    shutdown = new AbortController();
  const authority: MailDraftDependencies['authority'] = (context) => {
    try {
      journal.assertCurrent();
      const session = getSession(context.sessionId),
        boundary = session && cosBoundary(session, native),
        retained = native
          .prepare(
            'SELECT generation,status,binding_digest,account_fingerprint FROM cos_conversation_states WHERE scope_id=?',
          )
          .get(binding.scopeId) as
          | { generation: string; status: string; binding_digest: string; account_fingerprint: string }
          | undefined;
      if (
        shutdown.signal.aborted ||
        !readerFences ||
        !boundary?.restricted ||
        boundary.paused ||
        digest(boundary.binding) !== digest(binding) ||
        !retained ||
        retained.status !== 'active' ||
        retained.binding_digest !== digest(binding) ||
        retained.account_fingerprint !== 'a'.repeat(64) ||
        context.origin ||
        retained.generation !== input.authority.contextGeneration ||
        context.scopeId !== binding.scopeId ||
        context.ownerId !== binding.ownerId ||
        context.agentGroupId !== binding.agentGroupId ||
        context.sessionId !== binding.sessionId
      )
        return null;
      readerFences.assertOpen(binding.scopeId, input.policy.readerBindingId);
      const policy = subscriptionActivation(
          readPrivate(path.join(root, 'model-activation.json')),
          binding.scopeId,
          'a'.repeat(64),
        ),
        owner = readConversationOwner(root, retained.generation, binding);
      return policy &&
        digest(policy) === input.authority.provider.policyDigest &&
        owner.state === 'retained' &&
        owner.accountFingerprint === 'a'.repeat(64)
        ? structuredClone(input.authority)
        : null;
      // eslint-disable-next-line no-catch-all/no-catch-all -- Lost synthetic native/retained ownership denies fixture authority just as the production resolver does.
    } catch {
      return null;
    }
  };
  const pending = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>) => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const dependencies: MailDraftDependencies = {
    journal,
    authority,
    matches: (context, selected) =>
      !!authority(context) &&
      selected.id === input.writerId &&
      selected.reader_provider === 'fixture' &&
      digest(selected.body) === digest(input.policy),
    writer: (context, selected, current, source) => {
      if (!authority(context) || selected.id !== input.writerId || digest(selected.body) !== digest(input.policy))
        return null;
      const writer = googleMailDraftWriter({
        journal,
        signal: shutdown.signal,
        admitted: () => !!authority(context),
        access: async () => {
          assert.equal(await current(), true);
          return {
            generation: input.policy.credentialReference,
            scopeId: binding.scopeId,
            bindingId: input.writerId,
            contextGeneration: input.authority.contextGeneration,
            mailboxEmail: input.mailboxEmail,
            readerMailboxEmail: input.mailboxEmail,
            clientId: 'writer-fixture.apps.googleusercontent.com',
            readerClientId: 'reader-fixture.apps.googleusercontent.com',
            auth: 'ready',
            scopes: [GOOGLE_MAIL_DRAFT_SCOPE],
            writeEnabled: true,
          };
        },
        token: async () => {
          assert.equal(await current(), true);
          return 'FIXTURE_DRAFT_TOKEN_NOT_LIVE';
        },
        sourceReader: {
          replySource: async (id) => {
            assert.equal(await current(), true);
            const row = input.sources.find((s) => s.id === id);
            assert(row);
            assert.equal(row.threadId, source.thread_id);
            assert.equal(row.internalDate, source.internal_date_ms);
            return {
              source: {
                id,
                threadId: row.threadId,
                mailboxEmail: input.mailboxEmail,
                headers: structuredClone(row.headers),
              },
              internalDate: row.internalDate,
              observedAt: Date.now(),
              historyId: '100',
              hasDraft: false,
              alreadyAnswered: false,
            };
          },
        },
        fetch: async (url, init) => {
          assert.equal(await current(), true);
          assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer FIXTURE_DRAFT_TOKEN_NOT_LIVE');
          const endpoint = new URL(url);
          assert.equal(endpoint.origin, 'https://gmail.googleapis.com');
          const state = read();
          if (endpoint.pathname === '/gmail/v1/users/me/profile') {
            assert.equal(init.method, 'GET');
            return Response.json({ emailAddress: input.mailboxEmail });
          }
          assert(
            endpoint.pathname === '/gmail/v1/users/me/drafts' ||
              /^\/gmail\/v1\/users\/me\/drafts\/r-fixture-(?:[1-9]|1[0-9]|20)$/.test(endpoint.pathname),
          );
          if (init.method === 'POST') {
            assert.equal(endpoint.pathname, '/gmail/v1/users/me/drafts');
            // Count every attempted POST before checking its body or uniqueness. The fixture
            // must expose a replay/cap failure rather than enforcing those production rules itself.
            state.writes++;
            writeAtomic(directory, 'provider.json', state);
            const message = JSON.parse(String(init.body)).message,
              reserved = input.sources.find(
                (s) => s.threadId === message.threadId && journal.findSource(input.policy.mailboxDigest, s.id),
              );
            assert(reserved);
            assert(!Object.values(state.drafts).some((d) => d.message.threadId === message.threadId));
            const [head, encodedBody] = Buffer.from(message.raw, 'base64url').toString('utf8').split('\r\n\r\n'),
              body = Buffer.from(encodedBody, 'base64'),
              headers = head
                .replace(/\r\n[ \t]+/g, ' ')
                .split('\r\n')
                .map((line) => {
                  const at = line.indexOf(':');
                  return { name: line.slice(0, at), value: line.slice(at + 1).trim() };
                });
            const id = 'r-fixture-' + state.writes,
              messageId = 'dd0' + state.writes;
            state.drafts[id] = {
              id,
              message: {
                id: messageId,
                threadId: message.threadId,
                labelIds: ['DRAFT'],
                payload: {
                  mimeType: 'text/plain',
                  headers,
                  body: { data: body.toString('base64url'), size: body.length },
                },
              },
            };
            state.last = id;
            if (state.mode === 'timeout-after-create') state.unreadable = id;
            writeAtomic(directory, 'provider.json', state);
            return Response.json({ id, message: { id: messageId, threadId: message.threadId } });
          }
          assert.equal(init.method, 'GET');
          if (endpoint.pathname.endsWith('/drafts'))
            return Response.json({
              drafts: Object.values(state.drafts).map((d) => ({
                id: d.id,
                message: { id: d.message.id, threadId: d.message.threadId },
              })),
            });
          const id = endpoint.pathname.split('/').at(-1)!;
          if (state.unreadable === id) throw Error('fixture_readback_unavailable');
          return state.drafts[id] ? Response.json(state.drafts[id]) : new Response('{}', { status: 404 });
        },
      });
      return { create: (request) => track(writer.create(request)), status: (id) => track(writer.status(id)) };
    },
  };
  return {
    dependencies,
    generation: journal.generation,
    state() {
      const s = read();
      return { writes: s.writes, sends: 0, drafts: Object.values(s.drafts) };
    },
    mode(value: unknown) {
      if (!modes.includes(value as Mode)) throw Error('invalid_fixture_mode');
      const state = read();
      state.mode = value as Mode;
      state.unreadable = null;
      const draft = state.last && state.drafts[state.last];
      if (draft && value === 'edited')
        draft.message.payload.body = {
          data: Buffer.from('Owner edited fixture text').toString('base64url'),
          size: Buffer.byteLength('Owner edited fixture text'),
        };
      if (draft && value === 'sent') draft.message.labelIds = ['SENT'];
      if (state.last && value === 'missing') delete state.drafts[state.last];
      writeAtomic(directory, 'provider.json', state);
      return true;
    },
    async close() {
      shutdown.abort();
      await Promise.allSettled([...pending]);
      journal.close();
    },
  };
}
