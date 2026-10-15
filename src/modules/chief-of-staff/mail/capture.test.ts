import { expect, it, vi } from 'vitest';
import { collectMail, MAIL_CAPTURE_TEXT_BYTES } from './capture.js';
import { normalizeMailMessage, MAIL_RETENTION_MS, type MailWindow } from './normalization.js';
import { MailReadError, type MailHistoryPage } from './reader.js';
import { mailEvidenceText } from './evidence.js';
import { extractChunks } from '../knowledge/text.js';
const now = Date.parse('2026-10-15T10:00:00Z'),
  mailboxEmail = 'owner@example.invalid';
const raw = (id: string, date = now - 1000, text = 'Fixture body') => ({
  id,
  threadId: 'bb01',
  historyId: '101',
  internalDate: String(date),
  labelIds: ['INBOX'],
  payload: { mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } },
});
function fixture(count = 1) {
  const data = new Map<string, ReturnType<typeof raw>>();
  for (let i = 1; i <= count; i++) {
    const id = i.toString(16);
    data.set(id, raw(id, now - i * 1000));
  }
  const profile = vi.fn(async () => ({ mailboxEmail, historyId: '100' }));
  const list = vi.fn(async (_window: MailWindow, page?: string) => {
    const rows = [...data.values()].sort((a, b) => Number(b.internalDate) - Number(a.internalDate)),
      offset = page ? Number(page) : 0;
    return {
      messages: rows.slice(offset, offset + 100).map((x) => ({ id: x.id, threadId: x.threadId })),
      resultSizeEstimate: rows.length,
      nextPageToken: offset + 100 < rows.length ? String(offset + 100) : null,
    };
  });
  const message = vi.fn(async (id: string, window: MailWindow) => {
    const found = data.get(id);
    if (!found) throw new MailReadError('mail_message_missing');
    return normalizeMailMessage(found, window);
  });
  const history = vi.fn(
    async (_start: string, _page?: string): Promise<MailHistoryPage> => ({
      changedIds: [],
      deletedIds: [],
      historyId: '200',
      nextPageToken: null,
    }),
  );
  const reader = {
    profile,
    list,
    message,
    history,
    thread: vi.fn(async () => ({ messages: [], excluded: 0, unsupported: 0 })),
  };
  const collect = (capturedAt = now, previous?: Awaited<ReturnType<typeof collectMail>>) =>
    collectMail({ reader, mailboxEmail, capturedAt, previous });
  return { data, reader, collect };
}
it('publishes a bounded full capture only after reconciling history since the initial profile watermark', async () => {
  const f = fixture(101),
    capture = await f.collect();
  expect(capture).toMatchObject({
    contract: 'cos-mail-capture/v1',
    mode: 'full',
    mailboxEmail,
    historyId: '200',
    complete: true,
    limitations: [],
    lastFullSyncAt: now,
  });
  expect(capture.messages).toHaveLength(101);
  expect(capture.messages[0].id).toBe('1');
  expect(capture.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.reader.list).toHaveBeenCalledTimes(2);
  expect(f.reader.history).toHaveBeenCalledWith('100', undefined);
});
it('uses unfiltered history to add, remove and refetch individual selected messages without rescanning', async () => {
  const f = fixture(2),
    first = await f.collect();
  f.data.set('3', raw('3', now + 1000));
  f.data.get('1')!.labelIds = ['TRASH'];
  f.reader.history.mockResolvedValue({
    changedIds: ['1', '3'],
    deletedIds: ['2'],
    historyId: '300',
    nextPageToken: null,
  });
  f.reader.list.mockClear();
  const second = await f.collect(now + 300000, first);
  expect(second.mode).toBe('incremental');
  expect(second.messages.map((m) => m.id)).toEqual(['3']);
  expect(second.removedIds).toEqual(['1', '2']);
  expect(second.historyId).toBe('300');
  expect(f.reader.list).not.toHaveBeenCalled();
  expect(first.messages.map((m) => m.id)).toEqual(['1', '2']);
});
it('reconciles a message arriving during the initial listing before advancing the published cursor', async () => {
  const f = fixture();
  f.reader.history.mockImplementation(async () => {
    f.data.set('2', raw('2', now - 1));
    return { changedIds: ['2'], deletedIds: [], historyId: '300', nextPageToken: null };
  });
  const capture = await f.collect();
  expect(capture.messages.map((m) => m.id)).toEqual(['2', '1']);
  expect(capture.historyId).toBe('300');
  expect(capture.complete).toBe(true);
});
it('retains post-boundary message IDs and fetches them next time even when history has no further changes', async () => {
  const f = fixture();
  let changed = true;
  f.reader.history.mockImplementation(async () => {
    if (changed) {
      f.data.set('2', raw('2', now + 1000));
      changed = false;
      return { changedIds: ['2'], deletedIds: [], historyId: '200', nextPageToken: null };
    }
    return { changedIds: [], deletedIds: [], historyId: '300', nextPageToken: null };
  });
  const first = await f.collect();
  expect(first.messages.map((m) => m.id)).toEqual(['1']);
  expect(first.deferred).toEqual([{ id: '2', until: now + 1000, seenAt: now }]);
  expect(first.complete).toBe(false);
  const second = await f.collect(now + 300000, first);
  expect(second.messages.map((m) => m.id)).toEqual(['2', '1']);
  expect(second.deferred).toEqual([]);
  expect(second.complete).toBe(true);
});
it('performs a bounded resync after expired history and removes formerly selected messages absent from it', async () => {
  const f = fixture(),
    first = await f.collect();
  f.data.delete('1');
  f.data.set('2', raw('2', now + 1000));
  f.reader.profile.mockResolvedValue({ mailboxEmail, historyId: '300' });
  f.reader.history.mockImplementation(async (start) => {
    if (start === '200') throw new MailReadError('mail_history_expired');
    return { changedIds: [], deletedIds: [], historyId: '400', nextPageToken: null };
  });
  const second = await f.collect(now + 300000, first);
  expect(second).toMatchObject({ mode: 'resync', historyId: '400', complete: true });
  expect(second.messages.map((m) => m.id)).toEqual(['2']);
  expect(second.removedIds).toEqual(['1']);
});
it('enforces rolling retention even when the provider reports no new changes', async () => {
  const f = fixture();
  f.data.set('1', raw('1', now - MAIL_RETENTION_MS + 1000));
  const first = await f.collect();
  const second = await f.collect(now + 300000, first);
  expect(second.messages).toEqual([]);
  expect(second.removedIds).toEqual(['1']);
  expect(second.complete).toBe(true);
});
it('reports a 1000-message selection limit rather than claiming complete coverage', async () => {
  const f = fixture(1005),
    capture = await f.collect();
  expect(capture.messages).toHaveLength(1000);
  expect(capture.limitations).toContain('message_limit');
  expect(capture.complete).toBe(false);
  expect(f.reader.message.mock.calls.length).toBeLessThanOrEqual(1000);
});
it('keeps the newest bounded normalized text and reports the 16 MiB limit explicitly', async () => {
  const f = fixture(257);
  for (const [id, m] of f.data) f.data.set(id, raw(id, Number(m.internalDate), 'x'.repeat(65536)));
  const capture = await f.collect();
  expect(capture.textBytes).toBeLessThanOrEqual(MAIL_CAPTURE_TEXT_BYTES);
  expect(capture.messages.length).toBeLessThan(257);
  expect(capture.messages[0].id).toBe('1');
  expect(capture.limitations).toContain('text_limit');
  expect(capture.complete).toBe(false);
});
it('reports an encoded checkpoint limit when escaping and citation chunks would outgrow the checkpoint reserve', async () => {
  const f = fixture(256);
  for (const [id, m] of f.data) f.data.set(id, raw(id, Number(m.internalDate), '\n'.repeat(65535) + 'x'));
  const capture = await f.collect();
  const wire = capture.messages.reduce(
    (n, message) =>
      n +
      Buffer.byteLength(
        JSON.stringify({
          message,
          chunks: extractChunks(
            mailEvidenceText(
              { id: 'a'.repeat(36), mailbox_email: mailboxEmail, processing_providers: ['codex'] },
              { message, selection_id: 'b'.repeat(36) },
            ),
          ),
        }),
      ),
    0,
  );
  expect(capture.limitations).toContain('checkpoint_limit');
  expect(capture.complete).toBe(false);
  expect(wire).toBeLessThan(48 * 1024 ** 2);
  expect(capture.messages[0].id).toBe('1');
}, 15000);
it('reports unsupported bodies separately and preserves incomplete coverage through later incremental captures', async () => {
  const f = fixture(2);
  f.data.set('2', raw('2', now - 2000, 'x'.repeat(65537)));
  const first = await f.collect();
  expect(first.messages.map((m) => m.id)).toEqual(['1']);
  expect(first.unsupported).toEqual([{ id: '2', reason: 'content_limit', seenAt: now }]);
  expect(first.complete).toBe(false);
  expect(first.limitations).toContain('unsupported_messages');
  const second = await f.collect(now + 300000, first);
  expect(second.unsupported).toEqual(first.unsupported);
  expect(second.complete).toBe(false);
});
it('leaves the prior capture and cursor unchanged when fetching a changed message fails', async () => {
  const f = fixture(),
    first = await f.collect(),
    bytes = JSON.stringify(first);
  f.reader.history.mockResolvedValue({ changedIds: ['2'], deletedIds: [], historyId: '300', nextPageToken: null });
  f.reader.message.mockRejectedValue(new MailReadError('mail_unavailable'));
  await expect(f.collect(now + 300000, first)).rejects.toThrow('mail_unavailable');
  expect(JSON.stringify(first)).toBe(bytes);
});
it('refuses another mailbox before fetching or reusing its capture', async () => {
  const f = fixture(),
    first = await f.collect();
  f.reader.list.mockClear();
  await expect(
    collectMail({ reader: f.reader, mailboxEmail: 'other@example.invalid', capturedAt: now + 300000, previous: first }),
  ).rejects.toThrow('mail_wrong_account');
  expect(f.reader.list).not.toHaveBeenCalled();
});
it('refuses cyclic list pagination and never returns an advanced capture', async () => {
  const f = fixture();
  f.reader.list.mockResolvedValue({
    messages: [{ id: '1', threadId: 'bb01' }],
    resultSizeEstimate: 3,
    nextPageToken: 'repeat',
  });
  await expect(f.collect()).rejects.toThrow('mail_invalid_response');
  expect(f.reader.list.mock.calls.length).toBeLessThanOrEqual(3);
});
it('refuses a modified previous capture before using its stored cursor', async () => {
  const f = fixture(),
    first = await f.collect();
  first.messages[0].text = 'MODIFIED_HOST_RECORD';
  f.reader.history.mockClear();
  await expect(f.collect(now + 300000, first)).rejects.toThrow('mail_capture_invalid');
  expect(f.reader.history).not.toHaveBeenCalled();
});
