import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { parseAdminArguments } from './admin.js';
import { parseCalendarSelection, runCalendarAccountAdmin } from './calendar-account-admin.js';
import { writeAtomic } from './target-state.js';
import type { CosBinding } from '../../../cos-boundary.js';
import { connectCosHostStore } from '../host-store.js';
import { CalendarStore } from '../calendar/store.js';
import type { PriorityStore } from '../store/priorities.js';
import { openCalendarCredentials } from '../calendar/config.js';
import { GOOGLE_EVENT_READ_SCOPE } from '../calendar/reader.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
vi.mock('../host-store.js', () => ({ connectCosHostStore: vi.fn() }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: vi.fn() }));
const dirs: string[] = [];
const inspect: StorageInspection = (command, args) =>
  JSON.stringify(
    command.endsWith('/findmnt')
      ? {
          filesystems: [
            {
              target: args[args.indexOf('--target') + 1],
              source: '/dev/mapper/fixture',
              fstype: 'ext4',
              'maj:min': '253:0',
              uuid: 'fixture-encrypted-storage',
            },
          ],
        }
      : {
          blockdevices: [
            { name: '/dev/mapper/fixture', type: 'crypt', 'maj:min': '253:0', uuid: 'fixture-encrypted-storage' },
          ],
        },
  );
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-calendar-account-'));
  dirs.push(base);
  const roots = { targetRoot: base + '/state', installationRoot: base + '/app', dataRoot: base + '/data' };
  const backupRoot = base + '/backups';
  for (const dir of [...Object.values(roots), backupRoot, roots.targetRoot + '/calendar'])
    fs.mkdirSync(dir, { mode: 0o700 });
  writeAtomic(roots.targetRoot + '/calendar', 'oauth-client.json', {
    clientId: 'fixture.apps.googleusercontent.com',
    clientSecret: 'CLIENT_SECRET_CANARY',
  });
  const options = {
    env: {},
    roots,
    binding: {
      scopeId: 'fixture',
      ownerId: 'owner',
      agentGroupId: 'group',
      sessionId: 'session',
      provider: 'codex',
    } as CosBinding,
    check: vi.fn(async () => {}),
    assertAuthority: vi.fn(),
  };
  const setup = { command: 'calendar-setup' as const, scopeId: 'fixture', requestId: randomUUID(), backupRoot };
  const selection = { calendarIds: ['selected'], timeZone: 'Australia/Sydney', processingProviders: ['codex'] };
  writeAtomic(roots.targetRoot, 'selection.json', selection);
  const link = {
    command: 'calendar-link' as const,
    scopeId: 'fixture',
    requestId: randomUUID(),
    bindingId: randomUUID(),
    manifestFile: roots.targetRoot + '/selection.json',
  };
  const end = vi.fn(async () => {});
  vi.mocked(connectCosHostStore).mockResolvedValue({ database: { pool: { end } } } as unknown as PriorityStore);
  vi.spyOn(CalendarStore.prototype, 'coverage').mockResolvedValue({ status: 'ok', items: [], next_offset: null });
  const bind = vi.spyOn(CalendarStore.prototype, 'bind').mockResolvedValue({ status: 'ok' });
  const provider = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('code_verifier=');
    return new Response(
      JSON.stringify({
        access_token: 'ACCESS_TOKEN_CANARY',
        refresh_token: 'REFRESH_TOKEN_CANARY',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: GOOGLE_EVENT_READ_SCOPE,
      }),
    );
  });
  const display = vi.fn(async (url: string) => {
    const authorization = new URL(url);
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_EVENT_READ_SCOPE);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'SYNTHETIC_CODE');
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('CANARY');
  });
  const dependencies = { inspect, display, fetch: provider };
  return { base, roots, backupRoot, options, setup, selection, link, bind, end, provider, display, dependencies };
}
it('requires explicit scoped setup/link commands with private selection manifests and stable IDs', () => {
  const id = randomUUID(),
    bindingId = randomUUID();
  expect(
    parseAdminArguments([
      'calendar-setup',
      '--scope',
      'fixture',
      '--request-id',
      id,
      '--backup-root',
      '/private/encrypted',
    ]),
  ).toEqual({ command: 'calendar-setup', scopeId: 'fixture', requestId: id, backupRoot: '/private/encrypted' });
  expect(
    parseAdminArguments([
      'calendar-link',
      '--scope',
      'fixture',
      '--request-id',
      id,
      '--binding',
      bindingId,
      '--manifest',
      '/private/selection.json',
    ]),
  ).toEqual({
    command: 'calendar-link',
    scopeId: 'fixture',
    requestId: id,
    bindingId,
    manifestFile: '/private/selection.json',
  });
  for (const args of [
    ['calendar-setup', '--scope', 'fixture', '--request-id', id, '--backup-root', '../backup'],
    [
      'calendar-link',
      '--scope',
      'fixture',
      '--request-id',
      id,
      '--binding',
      bindingId,
      '--manifest',
      '/private/selection.json',
      '--token',
      'SECRET',
    ],
    ['calendar-link', '--scope', 'fixture', '--request-id', id, '--binding', bindingId],
  ])
    expect(() => parseAdminArguments(args)).toThrow('invalid_admin_arguments');
  const selection = { calendarIds: ['selected'], timeZone: 'Australia/Sydney', processingProviders: ['codex'] };
  expect(parseCalendarSelection(selection)).toEqual(selection);
  for (const input of [
    null,
    { ...selection, calendarIds: [] },
    { ...selection, calendarIds: ['selected', 'selected'] },
    { ...selection, calendarIds: ['has space'] },
    { ...selection, timeZone: 'INVALID' },
    { ...selection, scopes: ['write'] },
    { ...selection, token: 'SECRET' },
    { ...selection, processingProviders: ['shell'] },
  ])
    expect(() => parseCalendarSelection(input)).toThrow('invalid_calendar_manifest');
});
it('initializes only verified protected storage, takes real backups and never overwrites client or journal ownership', async () => {
  const s = fixture();
  const result = await runCalendarAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  expect(result).toMatchObject({ status: 'configured_paused', paused: true, live_model: 'not_invoked' });
  expect(JSON.stringify(result)).not.toContain('CANARY');
  expect(s.provider).not.toHaveBeenCalled();
  expect(s.display).not.toHaveBeenCalled();
  expect(fs.readdirSync(s.backupRoot).filter((name) => name.startsWith('calendar-'))).toHaveLength(2);
  const owner = openCalendarCredentials(s.roots, inspect);
  owner.fences.deny('fixture', s.link.bindingId, 'revoked');
  await runCalendarAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  expect(() => openCalendarCredentials(s.roots, inspect).fences.assertOpen('fixture', s.link.bindingId)).toThrow(
    'calendar_auth_revoked',
  );
  fs.unlinkSync(s.roots.targetRoot + '/calendar/access-denials/.cos-calendar-fences');
  await expect(runCalendarAccountAdmin({ ...s.options, args: s.setup }, s.dependencies)).rejects.toThrow();
  expect(fs.existsSync(s.roots.targetRoot + '/calendar/access-denials/.cos-calendar-fences')).toBe(false);
});
it('does not initialize plaintext storage, repair a lost directory after setup, or replace the OAuth client', async () => {
  const s = fixture();
  const plaintext: StorageInspection = (command, args) => inspect(command, args).replace('"crypt"', '"part"');
  await expect(
    runCalendarAccountAdmin({ ...s.options, args: s.setup }, { ...s.dependencies, inspect: plaintext }),
  ).rejects.toThrow('calendar_storage_policy_unavailable');
  expect(fs.existsSync(s.roots.targetRoot + '/calendar/credentials')).toBe(false);
  await runCalendarAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  fs.rmSync(s.roots.targetRoot + '/calendar/credentials', { recursive: true });
  await expect(
    runCalendarAccountAdmin({ ...s.options, args: { ...s.setup, requestId: randomUUID() } }, s.dependencies),
  ).rejects.toThrow();
  expect(fs.existsSync(s.roots.targetRoot + '/calendar/credentials')).toBe(false);
  writeAtomic(s.roots.targetRoot + '/calendar', 'oauth-client.json', {
    clientId: 'different.apps.googleusercontent.com',
  });
  await expect(runCalendarAccountAdmin({ ...s.options, args: s.setup }, s.dependencies)).rejects.toThrow(
    'calendar_setup_conflict',
  );
});
it('links selected calendars through the real loopback exchange and retries database admission without repeating OAuth', async () => {
  const s = fixture();
  await runCalendarAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  s.bind.mockResolvedValueOnce({ status: 'pending' });
  expect(await runCalendarAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).toMatchObject({
    status: 'pending',
    binding_id: s.link.bindingId,
    paused: true,
  });
  const linked = await runCalendarAccountAdmin({ ...s.options, args: s.link }, s.dependencies);
  expect(linked).toMatchObject({ status: 'ok', binding_id: s.link.bindingId, paused: true, live_model: 'not_invoked' });
  expect(JSON.stringify(linked)).not.toMatch(/CANARY|credential/);
  expect(s.provider).toHaveBeenCalledOnce();
  expect(s.display).toHaveBeenCalledOnce();
  expect(s.end).toHaveBeenCalledTimes(2);
  expect(s.bind).toHaveBeenLastCalledWith(
    expect.objectContaining({ scopeId: 'fixture', ownerId: 'owner', provider: 'codex' }),
    {
      id: s.link.bindingId,
      provider: 'google',
      ...s.selection,
      credentialRef: s.link.bindingId,
      scopes: [GOOGLE_EVENT_READ_SCOPE],
    },
  );
  expect(
    await openCalendarCredentials(s.roots, inspect).credentials.inspect('fixture', s.link.bindingId, s.link.bindingId),
  ).toMatchObject({ auth: 'ready', generation: 1 });
  await expect(
    runCalendarAccountAdmin({ ...s.options, args: { ...s.link, requestId: randomUUID() } }, s.dependencies),
  ).rejects.toThrow('calendar_operation_conflict');
  writeAtomic(s.roots.targetRoot, 'selection.json', { ...s.selection, calendarIds: ['another'] });
  await expect(runCalendarAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).rejects.toThrow(
    'calendar_operation_conflict',
  );
  expect(s.provider).toHaveBeenCalledOnce();
});
it('does not retry an interrupted authorization attempt or reopen a disconnected binding', async () => {
  const s = fixture();
  await runCalendarAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  s.display.mockRejectedValueOnce(new Error('terminal_closed'));
  await expect(runCalendarAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).rejects.toThrow(
    'terminal_closed',
  );
  await expect(runCalendarAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).rejects.toThrow(
    'calendar_link_uncertain',
  );
  expect(s.display).toHaveBeenCalledOnce();
  expect(s.provider).not.toHaveBeenCalled();
  openCalendarCredentials(s.roots, inspect).fences.deny('fixture', s.link.bindingId, 'disconnected');
  await expect(runCalendarAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).rejects.toThrow(
    'calendar_auth_disconnected',
  );
  expect(s.bind).not.toHaveBeenCalled();
});
it('checks fresh authority before token exchange and never exposes a bound calendar after losing authority', async () => {
  const s = fixture();
  await runCalendarAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  s.provider.mockImplementation(async () => {
    s.options.check.mockRejectedValue(new Error('private_owner_membership_required'));
    return new Response(
      JSON.stringify({
        access_token: 'ACCESS_TOKEN_CANARY',
        refresh_token: 'REFRESH_TOKEN_CANARY',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: GOOGLE_EVENT_READ_SCOPE,
      }),
    );
  });
  await expect(runCalendarAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).rejects.toThrow(
    'private_owner_membership_required',
  );
  expect(s.bind).not.toHaveBeenCalled();
  expect(fs.existsSync(s.roots.targetRoot + '/calendar/credentials/' + s.link.bindingId + '.json')).toBe(false);
});
it('does not emit an authorization URL into redirected logs or start an OAuth attempt without an interactive terminal', async () => {
  const s = fixture();
  await runCalendarAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: false });
  try {
    await expect(
      runCalendarAccountAdmin({ ...s.options, args: s.link }, { inspect, fetch: s.provider }),
    ).rejects.toThrow('calendar_interactive_terminal_required');
    expect(s.provider).not.toHaveBeenCalled();
    expect(fs.existsSync(s.roots.targetRoot + '/calendar-admin/' + s.link.bindingId + '/authorization.json')).toBe(
      false,
    );
  } finally {
    if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor);
    else Reflect.deleteProperty(process.stderr, 'isTTY');
  }
});
