import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { parseAdminArguments, safeAdminError } from './admin.js';
import { parseCalendarSync, runCalendarAdmin } from './calendar-admin.js';
import type { CosBinding } from '../../../cos-boundary.js';
import { writeAtomic } from './target-state.js';
import { connectCosHostStore } from '../host-store.js';
import { openCalendarCredentials, openCalendarFences } from '../calendar/config.js';
import { CalendarStore } from '../calendar/store.js';
import { CalendarConnector } from '../calendar/connector.js';
import { backupCalendarState } from '../calendar/backup.js';
import type { PriorityStore } from '../store/priorities.js';
vi.mock('../host-store.js', () => ({ connectCosHostStore: vi.fn() }));
vi.mock('../knowledge/config.js', () => ({ openKnowledgeArtifacts: vi.fn() }));
vi.mock('../calendar/config.js', async () => ({
  ...(await vi.importActual('../calendar/config.js')),
  openCalendarFences: vi.fn(),
  openCalendarCredentials: vi.fn(),
}));
vi.mock('../calendar/backup.js', () => ({ backupCalendarState: vi.fn() }));
const bindingId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const window = { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-10T00:00:00Z', timeZone: 'Australia/Sydney' };
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-calendar-admin-'));
  directories.push(root);
  const end = vi.fn(async () => {});
  vi.mocked(connectCosHostStore).mockResolvedValue({ database: { pool: { end } } } as unknown as PriorityStore);
  const fences = { assertOpen: vi.fn(), deny: vi.fn(), runCheck: vi.fn() };
  vi.mocked(openCalendarFences).mockReturnValue(fences as unknown as ReturnType<typeof openCalendarFences>);
  vi.mocked(openCalendarCredentials).mockReturnValue({ fences, credentials: {} } as unknown as ReturnType<
    typeof openCalendarCredentials
  >);
  vi.mocked(backupCalendarState).mockResolvedValue({ present: true } as never);
  const connection = vi.spyOn(CalendarStore.prototype, 'connection').mockResolvedValue({
    status: 'ok',
    binding: {
      id: bindingId,
      provider: 'google',
      calendarIds: ['selected'],
      scopes: ['read'],
      credentialRef: 'SECRET_REF',
      timeZone: window.timeZone,
      processingProviders: ['codex'],
      version: 1,
      auth: 'ready',
    },
  });
  const refresh = vi.spyOn(CalendarConnector.prototype, 'refresh').mockResolvedValue({
    result: { status: 'ok', snapshot_id: requestId },
  });
  const disconnect = vi.spyOn(CalendarConnector.prototype, 'disconnect').mockResolvedValue({ status: 'ok' });
  const coverage = vi.spyOn(CalendarStore.prototype, 'coverage').mockResolvedValue({
    status: 'ok',
    items: [{ binding_id: bindingId, calendar_id: 'selected', auth: 'ready', last_success_at: null }],
    next_offset: null,
  });
  const options = {
    env: { COS_CALENDAR_ENABLED: 'true' },
    roots: { targetRoot: root, installationRoot: root + '-app', dataRoot: root + '-data' },
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
  writeAtomic(root, 'sync.json', { calendarId: 'selected', window });
  const args = {
    command: 'calendar-sync' as const,
    scopeId: 'fixture',
    bindingId,
    requestId,
    manifestFile: root + '/sync.json',
  };
  return { root, end, fences, connection, refresh, disconnect, coverage, options, args };
}
it('parses bounded owner commands without accepting credentials, arbitrary requests or model activation', () => {
  expect(parseAdminArguments(['calendar-status', '--scope', 'fixture', '--offset', '10'])).toEqual({
    command: 'calendar-status',
    scopeId: 'fixture',
    offset: 10,
  });
  expect(
    parseAdminArguments([
      'calendar-sync',
      '--scope',
      'fixture',
      '--binding',
      bindingId,
      '--request-id',
      requestId,
      '--manifest',
      '/private/sync.json',
    ]),
  ).toEqual({ command: 'calendar-sync', scopeId: 'fixture', bindingId, requestId, manifestFile: '/private/sync.json' });
  expect(
    parseAdminArguments([
      'calendar-disconnect',
      '--scope',
      'fixture',
      '--binding',
      bindingId,
      '--request-id',
      requestId,
    ]),
  ).toEqual({ command: 'calendar-disconnect', scopeId: 'fixture', bindingId, requestId });
  for (const args of [
    ['calendar-status', '--scope', 'fixture', '--offset', '10001'],
    ['calendar-status', '--scope', 'fixture', '--token', 'SECRET'],
    ['calendar-status', '--scope', 'fixture', '--scope', 'foreign'],
    ['calendar-disconnect', '--scope', 'fixture', '--binding', bindingId],
    ['calendar-disconnect', '--scope', 'fixture', '--binding', 'foreign', '--request-id', requestId],
    [
      'calendar-sync',
      '--scope',
      'fixture',
      '--binding',
      bindingId,
      '--request-id',
      requestId,
      '--manifest',
      '../sync.json',
    ],
  ])
    expect(() => parseAdminArguments(args)).toThrow('invalid_admin_arguments');
});
it('validates an explicit calendar and fixed instant window; rejects hidden authority and unbounded input', () => {
  expect(parseCalendarSync({ calendarId: 'selected' })).toEqual({ calendarId: 'selected' });
  expect(parseCalendarSync({ calendarId: 'selected', window })).toEqual({ calendarId: 'selected', window });
  for (const value of [
    null,
    {},
    { calendarId: '..' },
    { calendarId: 'has space' },
    { calendarId: 'a'.repeat(1025) },
    { calendarId: 'selected', url: 'https://evil.test/' },
    { calendarId: 'selected', scopeId: 'foreign' },
    { calendarId: 'selected', window: { ...window, timeMin: '2026-10-01T00:00:00' } },
    { calendarId: 'selected', window: { ...window, arbitrary: true } },
  ])
    expect(() => parseCalendarSync(value)).toThrow('invalid_calendar_manifest');
  expect(safeAdminError(new Error('invalid_calendar_manifest'))).toBe('invalid_calendar_manifest');
  expect(safeAdminError(new Error('calendar_backup_unavailable'))).toBe('calendar_backup_unavailable');
  expect(safeAdminError(new Error('calendar_backup_unavailable: SECRET'))).toBe('unreachable');
});
it('backs up before refresh, derives native identity, returns metadata only and leaves CoS paused', async () => {
  const s = setup();
  const order: string[] = [];
  vi.mocked(backupCalendarState).mockImplementation(async () => {
    order.push('backup');
    return {} as never;
  });
  s.refresh.mockImplementation(async () => {
    order.push('refresh');
    return {
      result: { status: 'pending', secret: 'RESULT_CANARY' },
      prepared: { snapshot: { description: 'EVENT_CANARY' } } as never,
    };
  });
  const result = await runCalendarAdmin({ ...s.options, args: s.args });
  expect(order).toEqual(['backup', 'refresh', 'backup']);
  expect(result).toEqual({
    status: 'pending',
    scope_id: 'fixture',
    snapshot_id: requestId,
    paused: true,
    live_model: 'not_invoked',
  });
  expect(JSON.stringify(result)).not.toMatch(/CANARY|SECRET_REF/);
  expect(s.refresh).toHaveBeenCalledWith(
    expect.objectContaining({
      scopeId: 'fixture',
      ownerId: 'owner',
      agentGroupId: 'group',
      provider: 'codex',
      ingressId: 'owner-calendar-' + requestId,
    }),
    bindingId,
    'selected',
    requestId,
    window,
  );
  expect(s.end).toHaveBeenCalledOnce();
  const [env, , admitted] = vi.mocked(connectCosHostStore).mock.calls.at(-1)!;
  expect(env.COS_CALENDAR_ENABLED).toBe('false');
  admitted();
  expect(s.options.assertAuthority).toHaveBeenCalled();
});
it('freezes the default window on first use and rejects altered request payloads on replay', async () => {
  const s = setup();
  writeAtomic(s.root, 'sync.json', { calendarId: 'selected' });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T00:00:00Z'));
  await runCalendarAdmin({ ...s.options, args: s.args });
  const first = s.refresh.mock.calls[0][4];
  vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-05T00:00:00Z'));
  await runCalendarAdmin({ ...s.options, args: s.args });
  expect(s.refresh.mock.calls[1][4]).toEqual(first);
  writeAtomic(s.root, 'sync.json', { calendarId: 'selected', window });
  await expect(runCalendarAdmin({ ...s.options, args: s.args })).rejects.toThrow('calendar_operation_conflict');
  expect(s.refresh).toHaveBeenCalledTimes(2);
});
it('refuses refresh when disabled, binding selection mismatches, backup fails or authority is lost', async () => {
  const s = setup();
  await expect(runCalendarAdmin({ ...s.options, env: {}, args: s.args })).rejects.toThrow('calendar_disabled');
  expect(s.refresh).not.toHaveBeenCalled();
  writeAtomic(s.root, 'sync.json', { calendarId: 'unselected', window });
  expect(await runCalendarAdmin({ ...s.options, args: s.args })).toMatchObject({ status: 'denied' });
  writeAtomic(s.root, 'sync.json', { calendarId: 'selected', window });
  vi.mocked(backupCalendarState).mockRejectedValueOnce(new Error('calendar_backup_unavailable'));
  await expect(runCalendarAdmin({ ...s.options, args: s.args })).rejects.toThrow('calendar_backup_unavailable');
  expect(s.refresh).not.toHaveBeenCalled();
  s.options.check.mockRejectedValue(new Error('private_owner_membership_required'));
  await expect(runCalendarAdmin({ ...s.options, args: s.args })).rejects.toThrow('private_owner_membership_required');
  expect(s.refresh).not.toHaveBeenCalled();
});
it('disconnect durably denies before database access even when disabled or the database cannot be reached', async () => {
  const s = setup();
  vi.mocked(connectCosHostStore).mockImplementation(async () => {
    expect(s.fences.deny).toHaveBeenCalledWith('fixture', bindingId, 'disconnected');
    throw new Error('database_unavailable');
  });
  const args = { command: 'calendar-disconnect' as const, scopeId: 'fixture', bindingId, requestId: randomUUID() };
  await expect(runCalendarAdmin({ ...s.options, env: {}, args })).rejects.toThrow('database_unavailable');
  expect(backupCalendarState).toHaveBeenCalledOnce();
  expect(openCalendarCredentials).not.toHaveBeenCalled();
  expect(s.refresh).not.toHaveBeenCalled();
});
it('disconnect never restores a denial and preserves it if protected backup fails', async () => {
  const s = setup();
  vi.mocked(backupCalendarState).mockRejectedValueOnce(new Error('calendar_backup_unavailable'));
  await expect(
    runCalendarAdmin({
      ...s.options,
      env: {},
      args: { command: 'calendar-disconnect', scopeId: 'fixture', bindingId, requestId },
    }),
  ).rejects.toThrow('calendar_backup_unavailable');
  expect(s.fences.deny).toHaveBeenCalledWith('fixture', bindingId, 'disconnected');
  expect(s.disconnect).toHaveBeenCalledOnce();
  expect(s.end).toHaveBeenCalledOnce();
});
it('status reports unavailable local access and disabled refresh without opening tokens or invoking a model', async () => {
  const s = setup();
  s.fences.assertOpen.mockImplementation(() => {
    throw new Error('calendar_auth_revoked');
  });
  expect(
    await runCalendarAdmin({
      ...s.options,
      env: {},
      args: { command: 'calendar-status', scopeId: 'fixture', offset: 0 },
    }),
  ).toMatchObject({
    status: 'ok',
    refresh_enabled: false,
    paused: true,
    items: [expect.objectContaining({ local_access: 'unavailable' })],
  });
  expect(openCalendarCredentials).not.toHaveBeenCalled();
  expect(backupCalendarState).not.toHaveBeenCalled();
  expect(s.refresh).not.toHaveBeenCalled();
});
it('rejects unsafe owner manifests and redirected operation journals before any refresh', async () => {
  const s = setup();
  fs.chmodSync(s.args.manifestFile, 0o644);
  await expect(runCalendarAdmin({ ...s.options, args: s.args })).rejects.toThrow('invalid_calendar_manifest');
  fs.chmodSync(s.args.manifestFile, 0o600);
  fs.linkSync(s.args.manifestFile, s.root + '/hard.json');
  await expect(runCalendarAdmin({ ...s.options, args: s.args })).rejects.toThrow('invalid_calendar_manifest');
  fs.unlinkSync(s.root + '/hard.json');
  fs.mkdirSync(s.root + '/outside', { mode: 0o700 });
  fs.symlinkSync(s.root + '/outside', s.root + '/calendar-admin');
  await expect(runCalendarAdmin({ ...s.options, args: s.args })).rejects.toThrow('unsafe_calendar_admin_state');
  expect(fs.readdirSync(s.root + '/outside')).toEqual([]);
  expect(s.refresh).not.toHaveBeenCalled();
});
