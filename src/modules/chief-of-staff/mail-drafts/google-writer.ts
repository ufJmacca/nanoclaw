import type { DraftJournal, DraftEffect } from './journal.js';
import type { MailReplySourceReader } from './source.js';
import { digest } from '../domain/contracts.js';
import { checkedClient } from '../calendar/oauth-core.js';
import { contextGenerationPattern } from '../ops/conversation-ownership.js';
import { MAIL_RETENTION_MS } from '../mail/normalization.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
import { plainTextReply, verifySavedReply } from './reply.js';
export type MailDraftWriterAccess = {
  generation: string;
  scopeId: string;
  bindingId: string;
  contextGeneration: string;
  mailboxEmail: string;
  readerMailboxEmail: string;
  clientId: string;
  readerClientId: string;
  auth: 'ready' | 'expired' | 'revoked' | 'disconnected';
  scopes: string[];
  writeEnabled: boolean;
};
export type DraftCreateRequest = { requestId: string; sourceMessageId: string; text: string };
export type MailDraftEffectResult = {
  status: 'verified' | 'uncertain' | 'edited' | 'missing' | 'sent' | 'collision';
  operationId: string;
  existing?: boolean;
};
export type MailDraftResult = MailDraftEffectResult | { status: 'skipped'; reason: 'open_draft' | 'already_answered' };
export type MailDraftWriterOptions = {
  access(): Promise<MailDraftWriterAccess>;
  token(): Promise<string>;
  admitted(): boolean;
  sourceReader: MailReplySourceReader;
  journal: DraftJournal;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  signal?: AbortSignal;
};
export class MailDraftWriteError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const providerId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{1,128}$/.test(value);
const draftId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const printable = (value: unknown, max: number): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]+$/.test(value) && value.length <= max;
const email = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 254 &&
  /^[a-z0-9][a-z0-9._%+-]{0,127}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$/i.test(value);
const fail = (code: string): never => {
  throw new MailDraftWriteError(code);
};
const root = 'https://gmail.googleapis.com/gmail/v1/users/me';
type Session = { grant: MailDraftWriterAccess; token: string };
type Metadata = { id: string; messageId: string; threadId: string };
/** Fixed draft-only HTTP surface. One durable reservation can reach POST at most once; only reads may reconcile it. */
export function googleMailDraftWriter(options: MailDraftWriterOptions) {
  const fetch = options.fetch ?? globalThis.fetch,
    now = options.now ?? Date.now;
  let verifiedToken: string | null = null;
  const active = () => {
    if (options.signal?.aborted || options.admitted() !== true) fail('mail_draft_not_admitted');
  };
  const access = async (expected?: MailDraftWriterAccess): Promise<MailDraftWriterAccess> => {
    active();
    const grant = await options.access();
    active();
    if (
      !grant ||
      Object.keys(grant).sort().join(',') !==
        'auth,bindingId,clientId,contextGeneration,generation,mailboxEmail,readerClientId,readerMailboxEmail,scopeId,scopes,writeEnabled' ||
      !printable(grant.generation, 200) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(grant.scopeId) ||
      !contextGenerationPattern.test(grant.bindingId) ||
      !contextGenerationPattern.test(grant.contextGeneration) ||
      !email(grant.mailboxEmail) ||
      !email(grant.readerMailboxEmail) ||
      grant.mailboxEmail.toLowerCase() !== grant.readerMailboxEmail.toLowerCase() ||
      grant.auth !== 'ready' ||
      grant.writeEnabled !== true ||
      !Array.isArray(grant.scopes) ||
      grant.scopes.length !== 1 ||
      grant.scopes[0] !== GOOGLE_MAIL_DRAFT_SCOPE
    )
      return fail('mail_draft_binding_denied');
    checkedClient({ clientId: grant.clientId });
    checkedClient({ clientId: grant.readerClientId });
    if (grant.clientId === grant.readerClientId) return fail('mail_draft_separate_client_required');
    const captured = structuredClone(grant);
    if (expected && digest(captured) !== digest(expected)) return fail('mail_draft_access_changed');
    return captured;
  };
  const json = async (response: Response, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const maximum = 128 * 1024;
    if (Number(response.headers.get('content-length')) > maximum) return fail('mail_draft_response_too_large');
    const reader = response.body?.getReader();
    if (!reader) return fail('mail_draft_invalid_response');
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        active();
        if (signal.aborted) return fail('mail_draft_unavailable');
        const next = await reader.read();
        active();
        if (signal.aborted) return fail('mail_draft_unavailable');
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maximum) {
          cancel();
          return fail('mail_draft_response_too_large');
        }
        chunks.push(next.value);
      }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!object(value)) return fail('mail_draft_invalid_response');
      return value;
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  };
  const perform = async (
    session: Session,
    endpoint: string,
    params: Record<string, string>,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
  ): Promise<Record<string, unknown> | null> => {
    if (
      method === 'POST'
        ? endpoint !== '/drafts'
        : !['/profile', '/drafts'].includes(endpoint) && !/^\/drafts\/[a-zA-Z0-9_-]{1,256}$/.test(endpoint)
    )
      return fail('mail_draft_endpoint_denied');
    await access(session.grant);
    const url = new URL(root + endpoint);
    url.search = new URLSearchParams(params).toString();
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(10000)]);
    active();
    const response = await fetch(url.href, {
      method,
      redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + session.token,
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    let consumed = false;
    try {
      await access(session.grant);
      if (response.status === 404 && method === 'GET' && endpoint.startsWith('/drafts/')) return null;
      if (response.status !== 200) return fail('mail_draft_provider_unavailable');
      const result = await json(response, signal);
      consumed = true;
      await access(session.grant);
      return result;
    } finally {
      if (!consumed) await response.body?.cancel().catch(() => {});
    }
  };
  const prepare = async (): Promise<Session> => {
    const grant = await access(),
      token = await options.token();
    await access(grant);
    if (!printable(token, 8192)) return fail('mail_draft_credentials_unavailable');
    const session = { grant, token },
      identity = digest({ grant, token });
    if (verifiedToken !== identity) {
      const profile = await perform(session, '/profile', { fields: 'emailAddress' });
      if (
        !profile ||
        !email(profile.emailAddress) ||
        profile.emailAddress.toLowerCase() !== grant.mailboxEmail.toLowerCase()
      )
        return fail('mail_draft_wrong_account');
      verifiedToken = identity;
    }
    return session;
  };
  const inventory = async (session: Session, correlation?: string): Promise<Metadata[]> => {
    const result: Metadata[] = [],
      seen = new Set<string>(),
      ids = new Set<string>();
    let page: string | undefined;
    for (let index = 0; index < 5; index++) {
      const body = await perform(session, '/drafts', {
        maxResults: correlation ? '10' : '100',
        includeSpamTrash: 'false',
        fields: 'drafts(id,message(id,threadId)),nextPageToken,resultSizeEstimate',
        ...(correlation ? { q: 'rfc822msgid:<cos-draft-' + correlation + '@nanoclaw.invalid>' } : {}),
        ...(page ? { pageToken: page } : {}),
      });
      if (!body) return fail('mail_draft_invalid_response');
      const entries = body.drafts ?? [];
      if (
        !Array.isArray(entries) ||
        entries.length > (correlation ? 10 : 100) ||
        (body.resultSizeEstimate !== undefined &&
          (!Number.isSafeInteger(body.resultSizeEstimate) ||
            Number(body.resultSizeEstimate) < 0 ||
            Number(body.resultSizeEstimate) > (correlation ? 10 : 500)))
      )
        return fail('mail_draft_inventory_incomplete');
      for (const entry of entries) {
        if (
          !object(entry) ||
          !draftId(entry.id) ||
          !object(entry.message) ||
          !providerId(entry.message.id) ||
          !providerId(entry.message.threadId) ||
          ids.has(entry.id)
        )
          return fail('mail_draft_inventory_incomplete');
        ids.add(entry.id);
        result.push({ id: entry.id, messageId: entry.message.id, threadId: entry.message.threadId });
        if (result.length > (correlation ? 10 : 500)) return fail('mail_draft_inventory_incomplete');
      }
      if (body.nextPageToken === undefined) return result;
      if (!printable(body.nextPageToken, 2048) || seen.has(body.nextPageToken))
        return fail('mail_draft_inventory_incomplete');
      seen.add(body.nextPageToken);
      page = body.nextPageToken;
    }
    return fail('mail_draft_inventory_incomplete');
  };
  const outcome = (record: DraftEffect): MailDraftEffectResult => ({
    status: record.state === 'reserved' ? 'uncertain' : record.state,
    operationId: record.operationId,
  });
  const readCandidate = async (record: DraftEffect, id: string, session: Session): Promise<MailDraftEffectResult> => {
    if (!draftId(id)) return fail('mail_draft_invalid_response');
    const body = await perform(session, '/drafts/' + id, {
      format: record.state === 'edited' ? 'minimal' : 'full',
      fields:
        record.state === 'edited'
          ? 'id,message(id,threadId,labelIds)'
          : 'id,message(id,threadId,labelIds,payload(mimeType,filename,headers,body,parts))',
    });
    if (!body)
      return record.saved || (record.state === 'edited' && record.candidate)
        ? outcome(options.journal.observe(record.operationId, { state: 'missing' }, now()))
        : outcome(record);
    if (body.id !== id) return fail('mail_draft_invalid_response');
    if (record.state === 'edited') return outcome(record);
    const verified = verifySavedReply(body, {
      threadId: record.threadId,
      correlation: record.correlation,
      contentDigest: record.contentDigest,
    });
    if (
      !verified ||
      (record.candidate &&
        (verified.draftId !== record.candidate.draftId || verified.messageId !== record.candidate.messageId))
    )
      return outcome(options.journal.observe(record.operationId, { state: 'edited' }, now()));
    return outcome(
      options.journal.observe(
        record.operationId,
        { state: 'verified', ...verified, threadId: record.threadId, contentDigest: record.contentDigest },
        now(),
      ),
    );
  };
  const reconcile = async (record: DraftEffect, session: Session): Promise<MailDraftEffectResult> => {
    await access(session.grant);
    if (
      record.scopeId !== session.grant.scopeId ||
      record.mailboxDigest !== digest(session.grant.mailboxEmail.toLowerCase())
    )
      return fail('mail_draft_binding_denied');
    if (record.state === 'missing' || record.state === 'sent') return outcome(record);
    if (record.candidate) return readCandidate(record, record.candidate.draftId, session);
    if (record.state === 'collision') {
      const entries = await inventory(session);
      return entries.some((entry) => entry.threadId === record.threadId)
        ? outcome(record)
        : outcome(options.journal.observe(record.operationId, { state: 'missing' }, now()));
    }
    const entries = await inventory(session, record.correlation);
    if (entries.length === 0) return outcome(record);
    if (entries.length !== 1 || entries[0].threadId !== record.threadId)
      return outcome(options.journal.observe(record.operationId, { state: 'collision' }, now()));
    const tracked = options.journal.acknowledge(
      record.operationId,
      { draftId: entries[0].id, messageId: entries[0].messageId },
      now(),
    );
    return readCandidate(tracked, entries[0].id, session);
  };
  const window = () => {
    const capturedAt = now();
    if (!Number.isSafeInteger(capturedAt) || capturedAt <= MAIL_RETENTION_MS) return fail('mail_draft_clock_invalid');
    return { capturedAt, since: capturedAt - MAIL_RETENTION_MS };
  };
  return {
    async create(request: DraftCreateRequest): Promise<MailDraftResult> {
      let reserved: DraftEffect | null = null;
      try {
        if (
          !request ||
          Object.keys(request).sort().join(',') !== 'requestId,sourceMessageId,text' ||
          !contextGenerationPattern.test(request.requestId) ||
          !providerId(request.sourceMessageId) ||
          typeof request.text !== 'string' ||
          request.text.length > 16384 ||
          !request.text.trim()
        )
          return fail('mail_draft_request_invalid');
        const session = await prepare(),
          mailboxDigest = digest(session.grant.mailboxEmail.toLowerCase());
        const existing = options.journal.findSource(mailboxDigest, request.sourceMessageId);
        if (existing) return { ...(await reconcile(existing, session)), existing: true };
        const source = await options.sourceReader.replySource(request.sourceMessageId, window());
        await access(session.grant);
        if (
          source.source.id !== request.sourceMessageId ||
          source.source.mailboxEmail.toLowerCase() !== session.grant.mailboxEmail.toLowerCase()
        )
          return fail('mail_draft_source_denied');
        if (source.hasDraft || source.alreadyAnswered)
          return { status: 'skipped', reason: source.hasDraft ? 'open_draft' : 'already_answered' };
        const prepared = plainTextReply(source.source, request.text, '0'.repeat(64));
        const drafts = await inventory(session);
        if (drafts.some((draft) => draft.threadId === source.source.threadId))
          return { status: 'skipped', reason: 'open_draft' };
        const reservation = options.journal.reserve(
          {
            scopeId: session.grant.scopeId,
            bindingId: session.grant.bindingId,
            contextGeneration: session.grant.contextGeneration,
            mailboxDigest,
            sourceMessageId: request.sourceMessageId,
            threadId: source.source.threadId,
            requestId: request.requestId,
            contentDigest: prepared.contentDigest,
          },
          now(),
        );
        reserved = reservation.record;
        if (!reservation.created) return { ...(await reconcile(reserved, session)), existing: true };
        const latest = await options.sourceReader.replySource(request.sourceMessageId, window());
        await access(session.grant);
        if (
          latest.hasDraft ||
          latest.alreadyAnswered ||
          digest(latest.source) !== digest(source.source) ||
          latest.internalDate !== source.internalDate
        )
          return outcome(options.journal.observe(reserved.operationId, { state: 'collision' }, now()));
        const message = plainTextReply(source.source, request.text, reserved.correlation);
        if (
          message.contentDigest !== reserved.contentDigest ||
          options.journal.find(reserved.operationId)?.state !== 'reserved'
        )
          return fail('mail_draft_reservation_changed');
        const response = await perform(session, '/drafts', { fields: 'id,message(id,threadId)' }, 'POST', {
          message: { threadId: message.threadId, raw: message.raw },
        });
        if (
          !response ||
          !draftId(response.id) ||
          !object(response.message) ||
          !providerId(response.message.id) ||
          response.message.threadId !== reserved.threadId
        )
          return fail('mail_draft_invalid_response');
        reserved = options.journal.acknowledge(
          reserved.operationId,
          { draftId: response.id, messageId: response.message.id },
          now(),
        );
        return await readCandidate(reserved, response.id, session);
      } catch (error) {
        if (reserved) return { status: 'uncertain', operationId: reserved.operationId };
        if (error instanceof MailDraftWriteError) throw error;
        if (
          error instanceof Error &&
          [
            'mail_draft_daily_limit',
            'mail_draft_thread_reserved',
            'mail_draft_already_reserved',
            'mail_draft_clock_regressed',
            'mail_draft_journal_inventory_limit',
            'mail_draft_reply_invalid',
          ].includes(error.message)
        )
          return fail(error.message);
        return fail('mail_draft_unavailable');
      }
    },
    async status(operationId: string): Promise<MailDraftResult> {
      if (!hash(operationId)) return fail('mail_draft_request_invalid');
      try {
        const session = await prepare(),
          record = options.journal.find(operationId);
        if (!record) return fail('mail_draft_effect_missing');
        return await reconcile(record, session);
      } catch (error) {
        if (error instanceof MailDraftWriteError) throw error;
        return fail('mail_draft_unavailable');
      }
    },
  };
}
