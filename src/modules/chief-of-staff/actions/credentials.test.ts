import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import * as writerCredentials from './credentials.js';
import { CalendarCredentialOwner } from '../calendar/credentials.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { GOOGLE_EVENT_READ_SCOPE } from '../calendar/reader.js';
import { GOOGLE_CALENDAR_METADATA_SCOPE, GOOGLE_OWNED_EVENT_WRITE_SCOPE } from './writer.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const client = { clientId: 'fixture-writer.apps.googleusercontent.com' },
  now = Date.parse('2026-10-05T00:00:00Z'),
  scopes = [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-writer-vault-'));
  roots.push(root);
  const writerRoot = path.join(root, 'writer'),
    readerRoot = path.join(root, 'reader'),
    denials = path.join(root, 'denials');
  for (const directory of [writerRoot, readerRoot, denials]) fs.mkdirSync(directory, { mode: 0o700 });
  writerCredentials.CalendarWriterCredentialOwner.initialize(writerRoot);
  CalendarCredentialOwner.initialize(readerRoot);
  const fences = CalendarAccessFences.initialize(denials),
    fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: 'ROTATED_ACCESS',
            refresh_token: 'ROTATED_REFRESH',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: scopes.join(' '),
          }),
        ),
    ),
    transport = { fetch, now: () => now },
    writer = new writerCredentials.CalendarWriterCredentialOwner(writerRoot, client, fences, transport),
    reader = new CalendarCredentialOwner(readerRoot, client, fences, transport),
    binding = randomUUID(),
    reference = randomUUID();
  const tokens = {
    accessToken: 'FIXTURE_ACCESS',
    refreshToken: 'FIXTURE_REFRESH',
    expiresAt: now - 1,
    refreshExpiresAt: null,
    scopes,
  };
  return { root, writerRoot, readerRoot, fences, fetch, transport, writer, reader, binding, reference, tokens };
}
it('S09 stores writer credentials under a distinct owner marker and cannot open a reader vault', async () => {
  const f = setup();
  expect(() => new writerCredentials.CalendarWriterCredentialOwner(f.readerRoot, client, f.fences)).toThrow(
    'calendar_credentials_unavailable',
  );
  expect(() => new CalendarCredentialOwner(f.writerRoot, client, f.fences)).toThrow('calendar_credentials_unavailable');
  await expect(
    f.writer.install('scope', f.binding, f.reference, { ...f.tokens, scopes: [GOOGLE_EVENT_READ_SCOPE] }),
  ).rejects.toThrow('calendar_credentials_invalid');
  expect(f.fetch).not.toHaveBeenCalled();
});
it('S09 serializes and persists writer refresh while keeping the operator grant reference stable', async () => {
  const f = setup();
  await f.writer.install('scope', f.binding, f.reference, f.tokens);
  expect(await Promise.all(Array.from({ length: 5 }, () => f.writer.token('scope', f.binding, f.reference)))).toEqual(
    Array(5).fill('ROTATED_ACCESS'),
  );
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const restarted = new writerCredentials.CalendarWriterCredentialOwner(f.writerRoot, client, f.fences, f.transport),
    metadata = await restarted.inspect('scope', f.binding, f.reference);
  expect(metadata).toEqual({ auth: 'ready', scopes, generation: 2 });
  expect(JSON.stringify(metadata)).not.toContain('ROTATED_ACCESS');
  expect(await restarted.token('scope', f.binding, f.reference)).toBe('ROTATED_ACCESS');
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const stat = fs.statSync(path.join(f.writerRoot, f.reference + '.json'));
  expect(stat.mode & 0o777).toBe(0o600);
});
it('S09 unknown writer rotation persists uncertainty and never contacts the provider again after restart', async () => {
  const f = setup();
  await f.writer.install('scope', f.binding, f.reference, f.tokens);
  f.fetch.mockRejectedValue(new Error('PRIVATE_TOKEN_ENDPOINT'));
  await expect(f.writer.token('scope', f.binding, f.reference)).rejects.toThrow('calendar_oauth_exchange_uncertain');
  const restarted = new writerCredentials.CalendarWriterCredentialOwner(f.writerRoot, client, f.fences, f.transport);
  await expect(restarted.token('scope', f.binding, f.reference)).rejects.toThrow('calendar_auth_expired');
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fs.readFileSync(path.join(f.writerRoot, f.reference + '.json'), 'utf8')).phase).toBe('uncertain');
});
it('S09 denies a replaced vault root and mismatched binding without releasing a token', async () => {
  const f = setup();
  await f.writer.install('scope', f.binding, f.reference, { ...f.tokens, expiresAt: now + 3600000 });
  await expect(f.writer.token('scope', randomUUID(), f.reference)).rejects.toThrow('calendar_credentials_denied');
  fs.renameSync(f.writerRoot, f.writerRoot + '-old');
  fs.cpSync(f.writerRoot + '-old', f.writerRoot, { recursive: true });
  await expect(f.writer.token('scope', f.binding, f.reference)).rejects.toThrow('calendar_credentials_unavailable');
  expect(f.fetch).not.toHaveBeenCalled();
});
