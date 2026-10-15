import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { retainedMailCapture, suppressMailCapture } from './retention.js';
import { validMailCapture } from './store.js';
import { collectMail, type MailCapture } from './capture.js';
import { MAIL_RETENTION_MS, normalizeMailMessage, type MailWindow } from './normalization.js';
function fixture(): MailCapture {
  const at = Date.parse('2026-10-16T00:00:00Z'),
    content = {
      contract: 'cos-mail-capture/v1' as const,
      mode: 'full' as const,
      mailboxEmail: 'owner@example.invalid',
      historyId: '100',
      window: { capturedAt: at, since: at - MAIL_RETENTION_MS },
      lastFullSyncAt: at,
      messages: [],
      deferred: [{ id: 'aa01', until: at + 3600000, seenAt: at }],
      unsupported: [],
      limitations: ['deferred_messages' as const],
      complete: false,
      textBytes: 0,
      removedIds: [],
    };
  return { ...content, digest: digest(content) };
}
it('retains due deferred IDs through an outage so the next successful incremental read cannot lose them', async () => {
  const old = fixture(),
    before = structuredClone(old),
    now = old.window.capturedAt + 7200000,
    retained = retainedMailCapture(old, now, [], false);
  expect(validMailCapture(retained)).toBe(true);
  expect(retained.deferred).toEqual(old.deferred);
  expect(old).toEqual(before);
  expect(retained.historyId).toBe(old.historyId);
  expect(retained.lastFullSyncAt).toBe(old.lastFullSyncAt);
  const message = vi.fn(async (_id: string, window: MailWindow) =>
    normalizeMailMessage(
      {
        id: 'aa01',
        threadId: 'bb01',
        historyId: '101',
        internalDate: String(now - 1000),
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Deferred fixture mail.').toString('base64url') },
        },
      },
      window,
    ),
  );
  const result = await collectMail({
    mailboxEmail: old.mailboxEmail,
    capturedAt: now + 1,
    previous: retained,
    reader: {
      profile: async () => ({ mailboxEmail: old.mailboxEmail, historyId: '101' }),
      history: async () => ({ changedIds: [], deletedIds: [], historyId: '102', nextPageToken: null }),
      message,
      list: vi.fn().mockRejectedValue(Error('unexpected full sync')),
      thread: vi.fn(),
    },
  });
  expect(message).toHaveBeenCalledOnce();
  expect(result.messages.map((m) => m.id)).toEqual(['aa01']);
  expect(result.deferred).toEqual([]);
});
it('preserves a bodyless owner-denial hole on later filtering rather than incorrectly declaring a complete empty capture', () => {
  const old = fixture(),
    metadata = {
      ...old,
      deferred: [],
      unsupported: [{ id: 'aa01', reason: 'owner_denied', seenAt: old.window.capturedAt }],
      limitations: ['owner_denied', 'unsupported_messages'] as MailCapture['limitations'],
    };
  const { digest: _digest, ...content } = metadata,
    prepared = { ...content, digest: digest(content) },
    result = suppressMailCapture(prepared, ['aa01']);
  expect(result.unsupported).toEqual(prepared.unsupported);
  expect(result.complete).toBe(false);
  expect(result.limitations).toContain('owner_denied');
  expect(validMailCapture(result)).toBe(true);
});
it('requires a full provider resync after access loss removed locally cached mail', async () => {
  const old = fixture(),
    at = old.window.capturedAt + 60000,
    previous = retainedMailCapture(old, at, [], true),
    list = vi.fn(async () => ({ messages: [], resultSizeEstimate: 0, nextPageToken: null }));
  const result = await collectMail({
    mailboxEmail: old.mailboxEmail,
    capturedAt: at + 1,
    previous,
    reader: {
      profile: async () => ({ mailboxEmail: old.mailboxEmail, historyId: '101' }),
      history: async () => ({ changedIds: [], deletedIds: [], historyId: '102', nextPageToken: null }),
      message: vi.fn(),
      list,
      thread: vi.fn(),
    },
  });
  expect(list).toHaveBeenCalledOnce();
  expect(result.mode).toBe('full');
});
