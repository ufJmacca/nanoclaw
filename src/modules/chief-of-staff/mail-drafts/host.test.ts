import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import type { MailHostCredentials } from '../mail/config.js';
import type { MailDraftHostCredentials } from './config.js';
import { DraftJournal, initializeDraftJournal } from './journal.js';
import type { MailDraftHostProfile } from './profile.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../mail/oauth.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { createMailDraftHost } from './host.js';
import type { MailReviewAccess } from '../automation/mail-review-access.js';
const cleanup: string[] = [],
  hosts: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const now = Date.parse('2026-10-23T00:00:00Z'),
  context = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'session',
    ingressId: 'ingress',
    provider: 'codex',
    generation: '33333333-3333-4333-8333-333333333333',
  },
  readerId = '22222222-2222-4222-8222-222222222222',
  writerId = '44444444-4444-4444-8444-444444444444',
  readerRef = '55555555-5555-4555-8555-555555555555',
  writerRef = '66666666-6666-4666-8666-666666666666';
function saved(raw: string) {
  const [head, body] = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n');
  return {
    id: 'r-fixture',
    message: {
      id: 'dd04',
      threadId: 'bb01',
      labelIds: ['DRAFT'],
      payload: {
        mimeType: 'text/plain',
        headers: head
          .replace(/\r\n[ \t]+/g, ' ')
          .split('\r\n')
          .map((line) => {
            const i = line.indexOf(':');
            return { name: line.slice(0, i), value: line.slice(i + 1).trim() };
          }),
        body: { data: Buffer.from(body, 'base64').toString('base64url'), size: Buffer.from(body, 'base64').length },
      },
    },
  };
}
function resource(root: string, clientId: string, scope: string, token: string) {
  fs.mkdirSync(root, { mode: 0o700 });
  const held = CalendarAccessFences.initialize(root),
    fences = Object.assign(held, {
      assertOpen: vi.spyOn(held, 'assertOpen'),
      deny: vi.spyOn(held, 'deny'),
      runCheck: vi.spyOn(held, 'runCheck'),
    });
  const verifyStorage = vi.fn(),
    close = vi.fn(async () => {});
  return {
    clientId,
    verifyStorage,
    close,
    closed: () => false,
    fences,
    credentials: {
      inspect: vi.fn(async () => ({ auth: 'ready', scopes: [scope], generation: 1 })),
      token: vi.fn(async () => token),
    },
  };
}
function fixture(review = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-host-'));
  cleanup.push(root);
  const installation = digest('fixture installation'),
    owner = initializeDraftJournal(root + '/effects', installation),
    journal = new DraftJournal(root + '/effects', installation, owner.generation),
    reader = resource(
      root + '/reader-fences',
      'reader.apps.googleusercontent.com',
      GOOGLE_MAIL_READ_SCOPE,
      'FIXTURE_READER_TOKEN',
    ),
    writer = resource(
      root + '/writer-fences',
      'writer.apps.googleusercontent.com',
      GOOGLE_MAIL_DRAFT_SCOPE,
      'FIXTURE_WRITER_TOKEN',
    ),
    authority = {
      bindingDigest: digest('native'),
      contextGeneration: context.generation,
      draftProfileDigest: digest('cos-mail-draft/v1'),
      provider: { profile: 'subscription', model: 'fixture', policyDigest: digest('policy') },
    };
  const binding = {
    format: 'cos-mail-draft-binding/v1' as const,
    provider: 'google' as const,
    readerBindingId: readerId,
    mailboxDigest: digest('owner@example.test'),
    writerClientDigest: digest(writer.clientId),
    readerClientDigest: digest(reader.clientId),
    credentialReference: writerRef,
    nativeBindingDigest: authority.bindingDigest,
    journalGeneration: journal.generation,
    maxPerDay: 5 as const,
    timeZone: 'Australia/Sydney' as const,
    replyMode: 'plain_text_reply' as const,
    permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
    recoveryProofDigest: digest('fixture recovery only'),
  };
  const profile: MailDraftHostProfile = {
    format: 'cos-mail-draft-host/v1',
    installationDigest: installation,
    journalGeneration: journal.generation,
    grants: [
      {
        scopeId: context.scopeId,
        ownerId: context.ownerId,
        agentGroupId: context.agentGroupId,
        sessionId: context.sessionId,
        id: writerId,
        version: 1,
        backupOperationId: 'release-fixture',
        targetBackupDigest: digest('backup'),
        writeEnabled: true,
        binding,
      },
    ],
  };
  const selected = {
      id: writerId,
      version: 1,
      body: binding,
      digest: digest(binding),
      consent_ref: digest('consent'),
      reader_provider: 'google' as const,
      mailbox_email: 'owner@example.test',
      reader_scopes: [GOOGLE_MAIL_READ_SCOPE],
      reader_auth: 'ready',
      processing_providers: ['codex'],
      reader_credential_ref: readerRef,
    },
    source = {
      source_id: 'source',
      source_version: 1,
      revision_id: 'revision',
      revision_digest: digest('source'),
      thread_id: 'bb01',
      current_capture: 'capture',
      internal_date_ms: now - 1000,
    };
  let active = true,
    enabled = true,
    wrongThread = false,
    wrongDate = false,
    blockPost = false,
    savedDraft: ReturnType<typeof saved> | null = null;
  const assertProfile = vi.fn(),
    assertRecovery = vi.fn(),
    current = vi.fn(async () => active);
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/profile'))
      return new Response(JSON.stringify({ emailAddress: 'owner@example.test', historyId: '123' }));
    if (pathname.endsWith('/messages/aa01')) {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer FIXTURE_READER_TOKEN' });
      return new Response(
        JSON.stringify({
          id: 'aa01',
          threadId: wrongThread ? 'cc03' : 'bb01',
          historyId: '123',
          internalDate: String(now - (wrongDate ? 2000 : 1000)),
          labelIds: ['INBOX'],
          payload: {
            headers: [
              { name: 'From', value: 'sender@example.test' },
              { name: 'To', value: 'owner@example.test' },
              { name: 'Subject', value: 'Fixture' },
              { name: 'Message-ID', value: '<fixture@example.test>' },
            ],
          },
        }),
      );
    }
    if (pathname.includes('/threads/'))
      return new Response(
        JSON.stringify({
          id: wrongThread ? 'cc03' : 'bb01',
          historyId: '123',
          messages: [
            {
              id: 'aa01',
              threadId: wrongThread ? 'cc03' : 'bb01',
              internalDate: String(now - (wrongDate ? 2000 : 1000)),
              labelIds: ['INBOX'],
            },
          ],
        }),
      );
    expect(init.headers).toMatchObject({ Authorization: 'Bearer FIXTURE_WRITER_TOKEN' });
    if (init.method === 'POST') {
      if (blockPost)
        return await new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(Error('fixture aborted')), { once: true });
        });
      savedDraft = saved(JSON.parse(String(init.body)).message.raw);
      return new Response(JSON.stringify({ id: savedDraft.id, message: { id: 'dd04', threadId: 'bb01' } }));
    }
    if (pathname.endsWith('/drafts')) return new Response(JSON.stringify({ drafts: [] }));
    expect(pathname).toMatch(/\/drafts\/r-fixture$/);
    return new Response(JSON.stringify(savedDraft));
  });
  const reviewAccess: Pick<MailReviewAccess, 'check'> = { check: vi.fn(async () => null) };
  const host = createMailDraftHost({
    profile,
    journal,
    reader: reader as unknown as MailHostCredentials,
    writer: writer as unknown as MailDraftHostCredentials,
    authority: () => (active ? authority : null),
    review: review ? { authority: () => (active ? authority : null), access: reviewAccess } : undefined,
    enabled: () => enabled,
    assertProfile,
    assertRecovery,
    fetch,
    now: () => now,
  });
  hosts.push(host);
  const adapter = () => host.dependencies.writer(context, selected, current, source)!;
  return {
    host,
    adapter,
    reader,
    writer,
    profile,
    selected,
    source,
    current,
    fetch,
    assertProfile,
    assertRecovery,
    journal,
    reviewAccess,
    authority,
    root,
    installation,
    journalGeneration: owner.generation,
    active: (v: boolean) => {
      active = v;
    },
    enabled: (v: boolean) => {
      enabled = v;
    },
    wrongThread: () => {
      wrongThread = true;
    },
    wrongDate: () => {
      wrongDate = true;
    },
    blockPost: () => {
      blockPost = true;
    },
  };
}
const request = { requestId: '11111111-1111-4111-8111-111111111111', sourceMessageId: 'aa01', text: 'Fixture reply' };
it('requires explicit installed review identity and database fences for scheduled draft adapters', async () => {
  const runId = 'a'.repeat(64),
    ctx = { ...context, ingressId: `brief:${runId}:1`, origin: { kind: 'schedule' as const, runId, generation: 1 } };
  const ordinary = fixture();
  expect(ordinary.host.dependencies.authority(ctx)).toBeNull();
  expect(ordinary.host.dependencies.writer(ctx, ordinary.selected, ordinary.current, ordinary.source)).toBeNull();
  const f = fixture(true);
  expect(f.host.dependencies.reviewAccess).toBe(f.reviewAccess);
  expect(f.host.dependencies.matches(ctx, f.selected)).toBe(true);
  const adapter = f.host.dependencies.writer(ctx, f.selected, f.current, f.source)!;
  expect((await adapter.create(request)).status).toBe('verified');
  expect(f.current).toHaveBeenCalled();
});
it('scheduled host admission never bypasses the database run check or admits a specialist origin', async () => {
  const f = fixture(true),
    runId = 'a'.repeat(64),
    ctx = { ...context, ingressId: `brief:${runId}:1`, origin: { kind: 'schedule' as const, runId, generation: 1 } };
  const adapter = f.host.dependencies.writer(ctx, f.selected, async () => false, f.source)!;
  await expect(adapter.create(request)).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.reader.credentials.token).not.toHaveBeenCalled();
  expect(f.writer.credentials.token).not.toHaveBeenCalled();
  expect(
    f.host.dependencies.authority({
      ...context,
      origin: {
        kind: 'mission_review',
        runId: 'specialist',
        generation: 1,
        submissionId: 'submission',
        owner: 'specialist',
        fence: 1,
      },
    }),
  ).toBeNull();
});
it('uses separate held reader/writer credentials, current PG admission, both denial journals and verified readback', async () => {
  const f = fixture();
  expect(f.host.dependencies.matches(context, f.selected)).toBe(true);
  expect((await f.adapter().create(request)).status).toBe('verified');
  expect(f.reader.credentials.token).toHaveBeenCalledWith(context.scopeId, readerId, readerRef, expect.anything());
  expect(f.writer.credentials.token).toHaveBeenCalledWith(context.scopeId, writerId, writerRef, expect.anything());
  expect(f.reader.fences.runCheck).toHaveBeenCalled();
  expect(f.writer.fences.runCheck).toHaveBeenCalled();
  expect(f.current.mock.calls.length).toBeGreaterThan(10);
  expect(f.assertRecovery).toHaveBeenCalled();
  expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});
it.each([
  'native',
  'disabled',
  'profile',
  'recovery',
  'reader_storage',
  'writer_storage',
  'reader_denial',
  'writer_denial',
  'client',
  'foreign_owner',
])('closes draft admission after %s changes', async (boundary) => {
  const f = fixture();
  if (boundary === 'native') f.active(false);
  if (boundary === 'disabled') f.enabled(false);
  if (boundary === 'profile')
    f.assertProfile.mockImplementation(() => {
      throw Error('PRIVATE_PROFILE_FAILURE');
    });
  if (boundary === 'recovery')
    f.assertRecovery.mockImplementation(() => {
      throw Error('PRIVATE_RECOVERY_FAILURE');
    });
  if (boundary === 'reader_storage')
    f.reader.verifyStorage.mockImplementation(() => {
      throw Error('PRIVATE_STORAGE');
    });
  if (boundary === 'writer_storage')
    f.writer.verifyStorage.mockImplementation(() => {
      throw Error('PRIVATE_STORAGE');
    });
  if (boundary === 'reader_denial')
    f.reader.fences.assertOpen.mockImplementation(() => {
      throw Error('denied');
    });
  if (boundary === 'writer_denial')
    f.writer.fences.assertOpen.mockImplementation(() => {
      throw Error('denied');
    });
  if (boundary === 'client') f.selected.body.writerClientDigest = digest(f.reader.clientId);
  const ctx = boundary === 'foreign_owner' ? { ...context, ownerId: 'foreign' } : context;
  expect(f.host.dependencies.matches(ctx, f.selected)).toBe(false);
  expect(f.fetch).not.toHaveBeenCalled();
});
it.each(['wrongThread', 'wrongDate'] as const)(
  'denies fresh provider %s mismatches before reserving or writing',
  async (boundary) => {
    const f = fixture();
    f[boundary]();
    await expect(f.adapter().create(request)).rejects.toThrow();
    expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    expect(f.journal.findSource(f.selected.body.mailboxDigest, 'aa01')).toBeNull();
  },
);
it('pins a copy of the original native authority across an awaited credential operation', async () => {
  const f = fixture();
  f.writer.credentials.token.mockImplementationOnce(async () => {
    f.authority.provider.policyDigest = digest('replaced policy');
    return 'FIXTURE_WRITER_TOKEN';
  });
  await expect(f.adapter().create(request)).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
});
it('a busy writer check does not strand a pending check on the shared read-only profile', async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = f.writer.fences.runCheck(
      context.scopeId,
      writerId,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
  await ready;
  try {
    await expect(f.adapter().create(request)).rejects.toThrow();
  } finally {
    release();
    await hold;
  }
  expect(() => f.reader.fences.assertOpen(context.scopeId, readerId)).not.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
});
it('shutdown cancels an in-flight create, preserves its charged uncertainty, then releases only its own resources', async () => {
  const f = fixture();
  f.blockPost();
  const adapter = f.adapter(),
    pending = adapter.create(request);
  await vi.waitFor(() => expect(f.fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(true));
  const closed = f.host.close();
  expect((await pending).status).toBe('uncertain');
  await closed;
  const recoveredJournal = new DraftJournal(f.root + '/effects', f.installation, f.journalGeneration);
  try {
    expect(recoveredJournal.findSource(f.selected.body.mailboxDigest, 'aa01')?.state).toBe('reserved');
  } finally {
    recoveredJournal.close();
  }
  expect(f.writer.close).toHaveBeenCalledTimes(1);
  expect(f.reader.close).not.toHaveBeenCalled();
  expect(f.host.dependencies.matches(context, f.selected)).toBe(false);
  await expect(adapter.status('a'.repeat(64))).rejects.toThrow();
});
