import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { DraftJournal, initializeDraftJournal } from './journal.js';
import { googleMailDraftWriter, type MailDraftWriterAccess } from './google-writer.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
import type { FreshReplySource } from './source.js';
const cleanup: string[] = [],
  journals: DraftJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const now = Date.parse('2026-10-23T00:00:00Z');
const request = {
  requestId: '11111111-1111-4111-8111-111111111111',
  sourceMessageId: 'aa01',
  text: 'A harmless fixture reply',
};
function saved(raw: string) {
  const [head, body] = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n');
  const headers = head
    .replace(/\r\n[ \t]+/g, ' ')
    .split('\r\n')
    .map((line) => {
      const index = line.indexOf(':');
      return { name: line.slice(0, index), value: line.slice(index + 1).trim() };
    });
  return {
    id: 'r-123',
    message: {
      id: 'dd04',
      threadId: 'bb02',
      labelIds: ['DRAFT'],
      payload: {
        mimeType: 'text/plain',
        headers,
        body: { data: Buffer.from(body, 'base64').toString('base64url'), size: Buffer.from(body, 'base64').length },
      },
    },
  };
}
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-writer-'));
  cleanup.push(parent);
  const root = parent + '/effects',
    installation = digest('fixture installation'),
    owner = initializeDraftJournal(root, installation),
    journal = new DraftJournal(root, installation, owner.generation);
  journals.push(journal);
  let access: MailDraftWriterAccess = {
    generation: 'fixture:1',
    scopeId: 'chief-of-staff',
    bindingId: '22222222-2222-4222-8222-222222222222',
    contextGeneration: '33333333-3333-4333-8333-333333333333',
    mailboxEmail: 'owner@example.test',
    readerMailboxEmail: 'owner@example.test',
    clientId: 'draft-fixture.apps.googleusercontent.com',
    readerClientId: 'reader-fixture.apps.googleusercontent.com',
    auth: 'ready',
    scopes: [GOOGLE_MAIL_DRAFT_SCOPE],
    writeEnabled: true,
  };
  let admitted = true,
    account = 'owner@example.test',
    lostPost = false,
    postStatus = 200,
    overflow = false,
    extraDraft = false;
  const drafts = new Map<string, ReturnType<typeof saved>>();
  const source: FreshReplySource = {
    source: {
      id: 'aa01',
      threadId: 'bb02',
      mailboxEmail: 'owner@example.test',
      headers: [
        { name: 'From', value: 'sender@example.test' },
        { name: 'To', value: 'owner@example.test' },
        { name: 'Subject', value: 'Fixture subject' },
        { name: 'Message-ID', value: '<source@example.test>' },
      ],
    },
    internalDate: now - 1000,
    observedAt: now,
    historyId: '123',
    hasDraft: false,
    alreadyAnswered: false,
  };
  const sourceReader = { replySource: vi.fn(async () => structuredClone(source)) };
  const token = vi.fn(async () => 'FIXTURE_PRIVATE_DRAFT_TOKEN');
  const controller = new AbortController();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/profile')) return new Response(JSON.stringify({ emailAddress: account }));
    if (init.method === 'POST') {
      if (postStatus !== 200)
        return new Response(JSON.stringify({ error: { message: 'PRIVATE_PROVIDER_DIAGNOSTIC' } }), {
          status: postStatus,
        });
      const body = JSON.parse(String(init.body)),
        draft = saved(body.message.raw);
      drafts.set(draft.id, draft);
      if (lostPost) throw Error('PRIVATE_POST_TIMEOUT');
      return new Response(
        JSON.stringify({ id: draft.id, message: { id: draft.message.id, threadId: draft.message.threadId } }),
      );
    }
    if (parsed.pathname.endsWith('/drafts')) {
      const query = parsed.searchParams.get('q');
      const matching = [...drafts.values()].filter(
        (draft) =>
          !query ||
          draft.message.payload.headers.some((header) => header.name === 'Message-ID' && query.includes(header.value)),
      );
      const result = matching.map((draft) => ({
        id: draft.id,
        message: { id: draft.message.id, threadId: draft.message.threadId },
      }));
      if (extraDraft && !query) result.push({ id: 'human-draft', message: { id: 'ff06', threadId: 'bb02' } });
      return new Response(
        JSON.stringify({
          drafts: result,
          resultSizeEstimate: result.length,
          ...(overflow ? { nextPageToken: 'repeated-page' } : {}),
        }),
      );
    }
    const id = parsed.pathname.split('/').at(-1)!;
    return drafts.has(id) ? new Response(JSON.stringify(drafts.get(id))) : new Response('{}', { status: 404 });
  });
  const writer = googleMailDraftWriter({
    access: async () => structuredClone(access),
    token,
    admitted: () => admitted,
    sourceReader,
    journal,
    fetch,
    now: () => now,
    signal: controller.signal,
  });
  return {
    writer,
    journal,
    fetch,
    token,
    sourceReader,
    source,
    drafts,
    change: (patch: Partial<MailDraftWriterAccess>) => {
      access = { ...access, ...patch };
    },
    admitted: (value: boolean) => {
      admitted = value;
    },
    account: (value: string) => {
      account = value;
    },
    losePost: () => {
      lostPost = true;
    },
    postStatus: (value: number) => {
      postStatus = value;
    },
    overflow: () => {
      overflow = true;
    },
    extraDraft: () => {
      extraDraft = true;
    },
    posts: () => fetch.mock.calls.filter(([, init]) => init.method === 'POST'),
    cancel: () => controller.abort(),
  };
}
it('journals before exactly one fixed POST and verifies a real separately fetched draft', async () => {
  const f = fixture();
  const result = await f.writer.create(request);
  expect(result.status).toBe('verified');
  expect('operationId' in result).toBe(true);
  expect(f.posts()).toHaveLength(1);
  expect(new URL(f.posts()[0][0]).pathname).toBe('/gmail/v1/users/me/drafts');
  expect(f.posts()[0][1]).toMatchObject({
    redirect: 'error',
    headers: { Authorization: 'Bearer FIXTURE_PRIVATE_DRAFT_TOKEN' },
  });
  const body = JSON.parse(String(f.posts()[0][1].body));
  expect(Object.keys(body)).toEqual(['message']);
  expect(Object.keys(body.message).sort()).toEqual(['raw', 'threadId']);
  expect(JSON.stringify(result)).not.toContain('reply');
  expect(JSON.stringify(result)).not.toContain('TOKEN');
  const again = await f.writer.create(request);
  expect(again.status).toBe('verified');
  expect('existing' in again && again.existing).toBe(true);
  expect(f.posts()).toHaveLength(1);
});
it('reconciles an accepted POST with a lost response without blindly creating again', async () => {
  const f = fixture();
  f.losePost();
  const result = await f.writer.create(request);
  expect(result.status).toBe('uncertain');
  expect(f.posts()).toHaveLength(1);
  if (!('operationId' in result)) throw Error('fixture_missing_operation');
  expect(f.journal.find(result.operationId)?.state).toBe('reserved');
  expect((await f.writer.status(result.operationId)).status).toBe('verified');
  expect(f.posts()).toHaveLength(1);
  expect(f.fetch.mock.calls.some(([url]) => new URL(url).searchParams.get('format') === 'metadata')).toBe(true);
});
it.each([false, true])('verifies a provider-rewritten Message-ID with lost POST response %s', async (lost) => {
  const f = fixture(),
    original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    if (init.method !== 'POST') return original(url, init);
    const response = await original(url, init);
    const draft = [...f.drafts.values()][0];
    draft.message.payload.headers = draft.message.payload.headers.map((h) =>
      h.name === 'Message-ID' ? { ...h, value: '<provider-generated@mail.gmail.com>' } : h,
    );
    if (lost) throw Error('PRIVATE_LOST_RESPONSE');
    return response;
  });
  const created = await f.writer.create(request);
  expect(created.status).toBe(lost ? 'uncertain' : 'verified');
  if (!('operationId' in created)) throw Error('fixture_missing_operation');
  expect((await f.writer.status(created.operationId)).status).toBe('verified');
  expect(f.posts()).toHaveLength(1);
});
it('uses only source-thread headers to locate a rewritten ID and never reads unrelated draft bodies', async () => {
  const f = fixture();
  f.losePost();
  const result = await f.writer.create(request);
  if (!('operationId' in result)) throw Error('fixture_missing_operation');
  const own = [...f.drafts.values()][0];
  own.message.payload.headers.find((h) => h.name === 'Message-ID')!.value = '<provider@mail.gmail.com>';
  const other = structuredClone(own);
  other.id = 'human-same-thread';
  other.message.id = 'ee05';
  other.message.payload.headers.find((h) => h.name === 'X-NanoClaw-Correlation')!.value = 'b'.repeat(64);
  f.drafts.set(other.id, other);
  const unrelated = structuredClone(other);
  unrelated.id = 'unrelated-thread';
  unrelated.message.threadId = 'ff06';
  f.drafts.set(unrelated.id, unrelated);
  f.fetch.mockClear();
  expect((await f.writer.status(result.operationId)).status).toBe('verified');
  const reads = f.fetch.mock.calls.map(([url]) => new URL(url));
  expect(reads.some((u) => u.pathname.endsWith('/unrelated-thread'))).toBe(false);
  expect(
    reads.filter((u) => u.pathname.endsWith('/human-same-thread')).map((u) => u.searchParams.get('format')),
  ).toEqual(['metadata']);
  expect(f.posts()).toHaveLength(0);
});
it.each([false, true])(
  'fences duplicate correlations even when one retains its submitted Message-ID: %s',
  async (retained) => {
    const f = fixture();
    f.losePost();
    const result = await f.writer.create(request);
    if (!('operationId' in result)) throw Error('fixture_missing_operation');
    const own = [...f.drafts.values()][0];
    if (!retained)
      own.message.payload.headers.find((h) => h.name === 'Message-ID')!.value = '<provider@mail.gmail.com>';
    const duplicate = structuredClone(own);
    duplicate.id = 'duplicate';
    duplicate.message.id = 'ee05';
    duplicate.message.payload.headers.find((h) => h.name === 'Message-ID')!.value = '<second-provider@mail.gmail.com>';
    f.drafts.set(duplicate.id, duplicate);
    expect((await f.writer.status(result.operationId)).status).toBe('collision');
    expect(f.posts()).toHaveLength(1);
    expect(f.journal.find(result.operationId)?.state).toBe('collision');
  },
);
it.each([400, 401, 403, 429, 500, 503])(
  'never retries a %s create response or releases its daily reservation',
  async (status) => {
    const f = fixture();
    f.postStatus(status);
    const result = await f.writer.create(request);
    expect(result.status).toBe('uncertain');
    expect(f.posts()).toHaveLength(1);
    const retried = await f.writer.create(request);
    expect(retried.status).toBe('uncertain');
    expect(f.posts()).toHaveLength(1);
  },
);
it('keeps an uncertain missing correlation reserved instead of converting eventual search absence into a retry', async () => {
  const f = fixture();
  f.postStatus(503);
  const result = await f.writer.create(request);
  if (!('operationId' in result)) throw Error('fixture_missing_operation');
  expect((await f.writer.status(result.operationId)).status).toBe('uncertain');
  expect(f.journal.find(result.operationId)?.state).toBe('reserved');
  expect(f.posts()).toHaveLength(1);
});
it('does not overwrite human edits or recreate a later missing draft', async () => {
  const f = fixture(),
    result = await f.writer.create(request);
  if (!('operationId' in result)) throw Error('fixture_missing_operation');
  const draft = [...f.drafts.values()][0];
  draft.message.id = 'ee05';
  draft.message.payload.body.data = Buffer.from('PRIVATE_HUMAN_EDIT').toString('base64url');
  expect((await f.writer.status(result.operationId)).status).toBe('edited');
  f.drafts.clear();
  expect((await f.writer.status(result.operationId)).status).toBe('missing');
  expect((await f.writer.create(request)).status).toBe('missing');
  expect(f.posts()).toHaveLength(1);
});
it('retains an unverified POST candidate so an immediate human edit and later deletion cannot strand or recreate it', async () => {
  const f = fixture(),
    original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (init.method === 'POST') {
      const draft = [...f.drafts.values()][0];
      draft.message.id = 'ee05';
      draft.message.payload.body.data = Buffer.from('PRIVATE_IMMEDIATE_HUMAN_EDIT').toString('base64url');
    }
    return response;
  });
  const result = await f.writer.create(request);
  expect(result.status).toBe('edited');
  if (!('operationId' in result)) throw Error('fixture_missing_operation');
  expect(f.journal.find(result.operationId)?.candidate).toEqual({ draftId: 'r-123', messageId: 'dd04' });
  f.drafts.clear();
  expect((await f.writer.status(result.operationId)).status).toBe('missing');
  expect((await f.writer.create(request)).status).toBe('missing');
  expect(f.posts()).toHaveLength(1);
});
it('retains the exact POST candidate when the initial readback is temporarily unavailable', async () => {
  const f = fixture(),
    original = f.fetch.getMockImplementation()!;
  let failed = false;
  f.fetch.mockImplementation(async (url, init) => {
    if (url.includes('/drafts/') && !failed) {
      failed = true;
      return new Response('{}', { status: 503 });
    }
    return original(url, init);
  });
  const result = await f.writer.create(request);
  expect(result.status).toBe('uncertain');
  if (!('operationId' in result)) throw Error('fixture_missing_operation');
  expect(f.journal.find(result.operationId)).toMatchObject({
    state: 'reserved',
    saved: null,
    candidate: { draftId: 'r-123', messageId: 'dd04' },
  });
  expect((await f.writer.status(result.operationId)).status).toBe('verified');
  expect(f.fetch.mock.calls.some(([url]) => new URL(url).searchParams.has('q'))).toBe(false);
  expect(f.posts()).toHaveLength(1);
});
it.each(['draft', 'answered', 'unrelated-draft'] as const)(
  'skips a %s collision without creating or consuming a new reservation',
  async (kind) => {
    const f = fixture();
    if (kind === 'draft') f.source.hasDraft = true;
    else if (kind === 'answered') f.source.alreadyAnswered = true;
    else f.extraDraft();
    const result = await f.writer.create(request);
    expect(result.status).toBe('skipped');
    expect(f.posts()).toHaveLength(0);
    expect(f.journal.findSource(digest('owner@example.test'), 'aa01')).toBeNull();
  },
);
it('fences a new human draft detected after reservation without posting or freeing the uncertain attempt', async () => {
  const f = fixture();
  f.sourceReader.replySource.mockImplementation(async () => ({
    ...structuredClone(f.source),
    hasDraft: f.sourceReader.replySource.mock.calls.length > 1,
  }));
  const result = await f.writer.create(request);
  expect(result.status).toBe('collision');
  expect(f.posts()).toHaveLength(0);
  expect(f.journal.findSource(digest('owner@example.test'), 'aa01')?.state).toBe('collision');
});
it.each([
  { auth: 'revoked' as const },
  { writeEnabled: false },
  { scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  { scopes: [GOOGLE_MAIL_DRAFT_SCOPE, 'https://www.googleapis.com/auth/gmail.send'] },
  { readerMailboxEmail: 'other@example.test' },
  { clientId: 'reader-fixture.apps.googleusercontent.com' },
])('denies invalid or expanded authority before provider access: %j', async (patch) => {
  const f = fixture();
  f.change(patch);
  await expect(f.writer.create(request)).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.token).not.toHaveBeenCalled();
});
it('binds the actual token account before inspecting or creating drafts', async () => {
  const f = fixture();
  f.account('different@example.test');
  await expect(f.writer.create(request)).rejects.toThrow('mail_draft_wrong_account');
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(new URL(f.fetch.mock.calls[0][0]).pathname).toBe('/gmail/v1/users/me/profile');
  expect(f.posts()).toHaveLength(0);
});
it('exposes no send, update/delete, arbitrary URL or expanded raw-message request', async () => {
  const f = fixture();
  expect(Object.keys(f.writer).sort()).toEqual(['create', 'status']);
  for (const patch of [
    { send: true },
    { url: 'https://attacker.invalid' },
    { recipient: 'attacker@example.test' },
    { raw: 'unsafe' },
    { sourceMessageId: '../send' },
  ])
    await expect(f.writer.create({ ...request, ...patch })).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
});
it('fails closed on incomplete or repeated draft inventory pages before any POST', async () => {
  const f = fixture();
  f.overflow();
  await expect(f.writer.create(request)).rejects.toThrow('mail_draft_inventory_incomplete');
  expect(f.posts()).toHaveLength(0);
});
it('requires current native admission and makes no provider call after cancellation', async () => {
  const f = fixture();
  f.admitted(false);
  await expect(f.writer.create(request)).rejects.toThrow('mail_draft_not_admitted');
  expect(f.fetch).not.toHaveBeenCalled();
  const cancelled = fixture();
  cancelled.cancel();
  await expect(cancelled.writer.create(request)).rejects.toThrow('mail_draft_not_admitted');
  expect(cancelled.fetch).not.toHaveBeenCalled();
});
it('reports the real global daily limit before any POST, including uncertain earlier reservations', async () => {
  const f = fixture();
  for (let index = 1; index <= 5; index++)
    f.journal.reserve(
      {
        scopeId: 'chief-of-staff',
        bindingId: '22222222-2222-4222-8222-222222222222',
        contextGeneration: '33333333-3333-4333-8333-333333333333',
        mailboxDigest: digest('owner@example.test'),
        sourceMessageId: 'f' + index,
        threadId: 'e' + index,
        requestId: request.requestId,
        contentDigest: digest('uncertain fixture ' + index),
      },
      now,
    );
  await expect(f.writer.create(request)).rejects.toThrow('mail_draft_daily_limit');
  expect(f.posts()).toHaveLength(0);
});
it('allows only one POST when duplicate create requests race through their asynchronous preflights', async () => {
  const f = fixture();
  const results = await Promise.all([f.writer.create(request), f.writer.create(request)]);
  expect(results.some((result) => result.status === 'verified')).toBe(true);
  expect(results.every((result) => ['verified', 'uncertain'].includes(result.status))).toBe(true);
  expect(f.posts()).toHaveLength(1);
});
it('keeps an accepted save uncertain when native admission is lost mid-flight and later reconciles only by reading', async () => {
  const f = fixture(),
    original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (init.method === 'POST') f.admitted(false);
    return response;
  });
  const result = await f.writer.create(request);
  expect(result.status).toBe('uncertain');
  expect(f.posts()).toHaveLength(1);
  f.admitted(true);
  if (!('operationId' in result)) throw Error('fixture_missing_operation');
  expect((await f.writer.status(result.operationId)).status).toBe('verified');
  expect(f.posts()).toHaveLength(1);
});
it('rechecks the actual account after a grant generation changes', async () => {
  const f = fixture();
  await f.writer.create(request);
  f.change({ generation: 'fixture:2' });
  f.account('other@example.test');
  await expect(f.writer.create(request)).rejects.toThrow('mail_draft_wrong_account');
  expect(f.posts()).toHaveLength(1);
});
it('rejects an unrelated POST response identity without fetching another draft body', async () => {
  const f = fixture(),
    original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    return init.method === 'POST'
      ? new Response(JSON.stringify({ id: 'unrelated-draft', message: { id: 'ee05', threadId: 'ff06' } }))
      : response;
  });
  expect((await f.writer.create(request)).status).toBe('uncertain');
  expect(f.fetch.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/unrelated-draft'))).toBe(false);
  expect(f.posts()).toHaveLength(1);
});
it('does not recreate a draft that the owner has sent and removed from the drafts collection', async () => {
  const f = fixture(),
    result = await f.writer.create(request);
  if (!('operationId' in result)) throw Error('fixture_missing_operation');
  f.drafts.clear();
  f.source.alreadyAnswered = true;
  expect((await f.writer.status(result.operationId)).status).toBe('missing');
  expect((await f.writer.create(request)).status).toBe('missing');
  expect(f.posts()).toHaveLength(1);
});
