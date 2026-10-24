import { expect, it, vi } from 'vitest';
import { googleMailReader } from '../mail/google-reader.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../mail/oauth.js';
const now = Date.parse('2026-10-23T00:00:00Z'),
  window = { capturedAt: now, since: now - 30 * 86400000 };
function fixture() {
  let message = {
    id: 'aa01',
    threadId: 'bb02',
    internalDate: String(now - 1000),
    labelIds: ['INBOX'],
    historyId: '123',
    payload: {
      headers: [
        { name: 'From', value: 'sender@example.test' },
        { name: 'To', value: 'owner@example.test' },
        { name: 'Subject', value: 'A subject' },
        { name: 'Message-ID', value: '<source@example.test>' },
      ],
    },
  };
  let members = [
    { id: message.id, threadId: message.threadId, internalDate: message.internalDate, labelIds: message.labelIds },
  ];
  let grant = {
    generation: 'binding:1',
    mailboxEmail: 'owner@example.test',
    scopes: [GOOGLE_MAIL_READ_SCOPE],
    auth: 'ready' as const,
  };
  const fetch = vi.fn(
    async (url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify(
          url.includes('/profile')
            ? { emailAddress: 'owner@example.test', historyId: '123' }
            : url.includes('/messages/')
              ? message
              : { id: 'bb02', historyId: '124', messages: members },
        ),
      ),
  );
  const reader = googleMailReader({
    access: async () => grant,
    token: async () => 'FIXTURE_PRIVATE_TOKEN',
    fetch,
    now: () => now,
  });
  return {
    reader,
    fetch,
    message: (patch: Partial<typeof message>) => {
      message = { ...message, ...patch };
    },
    members: (value: typeof members) => {
      members = value;
    },
    grant: (patch: Partial<typeof grant>) => {
      grant = { ...grant, ...patch };
    },
  };
}
it('reads only bounded source headers and thread labels/dates through the existing read-only grant', async () => {
  const f = fixture(),
    result = await f.reader.replySource('aa01', window);
  expect(result).toMatchObject({
    source: { id: 'aa01', threadId: 'bb02', mailboxEmail: 'owner@example.test' },
    internalDate: now - 1000,
    observedAt: now,
    historyId: '124',
    hasDraft: false,
    alreadyAnswered: false,
  });
  expect(f.fetch).toHaveBeenCalledTimes(3);
  expect(f.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  const source = new URL(f.fetch.mock.calls[1][0]),
    thread = new URL(f.fetch.mock.calls[2][0]);
  expect(source.searchParams.get('format')).toBe('metadata');
  expect(source.searchParams.getAll('metadataHeaders')).toEqual([
    'From',
    'To',
    'Reply-To',
    'Subject',
    'Message-ID',
    'References',
  ]);
  expect(source.searchParams.get('fields')).not.toContain('body');
  expect(thread.searchParams.get('fields')).toBe('id,historyId,messages(id,threadId,internalDate,labelIds)');
  expect(JSON.stringify(result)).not.toContain('TOKEN');
});
it.each([
  [['DRAFT'], now - 2000, true, false],
  [['SENT'], now - 500, false, true],
  [['SENT'], now - 2000, false, false],
] as const)(
  'detects existing drafts and later sent replies from metadata: %j',
  async (labels, date, hasDraft, alreadyAnswered) => {
    const f = fixture();
    f.members([
      { id: 'aa01', threadId: 'bb02', internalDate: String(now - 1000), labelIds: ['INBOX'] },
      { id: 'aa02', threadId: 'bb02', internalDate: String(date), labelIds: [...labels] },
    ]);
    expect(await f.reader.replySource('aa01', window)).toMatchObject({ hasDraft, alreadyAnswered });
  },
);
it.each([
  { labelIds: ['TRASH', 'INBOX'] },
  { labelIds: ['SPAM', 'SENT'] },
  { labelIds: ['DRAFT'] },
  { labelIds: ['ARCHIVE'] },
  { internalDate: String(window.since - 1) },
  { internalDate: String(now + 1) },
])('denies a source outside the selected current Inbox/Sent coverage: %j', async (patch) => {
  const f = fixture();
  f.message(patch);
  await expect(f.reader.replySource('aa01', window)).rejects.toThrow();
});
it('rejects changed/missing source members and incomplete or oversized thread inventories', async () => {
  const f = fixture();
  for (const members of [
    [],
    [{ id: 'aa01', threadId: 'bb02', internalDate: String(now - 1000), labelIds: ['TRASH'] }],
    Array.from({ length: 101 }, (_, i) => ({
      id: (i + 1).toString(16),
      threadId: 'bb02',
      internalDate: String(now - 1000),
      labelIds: ['INBOX'],
    })),
  ]) {
    f.members(members);
    await expect(f.reader.replySource('aa01', window)).rejects.toThrow();
  }
});
it('never fetches an injected provider path or accepts a writer token as source-reading authority', async () => {
  const f = fixture();
  await expect(f.reader.replySource('../send', window)).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
  f.grant({ scopes: ['https://www.googleapis.com/auth/gmail.compose'] });
  await expect(f.reader.replySource('aa01', window)).rejects.toThrow('mail_scope_denied');
  expect(f.fetch).not.toHaveBeenCalled();
});
