import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { calendarSettings, openCalendarCredentials } from './config.js';
import { CalendarAccessFences } from './access-fences.js';
import { CalendarCredentialOwner } from './credentials.js';
const roots: string[] = [];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-calendar-config-'));
  roots.push(root);
  return root;
}
function configure(root: string) {
  const calendar = path.join(root, 'calendar');
  fs.mkdirSync(calendar, { mode: 0o700 });
  for (const name of ['credentials', 'access-denials']) fs.mkdirSync(path.join(calendar, name), { mode: 0o700 });
  CalendarCredentialOwner.initialize(path.join(calendar, 'credentials'));
  CalendarAccessFences.initialize(path.join(calendar, 'access-denials'));
  fs.writeFileSync(
    path.join(calendar, 'oauth-client.json'),
    JSON.stringify({ clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'PRIVATE_CLIENT_CANARY' }),
    { mode: 0o600 },
  );
  return calendar;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('requires explicit calendar enablement', () => {
  expect(calendarSettings({})).toEqual({ enabled: false });
  expect(calendarSettings({ COS_CALENDAR_ENABLED: 'true' })).toEqual({ enabled: true });
  for (const enabled of ['yes', 'TRUE', '', '1'])
    expect(() => calendarSettings({ COS_CALENDAR_ENABLED: enabled })).toThrow('COS_CALENDAR_ENABLED');
});
it('opens only explicitly initialized host directories and preserves durable denial', () => {
  const root = setup(),
    calendar = configure(root),
    binding = '11111111-1111-4111-8111-111111111111';
  const first = openCalendarCredentials(root, []);
  expect(first.credentials.root).toBe(path.join(calendar, 'credentials'));
  first.fences.deny('scope', binding, 'revoked');
  expect(() => openCalendarCredentials(root, []).fences.assertOpen('scope', binding)).toThrow('calendar_auth_revoked');
});
it('does not create or adopt missing and uninitialized runtime directories', () => {
  const root = setup();
  expect(() => openCalendarCredentials(root, [])).toThrow('calendar_configuration_unavailable');
  expect(fs.readdirSync(root)).toEqual([]);
  const calendar = configure(root);
  fs.unlinkSync(path.join(calendar, 'access-denials', '.cos-calendar-fences'));
  expect(() => openCalendarCredentials(root, [])).toThrow('calendar_configuration_unavailable');
  expect(fs.readdirSync(path.join(calendar, 'access-denials'))).toEqual([]);
});
it('rejects Git roots, overlaps, symlinks and exposed credential files without diagnostic secrets', () => {
  const root = setup(),
    calendar = configure(root);
  fs.mkdirSync(path.join(root, '.git'));
  expect(() => openCalendarCredentials(root, [])).toThrow('calendar_configuration_unavailable');
  fs.rmdirSync(path.join(root, '.git'));
  for (const excluded of [root, path.dirname(root), path.join(root, 'runtime')])
    expect(() => openCalendarCredentials(root, [excluded])).toThrow('calendar_configuration_unavailable');
  fs.chmodSync(path.join(calendar, 'oauth-client.json'), 0o644);
  expect(() => openCalendarCredentials(root, [])).toThrow('calendar_configuration_unavailable');
  fs.chmodSync(path.join(calendar, 'oauth-client.json'), 0o600);
  fs.renameSync(calendar, path.join(root, 'actual'));
  fs.symlinkSync(path.join(root, 'actual'), calendar);
  expect(() => openCalendarCredentials(root, [])).toThrow('calendar_configuration_unavailable');
});
