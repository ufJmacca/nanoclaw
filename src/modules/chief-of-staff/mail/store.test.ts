import { expect, it } from 'vitest';
import { validMailCapture } from './store.js';
import { collectMail, type MailCapture } from './capture.js';
import { normalizeMailMessage } from './normalization.js';
import { digest } from '../domain/contracts.js';
async function fixture() {
  const capturedAt = Date.parse('2026-10-15T10:00:00Z');
  return collectMail({
    mailboxEmail: 'owner@example.invalid',
    capturedAt,
    reader: {
      profile: async () => ({ mailboxEmail: 'owner@example.invalid', historyId: '100' }),
      list: async () => ({ messages: [{ id: 'aa01', threadId: 'bb01' }], nextPageToken: null, resultSizeEstimate: 1 }),
      message: async (_id, window) =>
        normalizeMailMessage(
          {
            id: 'aa01',
            threadId: 'bb01',
            historyId: '101',
            internalDate: String(capturedAt - 1),
            labelIds: ['INBOX'],
            payload: { mimeType: 'text/plain', body: { data: Buffer.from('Fixture body').toString('base64url') } },
          },
          window,
        ),
      history: async () => ({ changedIds: [], deletedIds: [], historyId: '200', nextPageToken: null }),
      thread: async () => ({ messages: [], excluded: 0, unsupported: 0 }),
    },
  });
}
function rehash(c: MailCapture) {
  const m = c.messages[0],
    { digest: _messageDigest, ...message } = m;
  m.digest = digest(message);
  const { digest: _captureDigest, ...capture } = c;
  c.digest = digest(capture);
}
it('validates an actual bounded host capture', async () => {
  expect(validMailCapture(await fixture())).toBe(true);
});
it.each([
  'unknown-message-field',
  'invalid-label',
  'duplicate-label',
  'attachments-count',
  'header-control',
  'header-size',
  'text-control',
  'negative-full-sync',
  'duplicate-removals',
  'selected-and-removed',
  'unknown-window-field',
])('rejects a recomputed capture digest with malformed %s metadata', async (boundary) => {
  const c = await fixture(),
    m = c.messages[0];
  if (boundary === 'unknown-message-field') Object.assign(m, { unexpectedPrivateConfiguration: 'DO_NOT_PERSIST' });
  if (boundary === 'invalid-label') (m.labels as unknown[]).push(1);
  if (boundary === 'duplicate-label') m.labels.push('INBOX');
  if (boundary === 'attachments-count') m.attachmentsExcluded = -1;
  if (boundary === 'header-control') m.subject = 'bad\r\ninjected';
  if (boundary === 'header-size') m.subject = 'x'.repeat(16385);
  if (boundary === 'text-control') m.text = 'bad\u0000text';
  if (boundary === 'negative-full-sync') c.lastFullSyncAt = -1;
  if (boundary === 'duplicate-removals') c.removedIds = ['bb02', 'bb02'];
  if (boundary === 'selected-and-removed') c.removedIds = [m.id];
  if (boundary === 'unknown-window-field') Object.assign(c.window, { unrecognized: 'metadata' });
  c.textBytes =
    Buffer.byteLength(m.text) + Buffer.byteLength(m.subject) + Buffer.byteLength(m.from) + Buffer.byteLength(m.to);
  rehash(c);
  expect(validMailCapture(c)).toBe(false);
});
