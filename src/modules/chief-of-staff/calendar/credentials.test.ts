import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarCredentialOwner } from './credentials.js';
import { CalendarAccessFences } from './access-fences.js';
import { GOOGLE_EVENT_READ_SCOPE } from './reader.js';
import type { GoogleCalendarTokens } from './oauth.js';
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const client = { clientId: 'fixture-client.apps.googleusercontent.com', clientSecret: 'FIXTURE_CLIENT_SECRET' };
const now = Date.parse('2026-10-01T00:00:00Z');
const tokens = (expired = false): GoogleCalendarTokens => ({
  accessToken: 'FIXTURE_ACCESS_TOKEN',
  refreshToken: 'FIXTURE_REFRESH_TOKEN',
  expiresAt: now + (expired ? -1 : 3600000),
  refreshExpiresAt: null,
  scopes: [GOOGLE_EVENT_READ_SCOPE],
});
const response = () =>
  new Response(
    JSON.stringify({
      access_token: 'ROTATED_ACCESS_TOKEN',
      refresh_token: 'ROTATED_REFRESH_TOKEN',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: GOOGLE_EVENT_READ_SCOPE,
    }),
  );
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-calendar-credentials-'));
  dirs.push(base);
  const root = path.join(base, 'credentials'),
    fenceRoot = path.join(base, 'fences');
  for (const dir of [root, fenceRoot]) fs.mkdirSync(dir, { mode: 0o700 });
  CalendarCredentialOwner.initialize(root);
  const fences = CalendarAccessFences.initialize(fenceRoot);
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => response());
  const transport = { fetch, now: () => now };
  const owner = new CalendarCredentialOwner(root, client, fences, transport),
    binding = randomUUID(),
    reference = randomUUID();
  return { base, root, fences, fetch, transport, owner, binding, reference };
}
describe('S03 host calendar credential owner', () => {
  it('persists selected credential fields privately and returns metadata without token material', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens());
    const reconstructed = new CalendarCredentialOwner(s.root, client, s.fences, s.transport);
    expect(await reconstructed.token('scope', s.binding, s.reference)).toBe('FIXTURE_ACCESS_TOKEN');
    expect(s.fetch).not.toHaveBeenCalled();
    expect(await reconstructed.inspect('scope', s.binding, s.reference)).toEqual({
      auth: 'ready',
      scopes: [GOOGLE_EVENT_READ_SCOPE],
      generation: 1,
    });
    const file = path.join(s.root, s.reference + '.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('FIXTURE_CLIENT_SECRET');
  });
  it('binds each reference to one scope, connector and OAuth client', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens());
    await expect(s.owner.token('foreign', s.binding, s.reference)).rejects.toThrow('calendar_credentials_denied');
    await expect(s.owner.token('scope', randomUUID(), s.reference)).rejects.toThrow('calendar_credentials_denied');
    const other = new CalendarCredentialOwner(
      s.root,
      { clientId: 'other.apps.googleusercontent.com' },
      s.fences,
      s.transport,
    );
    await expect(other.token('scope', s.binding, s.reference)).rejects.toThrow('calendar_credentials_denied');
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('rotates exactly once and persists the replacement before later access', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens(true));
    expect(await s.owner.token('scope', s.binding, s.reference)).toBe('ROTATED_ACCESS_TOKEN');
    const state = JSON.parse(fs.readFileSync(path.join(s.root, s.reference + '.json'), 'utf8'));
    expect(state.tokens.refreshToken).toBe('ROTATED_REFRESH_TOKEN');
    expect(state.phase).toBe('ready');
    expect(state.generation).toBe(2);
    expect(
      await new CalendarCredentialOwner(s.root, client, s.fences, s.transport).token('scope', s.binding, s.reference),
    ).toBe('ROTATED_ACCESS_TOKEN');
    expect(s.fetch).toHaveBeenCalledOnce();
  });
  it('coalesces concurrent requests to one refresh while preserving the scope boundary', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens(true));
    const results = await Promise.all([
      s.owner.token('scope', s.binding, s.reference),
      s.owner.token('scope', s.binding, s.reference),
    ]);
    expect(results).toEqual(['ROTATED_ACCESS_TOKEN', 'ROTATED_ACCESS_TOKEN']);
    expect(s.fetch).toHaveBeenCalledOnce();
  });
  it('uses the kernel lock to exclude a second credential owner during refresh', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens(true));
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.fetch.mockImplementation(async () => {
      entered();
      await wait;
      return response();
    });
    const first = s.owner.token('scope', s.binding, s.reference);
    await started;
    try {
      const other = new CalendarCredentialOwner(s.root, client, s.fences, s.transport);
      await expect(other.token('scope', s.binding, s.reference)).rejects.toThrow('calendar_credentials_busy');
      expect(() => s.fences.assertOpen('scope', s.binding)).not.toThrow();
    } finally {
      release();
    }
    expect(await first).toBe('ROTATED_ACCESS_TOKEN');
    expect(s.fetch).toHaveBeenCalledOnce();
  });
  it('fences an unfinished refresh journal after a process interruption without replay', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens(true));
    const file = path.join(s.root, s.reference + '.json'),
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...state, phase: 'refreshing' }));
    const reconstructed = new CalendarCredentialOwner(s.root, client, s.fences, s.transport);
    await expect(reconstructed.token('scope', s.binding, s.reference)).rejects.toThrow('calendar_auth_expired');
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('journals refresh before dispatch and refuses replay after reconstruction from an interrupted refresh', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens(true));
    s.fetch.mockImplementation(async () => {
      const state = JSON.parse(fs.readFileSync(path.join(s.root, s.reference + '.json'), 'utf8'));
      expect(state.phase).toBe('refreshing');
      throw new Error('PRIVATE_TRANSPORT_FAILURE');
    });
    await expect(s.owner.token('scope', s.binding, s.reference)).rejects.toThrow('calendar_oauth_exchange_uncertain');
    const reconstructed = new CalendarCredentialOwner(s.root, client, s.fences, s.transport);
    await expect(reconstructed.token('scope', s.binding, s.reference)).rejects.toThrow('calendar_auth_expired');
    expect(s.fetch).toHaveBeenCalledOnce();
    expect(() => s.fences.assertOpen('scope', s.binding)).toThrow('calendar_auth_expired');
  });
  it('does not release a refreshed access token if durable rotation publication fails', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens(true));
    s.fetch.mockImplementation(async () => {
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('PRIVATE_DISK_FAILURE');
      });
      return response();
    });
    await expect(s.owner.token('scope', s.binding, s.reference)).rejects.toThrow('calendar_credentials_unavailable');
    vi.restoreAllMocks();
    await expect(
      new CalendarCredentialOwner(s.root, client, s.fences, s.transport).token('scope', s.binding, s.reference),
    ).rejects.toThrow('calendar_auth_expired');
    expect(s.fetch).toHaveBeenCalledOnce();
  });
  it('finishes uncertain directory durability before releasing an already-renamed rotation', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens(true));
    const original = fs.fsyncSync;
    s.fetch.mockImplementation(async () => {
      vi.spyOn(fs, 'fsyncSync')
        .mockImplementationOnce(original)
        .mockImplementationOnce(() => {
          throw new Error('fixture_directory_sync_failure');
        });
      return response();
    });
    await expect(s.owner.token('scope', s.binding, s.reference)).rejects.toThrow('calendar_credentials_unavailable');
    vi.restoreAllMocks();
    const fsync = vi.spyOn(fs, 'fsyncSync');
    expect(await s.owner.token('scope', s.binding, s.reference)).toBe('ROTATED_ACCESS_TOKEN');
    expect(fsync).toHaveBeenCalledTimes(2);
    expect(s.fetch).toHaveBeenCalledOnce();
  });
  it('persists revocation outside PostgreSQL and prevents a refresh from reopening access', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens(true));
    s.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'PRIVATE_SERVER_TEXT' }), {
        status: 400,
      }),
    );
    await expect(s.owner.token('scope', s.binding, s.reference)).rejects.toThrow('calendar_auth_revoked');
    expect(() => s.fences.assertOpen('scope', s.binding)).toThrow('calendar_auth_revoked');
    await expect(s.owner.install('scope', s.binding, s.reference, tokens())).rejects.toThrow('calendar_auth_revoked');
    expect(s.fetch).toHaveBeenCalledOnce();
  });
  it('checks a concurrent local disconnect before releasing a completed refresh', async () => {
    const s = setup();
    await s.owner.install('scope', s.binding, s.reference, tokens(true));
    s.fetch.mockImplementation(async () => {
      s.fences.deny('scope', s.binding, 'disconnected');
      return response();
    });
    await expect(s.owner.token('scope', s.binding, s.reference)).rejects.toThrow('calendar_auth_disconnected');
  });
  it('refuses public files, symlinks, malformed references and unknown credential fields', async () => {
    const s = setup();
    await expect(
      s.owner.install('scope', s.binding, s.reference, {
        ...tokens(),
        databasePassword: 'PRIVATE_DATABASE_CANARY',
      } as GoogleCalendarTokens),
    ).rejects.toThrow('calendar_credentials_invalid');
    await s.owner.install('scope', s.binding, s.reference, tokens());
    const file = path.join(s.root, s.reference + '.json');
    fs.chmodSync(file, 0o644);
    await expect(s.owner.token('scope', s.binding, s.reference)).rejects.toThrow('calendar_credentials_unavailable');
    await expect(s.owner.token('scope', s.binding, '../escape')).rejects.toThrow('calendar_credentials_invalid');
  });
  it('never initializes a missing runtime store or adopts a repository or nonempty directory', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-calendar-unowned-'));
    dirs.push(base);
    fs.chmodSync(base, 0o700);
    expect(() => new CalendarCredentialOwner(base, client, {} as CalendarAccessFences)).toThrow(
      'calendar_credentials_unavailable',
    );
    fs.mkdirSync(path.join(base, '.git'));
    expect(() => CalendarCredentialOwner.initialize(base)).toThrow('calendar_credentials_unavailable');
  });
});
