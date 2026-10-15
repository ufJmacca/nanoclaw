import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { MailAccess, MailReader, MailPage, MailHistoryPage } from './reader.js';
import { MailReadError } from './reader.js';
import {
  normalizeMailMessage,
  mailHistoryId,
  MAIL_RETENTION_MS,
  type MailWindow,
  type MailMessage,
} from './normalization.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
import { digest } from '../domain/contracts.js';
export type GoogleMailReaderOptions = {
  access(): Promise<MailAccess>;
  token(): Promise<string>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const fail = (code: string): never => {
  throw new MailReadError(code);
};
const validId = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{1,128}$/.test(x);
const printable = (x: unknown, max: number): x is string =>
  typeof x === 'string' && x.length <= max && /^[\x21-\x7e]+$/.test(x);
const email = (x: unknown): x is string =>
  typeof x === 'string' && x.length <= 254 && /^[a-z0-9][a-z0-9._%+-]{0,127}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$/i.test(x);
const validWindow = (w: MailWindow) =>
  w &&
  Number.isSafeInteger(w.capturedAt) &&
  w.capturedAt > MAIL_RETENTION_MS &&
  w.since === w.capturedAt - MAIL_RETENTION_MS;
const pageToken = (x: unknown): string | null =>
  x === undefined ? null : printable(x, 2048) ? x : fail('mail_invalid_response');
const root = 'https://gmail.googleapis.com/gmail/v1/users/me';
type Kind = 'profile' | 'list' | 'message' | 'thread' | 'history';
/** Fixed GET endpoints only. A token's mailbox is independently checked before its
 * first content request, then bound to that exact grant and token in memory.
 */
export function googleMailReader(options: GoogleMailReaderOptions): MailReader {
  const fetch = options.fetch ?? globalThis.fetch,
    now = options.now ?? Date.now;
  let verifiedToken: string | null = null;
  const active = () => {
    if (options.signal?.aborted) fail('mail_cancelled');
  };
  const admit = async (expected?: MailAccess): Promise<MailAccess> => {
    active();
    const a = await options.access();
    active();
    if (
      !a ||
      !printable(a.generation, 200) ||
      !email(a.mailboxEmail) ||
      !['ready', 'expired', 'revoked', 'disconnected'].includes(a.auth)
    )
      return fail('mail_binding_denied');
    if (a.auth !== 'ready') return fail('mail_auth_' + a.auth);
    if (!Array.isArray(a.scopes) || a.scopes.length !== 1 || a.scopes[0] !== GOOGLE_MAIL_READ_SCOPE)
      return fail('mail_scope_denied');
    const result = structuredClone(a);
    if (expected && digest(result) !== digest(expected)) return fail('mail_access_changed');
    return result;
  };
  const json = async (response: Response, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const check = () => {
      active();
      if (signal.aborted) fail('mail_unavailable');
    };
    check();
    const maximum = 4 * 1024 ** 2;
    if (Number(response.headers.get('content-length')) > maximum) {
      void response.body?.cancel().catch(() => {});
      return fail('mail_response_too_large');
    }
    const reader = response.body?.getReader();
    if (!reader) return fail('mail_invalid_response');
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        check();
        const next = await reader.read();
        check();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maximum) {
          cancel();
          return fail('mail_response_too_large');
        }
        chunks.push(next.value);
      }
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!object(body)) return fail('mail_invalid_response');
      return body;
    } catch (error) {
      if (error instanceof MailReadError) throw error;
      return fail('mail_invalid_response');
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  };
  const perform = async (
    url: URL,
    kind: Kind,
    grant: MailAccess,
    token: string,
    deadline: number,
  ): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await admit(grant);
      const remaining = deadline - now();
      if (remaining <= 0) return fail('mail_unavailable');
      const signal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(Math.max(1, Math.min(10000, remaining))),
      ]);
      const response = await fetch(url.href, {
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Cache-Control': 'no-store' },
        signal,
      });
      if (response.status === 401 || response.status === 404 || response.status === 410) {
        void response.body?.cancel().catch(() => {});
        return fail(
          response.status === 401
            ? 'mail_auth_revoked'
            : kind === 'history'
              ? 'mail_history_expired'
              : kind === 'message'
                ? 'mail_message_missing'
                : 'mail_unavailable',
        );
      }
      await admit(grant);
      let body: Record<string, unknown> | undefined;
      if (response.status === 403) {
        try {
          body = await json(response, signal);
        } catch (error) {
          if (error instanceof MailReadError) return fail('mail_auth_revoked');
          throw error;
        }
      }
      const providerError = body && object(body.error) ? body.error : null;
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          providerError &&
          Array.isArray(providerError.errors) &&
          providerError.errors.some(
            (e) => object(e) && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(String(e.reason)),
          ));
      if (limited || [500, 502, 503, 504].includes(response.status)) {
        if (!body) void response.body?.cancel().catch(() => {});
        const code = limited ? 'mail_rate_limited' : 'mail_unavailable';
        if (attempt === 2) return fail(code);
        const retry = response.headers.get('retry-after');
        const hint = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - now() : 0;
        const wait = Math.max(500 * 2 ** attempt, Number.isFinite(hint) ? hint : 0);
        if (wait > 5000 || now() + wait >= deadline) return fail(code);
        if (options.sleep) await options.sleep(wait);
        else await delay(wait, undefined, { signal: options.signal });
        active();
        continue;
      }
      if (response.status === 403) return fail('mail_auth_revoked');
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return fail('mail_unavailable');
      }
      const result = body ?? (await json(response, signal));
      await admit(grant);
      return result;
    }
    return fail('mail_unavailable');
  };
  const profileUrl = () => {
    const url = new URL(root + '/profile');
    url.searchParams.set('fields', 'emailAddress,historyId');
    return url;
  };
  const profile = (body: Record<string, unknown>, grant: MailAccess) => {
    if (!email(body.emailAddress) || !mailHistoryId(body.historyId)) return fail('mail_invalid_response');
    if (body.emailAddress.toLowerCase() !== grant.mailboxEmail.toLowerCase()) return fail('mail_wrong_account');
    return { mailboxEmail: body.emailAddress.toLowerCase(), historyId: body.historyId };
  };
  const request = async (url: URL, kind: Kind): Promise<Record<string, unknown>> => {
    try {
      const grant = await admit(),
        deadline = now() + 30000;
      if (!Number.isFinite(deadline)) return fail('mail_unavailable');
      const token = await options.token();
      await admit(grant);
      if (!printable(token, 8192)) return fail('mail_auth_expired');
      const identity = createHash('sha256').update(digest(grant)).update('\0').update(token).digest('hex');
      if (kind !== 'profile' && verifiedToken !== identity) {
        profile(await perform(profileUrl(), 'profile', grant, token, deadline), grant);
        verifiedToken = identity;
      }
      const body = await perform(url, kind, grant, token, deadline);
      if (kind === 'profile') {
        profile(body, grant);
        verifiedToken = identity;
      }
      return body;
    } catch (error) {
      if (error instanceof MailReadError) throw error;
      active();
      return fail('mail_unavailable');
    }
  };
  const queryToken = (url: URL, token?: string) => {
    if (token !== undefined) {
      if (!printable(token, 2048)) fail('mail_request_invalid');
      url.searchParams.set('pageToken', token);
    }
  };
  return {
    async profile() {
      const body = await request(profileUrl(), 'profile');
      return { mailboxEmail: String(body.emailAddress).toLowerCase(), historyId: String(body.historyId) };
    },
    async list(window, page) {
      if (!validWindow(window)) return fail('mail_request_invalid');
      const url = new URL(root + '/messages');
      url.searchParams.set('maxResults', '100');
      url.searchParams.set('includeSpamTrash', 'false');
      url.searchParams.set('fields', 'messages(id,threadId),nextPageToken,resultSizeEstimate');
      url.searchParams.set(
        'q',
        `after:${Math.floor(window.since / 1000)} before:${Math.floor(window.capturedAt / 1000) + 1} {in:inbox in:sent} -in:spam -in:trash -in:drafts`,
      );
      queryToken(url, page);
      const body = await request(url, 'list');
      const messages = body.messages ?? [];
      if (
        !Array.isArray(messages) ||
        messages.length > 100 ||
        messages.some((m) => !object(m) || !validId(m.id) || !validId(m.threadId)) ||
        !Number.isSafeInteger(body.resultSizeEstimate) ||
        Number(body.resultSizeEstimate) < 0
      )
        return fail('mail_invalid_response');
      return {
        messages: messages.map((m) => ({ id: m.id, threadId: m.threadId })),
        nextPageToken: pageToken(body.nextPageToken),
        resultSizeEstimate: body.resultSizeEstimate,
      } as MailPage;
    },
    async message(id, window) {
      if (!validId(id) || !validWindow(window)) return fail('mail_request_invalid');
      const url = new URL(root + '/messages/' + id);
      url.searchParams.set('format', 'full');
      const body = await request(url, 'message');
      if (body.id !== id) return fail('mail_invalid_response');
      return normalizeMailMessage(body, window);
    },
    async thread(id, window) {
      if (!validId(id) || !validWindow(window)) return fail('mail_request_invalid');
      const url = new URL(root + '/threads/' + id);
      url.searchParams.set('format', 'full');
      const body = await request(url, 'thread');
      if (body.id !== id || !Array.isArray(body.messages) || body.messages.length > 100)
        return fail('mail_invalid_response');
      const messages: MailMessage[] = [];
      let excluded = 0,
        unsupported = 0;
      for (const raw of body.messages) {
        if (!object(raw) || raw.threadId !== id) return fail('mail_invalid_response');
        const result = normalizeMailMessage(raw, window);
        if (result.status === 'selected') messages.push(result.message);
        else if (result.status === 'excluded') excluded++;
        else unsupported++;
      }
      return { messages, excluded, unsupported };
    },
    async history(start, page) {
      if (!mailHistoryId(start)) return fail('mail_request_invalid');
      const url = new URL(root + '/history');
      url.searchParams.set('startHistoryId', start);
      url.searchParams.set('maxResults', '100');
      queryToken(url, page);
      const body = await request(url, 'history');
      if (!mailHistoryId(body.historyId) || BigInt(body.historyId) < BigInt(start))
        return fail('mail_invalid_response');
      const rows = body.history ?? [];
      if (!Array.isArray(rows) || rows.length > 100) return fail('mail_invalid_response');
      const changed = new Set<string>(),
        deleted = new Set<string>();
      const collect = (values: unknown, target: Set<string>, wrapped: boolean) => {
        if (values === undefined) return;
        if (!Array.isArray(values) || values.length > 2000) return fail('mail_invalid_response');
        for (const row of values) {
          const message = wrapped && object(row) ? row.message : row;
          if (!object(message) || !validId(message.id)) return fail('mail_invalid_response');
          target.add(message.id);
          if (changed.size + deleted.size > 2000) return fail('mail_response_too_large');
        }
      };
      for (const row of rows) {
        if (
          !object(row) ||
          !mailHistoryId(row.id) ||
          BigInt(row.id) <= BigInt(start) ||
          BigInt(row.id) > BigInt(body.historyId)
        )
          return fail('mail_invalid_response');
        collect(row.messages, changed, false);
        for (const key of ['messagesAdded', 'labelsAdded', 'labelsRemoved']) collect(row[key], changed, true);
        collect(row.messagesDeleted, deleted, true);
      }
      return {
        changedIds: [...changed].filter((id) => !deleted.has(id)).sort(),
        deletedIds: [...deleted].sort(),
        historyId: body.historyId,
        nextPageToken: pageToken(body.nextPageToken),
      } as MailHistoryPage;
    },
  };
}
