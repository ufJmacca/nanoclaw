import { MAIL_RETENTION_MS, mailHistoryId, type MailMessage, type MailWindow } from './normalization.js';
import type { MailReader } from './reader.js';
import { MailReadError } from './reader.js';
import { digest } from '../domain/contracts.js';
import { MAIL_CHECKPOINT_BYTES, mailCheckpointBytes } from './bounds.js';
export const MAIL_CAPTURE_MESSAGES = 1000,
  MAIL_CAPTURE_TEXT_BYTES = 16 * 1024 ** 2;
export type MailCaptureLimitation =
  | 'message_limit'
  | 'text_limit'
  | 'unsupported_messages'
  | 'deferred_messages'
  | 'selection_changed'
  | 'owner_denied'
  | 'retention_only'
  | 'access_unavailable'
  | 'checkpoint_limit'
  | 'provider_byte_limit';
export type MailCapture = {
  contract: 'cos-mail-capture/v1';
  mode: 'full' | 'incremental' | 'resync' | 'retention';
  mailboxEmail: string;
  historyId: string;
  window: MailWindow;
  lastFullSyncAt: number;
  messages: MailMessage[];
  deferred: Array<{ id: string; until: number; seenAt: number }>;
  unsupported: Array<{ id: string; reason: string; seenAt: number }>;
  limitations: MailCaptureLimitation[];
  complete: boolean;
  textBytes: number;
  removedIds: string[];
  digest: string;
};
const fail = (code: string): never => {
  throw new MailReadError(code);
};
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{1,128}$/.test(id);
const textBytes = (m: MailMessage) =>
  Buffer.byteLength(m.text) + Buffer.byteLength(m.subject) + Buffer.byteLength(m.from) + Buffer.byteLength(m.to);
const order = (a: MailMessage, b: MailMessage) => b.internalDate - a.internalDate || a.id.localeCompare(b.id);
/** Preparation only. The store must publish this complete result, its expected
 * binding/capture identity and cursor in one transaction; this routine writes nothing.
 */
export async function collectMail(options: {
  reader: MailReader;
  mailboxEmail: string;
  capturedAt: number;
  previous?: MailCapture;
}): Promise<MailCapture> {
  try {
    const { reader, capturedAt } = options,
      mailboxEmail = options.mailboxEmail.toLowerCase();
    if (!Number.isSafeInteger(capturedAt) || capturedAt <= MAIL_RETENTION_MS) return fail('mail_capture_invalid');
    const window = { capturedAt, since: capturedAt - MAIL_RETENTION_MS };
    const prior = options.previous ? structuredClone(options.previous) : undefined;
    if (prior) {
      if (prior.mailboxEmail !== mailboxEmail) return fail('mail_wrong_account');
      const { digest: stored, ...content } = prior;
      if (
        stored !== digest(content) ||
        prior.contract !== 'cos-mail-capture/v1' ||
        !mailHistoryId(prior.historyId) ||
        prior.window.capturedAt > capturedAt ||
        prior.messages.length > MAIL_CAPTURE_MESSAGES ||
        prior.textBytes > MAIL_CAPTURE_TEXT_BYTES ||
        prior.deferred.length > 1000 ||
        prior.unsupported.length > 1000
      )
        return fail('mail_capture_invalid');
      for (const m of prior.messages) {
        const { digest: stored, ...content } = m;
        if (stored !== digest(content)) return fail('mail_capture_invalid');
      }
    }
    const observed = await reader.profile();
    if (observed.mailboxEmail.toLowerCase() !== mailboxEmail) return fail('mail_wrong_account');
    if (!mailHistoryId(observed.historyId)) return fail('mail_invalid_response');
    const started = performance.now(),
      check = () => {
        if (performance.now() - started > 240000) fail('mail_capture_deadline');
      };
    let mode: MailCapture['mode'] = 'incremental',
      lastFullSyncAt = prior?.lastFullSyncAt ?? capturedAt,
      totalBytes = 0,
      totalCheckpointBytes = 0;
    const messages = new Map<string, { message: MailMessage; bytes: number; checkpointBytes: number }>(),
      deferred = new Map<string, MailCapture['deferred'][number]>(),
      unsupported = new Map<string, MailCapture['unsupported'][number]>(),
      limits = new Set<MailCaptureLimitation>();
    const remove = (id: string) => {
      const old = messages.get(id);
      if (old) {
        totalBytes -= old.bytes;
        totalCheckpointBytes -= old.checkpointBytes;
        messages.delete(id);
      }
    };
    const put = (message: MailMessage) => {
      if (
        !idValid(message.id) ||
        !mailHistoryId(message.historyId) ||
        message.trust !== 'untrusted_mail_evidence' ||
        message.internalDate < window.since ||
        message.internalDate > capturedAt
      )
        return fail('mail_invalid_response');
      remove(message.id);
      const bytes = textBytes(message),
        checkpointBytes = mailCheckpointBytes(message, mailboxEmail);
      messages.set(message.id, { message: structuredClone(message), bytes, checkpointBytes });
      totalBytes += bytes;
      totalCheckpointBytes += checkpointBytes;
      while (
        messages.size > MAIL_CAPTURE_MESSAGES ||
        totalBytes > MAIL_CAPTURE_TEXT_BYTES ||
        totalCheckpointBytes > MAIL_CHECKPOINT_BYTES
      ) {
        if (messages.size > MAIL_CAPTURE_MESSAGES) limits.add('message_limit');
        if (totalBytes > MAIL_CAPTURE_TEXT_BYTES) limits.add('text_limit');
        if (totalCheckpointBytes > MAIL_CHECKPOINT_BYTES) limits.add('checkpoint_limit');
        const oldest = [...messages.values()]
          .map((x) => x.message)
          .sort(order)
          .at(-1)!;
        remove(oldest.id);
      }
    };
    const trimMetadata = () => {
      for (const table of [deferred, unsupported])
        while (table.size > 1000) {
          limits.add('message_limit');
          const oldest = [...table.values()].sort((a, b) => a.seenAt - b.seenAt || a.id.localeCompare(b.id))[0];
          table.delete(oldest.id);
        }
    };
    for (const d of prior?.deferred ?? []) if (d.seenAt >= window.since) deferred.set(d.id, d);
    const readOne = async (id: string) => {
      check();
      if (!idValid(id)) return fail('mail_invalid_response');
      let result;
      try {
        result = await reader.message(id, window);
      } catch (error) {
        if (error instanceof MailReadError && error.code === 'mail_message_missing') {
          remove(id);
          deferred.delete(id);
          unsupported.delete(id);
          limits.add('selection_changed');
          return;
        }
        if (error instanceof MailReadError && error.code === 'mail_response_too_large') {
          remove(id);
          unsupported.set(id, { id, reason: 'response_too_large', seenAt: unsupported.get(id)?.seenAt ?? capturedAt });
          trimMetadata();
          return;
        }
        throw error;
      }
      check();
      if (result.status === 'selected') {
        if (result.message.id !== id) return fail('mail_invalid_response');
        put(result.message);
        deferred.delete(id);
        unsupported.delete(id);
      } else if (result.status === 'excluded') {
        remove(id);
        unsupported.delete(id);
        if (result.deferredUntil !== undefined) {
          if (!Number.isSafeInteger(result.deferredUntil) || result.deferredUntil <= capturedAt)
            return fail('mail_invalid_response');
          deferred.set(id, { id, until: result.deferredUntil, seenAt: deferred.get(id)?.seenAt ?? capturedAt });
        } else deferred.delete(id);
      } else {
        remove(id);
        deferred.delete(id);
        unsupported.set(id, { id, reason: result.reason, seenAt: unsupported.get(id)?.seenAt ?? capturedAt });
      }
      trimMetadata();
    };
    const readAll = async (ids: Iterable<string>) => {
      const unique = [...new Set(ids)];
      if (unique.length > 3000) return fail('mail_history_limit');
      for (let i = 0; i < unique.length; i += 4) {
        check();
        const batch = await Promise.allSettled(unique.slice(i, i + 4).map(readOne));
        const failed = batch.find((x): x is PromiseRejectedResult => x.status === 'rejected');
        if (failed) throw failed.reason;
      }
    };
    const history = async (start: string) => {
      let page: string | undefined,
        watermark = start;
      const seen = new Set<string>(),
        changed = new Set<string>(),
        deleted = new Set<string>();
      for (let index = 0; index < 20; index++) {
        check();
        const result = await reader.history(start, page);
        check();
        if (!mailHistoryId(result.historyId) || BigInt(result.historyId) < BigInt(watermark))
          return fail('mail_invalid_response');
        watermark = result.historyId;
        for (const id of result.changedIds) {
          if (!idValid(id)) return fail('mail_invalid_response');
          changed.add(id);
        }
        for (const id of result.deletedIds) {
          if (!idValid(id)) return fail('mail_invalid_response');
          deleted.add(id);
        }
        if (changed.size + deleted.size > 2000) return fail('mail_history_limit');
        if (result.nextPageToken === null) return { watermark, changed, deleted };
        if (seen.has(result.nextPageToken)) return fail('mail_invalid_response');
        seen.add(result.nextPageToken);
        page = result.nextPageToken;
      }
      return fail('mail_history_limit');
    };
    const full = async (anchor: string) => {
      messages.clear();
      unsupported.clear();
      limits.clear();
      totalBytes = 0;
      totalCheckpointBytes = 0;
      lastFullSyncAt = capturedAt;
      const selected = new Set<string>(),
        seen = new Set<string>();
      let page: string | undefined;
      for (let index = 0; index < 10; index++) {
        check();
        const result = await reader.list(window, page);
        check();
        if (!Array.isArray(result.messages) || result.messages.length > 100) return fail('mail_invalid_response');
        for (const row of result.messages) {
          if (!idValid(row.id)) return fail('mail_invalid_response');
          if (selected.size < MAIL_CAPTURE_MESSAGES) selected.add(row.id);
        }
        if (result.nextPageToken === null) {
          if (result.resultSizeEstimate > selected.size) limits.add('message_limit');
          break;
        }
        if (seen.has(result.nextPageToken)) return fail('mail_invalid_response');
        seen.add(result.nextPageToken);
        page = result.nextPageToken;
        if (index === 9) limits.add('message_limit');
      }
      await readAll(selected);
      return history(anchor);
    };
    const forcedFull =
      !prior ||
      capturedAt - prior.lastFullSyncAt >= 86400000 ||
      prior.limitations.some((x) =>
        [
          'message_limit',
          'text_limit',
          'selection_changed',
          'provider_byte_limit',
          'access_unavailable',
          'checkpoint_limit',
        ].includes(x),
      );
    let changes: Awaited<ReturnType<typeof history>>;
    if (forcedFull) {
      mode = 'full';
      changes = await full(observed.historyId);
    } else {
      for (const m of prior.messages) if (m.internalDate >= window.since) put(m);
      for (const u of prior.unsupported) if (u.seenAt >= window.since) unsupported.set(u.id, u);
      try {
        changes = await history(prior.historyId);
      } catch (error) {
        if (!(error instanceof MailReadError) || error.code !== 'mail_history_expired') throw error;
        mode = 'resync';
        changes = await full(observed.historyId);
      }
    }
    for (const id of changes.deleted) {
      remove(id);
      deferred.delete(id);
      unsupported.delete(id);
    }
    const reads = new Set([
      ...changes.changed,
      ...[...deferred.values()].filter((d) => d.until <= capturedAt).map((d) => d.id),
    ]);
    for (const id of changes.deleted) reads.delete(id);
    await readAll(reads);
    check();
    if (deferred.size) limits.add('deferred_messages');
    if (unsupported.size) limits.add('unsupported_messages');
    const resultMessages = [...messages.values()].map((x) => x.message).sort(order),
      present = new Set(resultMessages.map((m) => m.id));
    const content = {
      contract: 'cos-mail-capture/v1' as const,
      mode,
      mailboxEmail,
      historyId: changes.watermark,
      window,
      lastFullSyncAt,
      messages: resultMessages,
      deferred: [...deferred.values()].sort((a, b) => a.id.localeCompare(b.id)),
      unsupported: [...unsupported.values()].sort((a, b) => a.id.localeCompare(b.id)),
      limitations: [...limits].sort(),
      complete: limits.size === 0,
      textBytes: totalBytes,
      removedIds: (prior?.messages ?? [])
        .filter((m) => !present.has(m.id))
        .map((m) => m.id)
        .sort(),
    };
    return { ...content, digest: digest(content) };
  } catch (error) {
    if (error instanceof MailReadError) throw error;
    return fail('mail_unavailable');
  }
}
