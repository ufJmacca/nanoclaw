import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { MailCredentialOwner } from './credentials.js';
import { GOOGLE_MAIL_READ_SCOPE } from './oauth.js';
import { CalendarCredentialOwner } from '../calendar/credentials.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { BackupQueue } from '../ops/backup-queue.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
const now = Date.parse('2026-10-15T00:00:00Z'),
  client = { clientId: 'fixture-mail.apps.googleusercontent.com', clientSecret: 'FIXTURE_MAIL_CLIENT_SECRET' };
const tokens = (expired = false) => ({
  accessToken: 'FIXTURE_MAIL_ACCESS',
  refreshToken: 'FIXTURE_MAIL_REFRESH',
  expiresAt: now + (expired ? -1 : 3600000),
  refreshExpiresAt: null,
  scopes: [GOOGLE_MAIL_READ_SCOPE],
});
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mail-credentials-'));
  roots.push(base);
  for (const name of ['credentials', 'fences', 'queue']) fs.mkdirSync(path.join(base, name), { mode: 0o700 });
  const root = base + '/credentials';
  MailCredentialOwner.initialize(root);
  const fences = CalendarAccessFences.initialize(base + '/fences');
  const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(base + '/queue'));
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          access_token: 'ROTATED_MAIL_ACCESS',
          refresh_token: 'ROTATED_MAIL_REFRESH',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: GOOGLE_MAIL_READ_SCOPE,
        }),
      ),
  );
  const transport = { fetch, now: () => now },
    guard = vi.fn(() => {}),
    journal = async (change: Parameters<BackupQueue['recordCredential']>[0], check: () => void) => {
      await queue.recordCredential(change, check);
    };
  const owner = new MailCredentialOwner(root, client, fences, transport, guard, journal);
  return {
    base,
    root,
    fences,
    queue,
    fetch,
    transport,
    guard,
    journal,
    owner,
    binding: randomUUID(),
    reference: randomUUID(),
  };
}
function heldInspection(f: ReturnType<typeof fixture>) {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = new MailCredentialOwner(f.root, client, f.fences, f.transport, f.guard, async (change, check) => {
    entered();
    await held;
    await f.journal(change, check);
  });
  return { owner, started, release };
}
it('uses a mail-specific owned root and refuses adopting an existing Calendar credential root', () => {
  const f = fixture();
  expect(fs.readdirSync(f.root)).toEqual(['.cos-mail-reader-credentials']);
  expect(() => CalendarCredentialOwner.initialize(f.root)).toThrow();
  const other = f.base + '/calendar';
  fs.mkdirSync(other, { mode: 0o700 });
  CalendarCredentialOwner.initialize(other);
  const before = fs.readdirSync(other);
  expect(() => MailCredentialOwner.initialize(other)).toThrow();
  expect(fs.readdirSync(other)).toEqual(before);
});
it('records mail credentials in the real encrypted-queue interface before releasing an access token', async () => {
  const f = fixture();
  await f.owner.install('scope', f.binding, f.reference, tokens());
  expect(await f.owner.inspect('scope', f.binding, f.reference)).toMatchObject({
    auth: 'ready',
    scopes: [GOOGLE_MAIL_READ_SCOPE],
  });
  expect(await f.owner.token('scope', f.binding, f.reference)).toBe('FIXTURE_MAIL_ACCESS');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.guard).toHaveBeenCalled();
  const pending = await f.queue.pending('credentials');
  expect(pending).toHaveLength(1);
  const event = JSON.parse(
    fs.readFileSync(f.base + '/queue/backup-queue/' + pending[0].operationId + '/data/credential-event.json', 'utf8'),
  );
  expect(event).toMatchObject({ sourceKind: 'mail_reader', generation: 1, phase: 'ready' });
});
it('admits concurrent message credential checks through the real credential journal', async () => {
  const f = fixture();
  await f.owner.install('scope', f.binding, f.reference, tokens());
  const before = fs.readFileSync(f.root + '/' + f.reference + '.json');
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, async () => {
      const metadata = await f.owner.inspect('scope', f.binding, f.reference);
      const token = await f.owner.token('scope', f.binding, f.reference);
      return { metadata, token };
    }),
  );
  expect(results).toEqual(
    Array.from({ length: 4 }, () => ({
      status: 'fulfilled',
      value: {
        metadata: { auth: 'ready', scopes: [GOOGLE_MAIL_READ_SCOPE], generation: 1 },
        token: 'FIXTURE_MAIL_ACCESS',
      },
    })),
  );
  expect(fs.readFileSync(f.root + '/' + f.reference + '.json')).toEqual(before);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(await f.queue.pending('credentials')).toHaveLength(1);
});
it('checks a durable denial again before releasing a queued access token', async () => {
  const f = fixture();
  await f.owner.install('scope', f.binding, f.reference, tokens());
  const held = heldInspection(f),
    first = held.owner.inspect('scope', f.binding, f.reference);
  await held.started;
  const waiting = held.owner.token('scope', f.binding, f.reference);
  f.fences.deny('scope', f.binding, 'revoked');
  held.release();
  const results = await Promise.allSettled([first, waiting]);
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'calendar_auth_revoked' } });
  expect(f.fetch).not.toHaveBeenCalled();
});
it('keeps the exclusive file lock against a different credential owner', async () => {
  const f = fixture();
  await f.owner.install('scope', f.binding, f.reference, tokens());
  const held = heldInspection(f),
    first = held.owner.inspect('scope', f.binding, f.reference);
  await held.started;
  try {
    await expect(f.owner.token('scope', f.binding, f.reference)).rejects.toThrow('calendar_credentials_busy');
  } finally {
    held.release();
    await first;
  }
  expect(await f.owner.token('scope', f.binding, f.reference)).toBe('FIXTURE_MAIL_ACCESS');
});
it('cancels a queued token waiter without waiting for the held inspection or refreshing', async () => {
  const f = fixture();
  await f.owner.install('scope', f.binding, f.reference, tokens(true));
  const held = heldInspection(f),
    first = held.owner.inspect('scope', f.binding, f.reference);
  await held.started;
  const controller = new AbortController(),
    waiting = held.owner.token('scope', f.binding, f.reference, controller.signal);
  controller.abort();
  try {
    await expect(waiting).rejects.toThrow('calendar_refresh_timed_out');
    expect(f.fetch).not.toHaveBeenCalled();
  } finally {
    held.release();
    await first;
  }
  expect(await held.owner.inspect('scope', f.binding, f.reference)).toMatchObject({ auth: 'ready' });
  expect(f.fetch).not.toHaveBeenCalled();
});
it('returns a rejected promise for an already cancelled token request', async () => {
  const f = fixture();
  await f.owner.install('scope', f.binding, f.reference, tokens());
  await expect(f.owner.token('scope', f.binding, f.reference, AbortSignal.abort())).rejects.toThrow(
    'calendar_refresh_timed_out',
  );
  expect(f.fetch).not.toHaveBeenCalled();
});
it('does not import Calendar or broader mail tokens, or widen an existing Calendar grant', async () => {
  const f = fixture();
  for (const scope of [
    'https://www.googleapis.com/auth/calendar.events.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.compose',
  ])
    await expect(f.owner.install('scope', f.binding, f.reference, { ...tokens(), scopes: [scope] })).rejects.toThrow(
      'credentials_invalid',
    );
  expect(fs.readdirSync(f.root)).toEqual(['.cos-mail-reader-credentials']);
  expect(fs.readdirSync(f.base + '/queue')).toEqual([]);
});
it('serializes refresh, persists rotation and rebuilds without a second OAuth exchange', async () => {
  const f = fixture();
  await f.owner.install('scope', f.binding, f.reference, tokens(true));
  expect(
    await Promise.all([f.owner.token('scope', f.binding, f.reference), f.owner.token('scope', f.binding, f.reference)]),
  ).toEqual(['ROTATED_MAIL_ACCESS', 'ROTATED_MAIL_ACCESS']);
  expect(f.fetch).toHaveBeenCalledOnce();
  const rebuilt = new MailCredentialOwner(f.root, client, f.fences, f.transport, f.guard, f.journal);
  expect(await rebuilt.token('scope', f.binding, f.reference)).toBe('ROTATED_MAIL_ACCESS');
  expect(f.fetch).toHaveBeenCalledOnce();
  const stored = JSON.parse(fs.readFileSync(f.root + '/' + f.reference + '.json', 'utf8'));
  expect(stored).toMatchObject({
    contract: 'cos-mail-reader-credentials/v1',
    generation: 2,
    phase: 'ready',
    tokens: { refreshToken: 'ROTATED_MAIL_REFRESH' },
  });
  const events = await f.queue.pending('credentials');
  expect(events).toHaveLength(3);
});
it('refuses another client, binding or scope and obeys a durable access denial', async () => {
  const f = fixture();
  await f.owner.install('scope', f.binding, f.reference, tokens());
  const foreign = new MailCredentialOwner(
    f.root,
    { clientId: 'fixture-other.apps.googleusercontent.com' },
    f.fences,
    f.transport,
    f.guard,
    f.journal,
  );
  await expect(foreign.token('scope', f.binding, f.reference)).rejects.toThrow();
  await expect(f.owner.token('different-scope', f.binding, f.reference)).rejects.toThrow();
  await expect(f.owner.token('scope', randomUUID(), f.reference)).rejects.toThrow();
  f.fences.deny('scope', f.binding, 'revoked');
  await expect(f.owner.token('scope', f.binding, f.reference)).rejects.toThrow('revoked');
  expect(f.fetch).not.toHaveBeenCalled();
});
