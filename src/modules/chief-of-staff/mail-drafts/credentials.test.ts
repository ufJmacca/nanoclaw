import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { MailDraftCredentialOwner } from './credentials.js';
import { MailCredentialOwner } from '../mail/credentials.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { BackupQueue } from '../ops/backup-queue.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const now = Date.parse('2026-10-23T00:00:00Z'),
  client = { clientId: 'draft-fixture.apps.googleusercontent.com' };
const tokens = () => ({
  accessToken: 'FIXTURE_DRAFT_ACCESS',
  refreshToken: 'FIXTURE_DRAFT_REFRESH',
  expiresAt: now + 3600000,
  refreshExpiresAt: null,
  scopes: [GOOGLE_MAIL_DRAFT_SCOPE],
});
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-credentials-'));
  cleanup.push(base);
  for (const name of ['reader', 'writer', 'fences', 'queue']) fs.mkdirSync(base + '/' + name, { mode: 0o700 });
  MailCredentialOwner.initialize(base + '/reader');
  MailDraftCredentialOwner.initialize(base + '/writer');
  const fences = CalendarAccessFences.initialize(base + '/fences'),
    queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(base + '/queue'));
  const guard = vi.fn(),
    journal = async (change: Parameters<BackupQueue['recordCredential']>[0], check: () => void) => {
      await queue.recordCredential(change, check);
    };
  const owner = new MailDraftCredentialOwner(base + '/writer', client, fences, { now: () => now }, guard, journal);
  return { base, owner, fences, queue, guard, journal, binding: randomUUID(), reference: randomUUID() };
}
it('keeps a separate writer-owned marker and rejects adopting reader roots in either direction', () => {
  const f = fixture();
  expect(fs.readdirSync(f.base + '/writer')).toEqual(['.cos-mail-draft-writer-credentials']);
  expect(() => MailDraftCredentialOwner.initialize(f.base + '/reader')).toThrow();
  expect(() => MailCredentialOwner.initialize(f.base + '/writer')).toThrow();
});
it('journals the exact compose credential source before releasing a token', async () => {
  const f = fixture();
  await f.owner.install('scope', f.binding, f.reference, tokens());
  expect(await f.owner.inspect('scope', f.binding, f.reference)).toMatchObject({
    auth: 'ready',
    scopes: [GOOGLE_MAIL_DRAFT_SCOPE],
  });
  expect(await f.owner.token('scope', f.binding, f.reference)).toBe('FIXTURE_DRAFT_ACCESS');
  const pending = await f.queue.pending('credentials');
  expect(pending).toHaveLength(1);
  const event = JSON.parse(
    fs.readFileSync(f.base + '/queue/backup-queue/' + pending[0].operationId + '/data/credential-event.json', 'utf8'),
  );
  expect(event).toMatchObject({ sourceKind: 'mail_draft_writer', generation: 1, phase: 'ready' });
  expect(f.guard).toHaveBeenCalled();
});
it('never adopts a reader grant or reopens a revoked writer after a restored credential record', async () => {
  const f = fixture();
  await expect(
    f.owner.install('scope', f.binding, f.reference, {
      ...tokens(),
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    }),
  ).rejects.toThrow();
  await f.owner.install('scope', f.binding, f.reference, tokens());
  const file = f.base + '/writer/' + f.reference + '.json',
    original = fs.readFileSync(file);
  f.fences.deny('scope', f.binding, 'revoked');
  fs.writeFileSync(file, original, { mode: 0o600 });
  await expect(f.owner.token('scope', f.binding, f.reference)).rejects.toThrow();
});
it('serializes simultaneous status/create credential checks without dropping their durable journal', async () => {
  const f = fixture();
  await f.owner.install('scope', f.binding, f.reference, tokens());
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, async () => {
      await f.owner.inspect('scope', f.binding, f.reference);
      return f.owner.token('scope', f.binding, f.reference);
    }),
  );
  expect(results).toEqual(Array.from({ length: 4 }, () => ({ status: 'fulfilled', value: 'FIXTURE_DRAFT_ACCESS' })));
  expect(await f.queue.pending('credentials')).toHaveLength(1);
});
