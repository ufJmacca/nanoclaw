import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { actionSettings, openWriterCredentials } from './config.js';
import { CalendarWriterCredentialOwner } from './credentials.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { CalendarCredentialOwner } from '../calendar/credentials.js';
import { openCalendarCredentials } from '../calendar/config.js';
import { configureCalendarStorage } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { GOOGLE_CALENDAR_METADATA_SCOPE, GOOGLE_OWNED_EVENT_WRITE_SCOPE } from './writer.js';
vi.mock('../ops/vault-memory.js', () => ({ verifyVaultMemory: vi.fn() }));
const temporary: string[] = [];
const inspect: StorageInspection = (command, args) =>
  JSON.stringify(
    command.endsWith('/findmnt')
      ? {
          filesystems: [
            {
              target: args[args.indexOf('--target') + 1],
              source: '/dev/mapper/private',
              fstype: 'ext4',
              'maj:min': '253:0',
              uuid: 'fixture-filesystem-uuid',
            },
          ],
        }
      : {
          blockdevices: [
            { name: '/dev/mapper/private', type: 'crypt', 'maj:min': '253:0', uuid: 'fixture-filesystem-uuid' },
          ],
        },
  );
function setup(protectedStorage = true) {
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-action-config-'));
  temporary.push(targetRoot);
  const roots = { targetRoot, installationRoot: targetRoot + '-app', dataRoot: targetRoot + '-data' },
    calendar = path.join(targetRoot, 'calendar');
  fs.mkdirSync(calendar, { mode: 0o700 });
  for (const name of ['credentials', 'access-denials', 'writer-credentials', 'writer-access-denials'])
    fs.mkdirSync(path.join(calendar, name), { mode: 0o700 });
  CalendarCredentialOwner.initialize(path.join(calendar, 'credentials'));
  CalendarWriterCredentialOwner.initialize(path.join(calendar, 'writer-credentials'));
  CalendarAccessFences.initialize(path.join(calendar, 'access-denials'));
  CalendarAccessFences.initialize(path.join(calendar, 'writer-access-denials'));
  for (const name of ['oauth-client.json', 'writer-oauth-client.json'])
    fs.writeFileSync(
      path.join(calendar, name),
      JSON.stringify({ clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'PRIVATE_CLIENT_CANARY' }),
      { mode: 0o600 },
    );
  if (protectedStorage) {
    const backup = targetRoot + '-backup';
    temporary.push(backup);
    fs.mkdirSync(backup, { mode: 0o700 });
    configureCalendarStorage(roots, backup, inspect);
  }
  return { roots, calendar };
}
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('S09 writer enablement is separate, explicit and false by default', () => {
  expect(actionSettings({})).toEqual({ enabled: false });
  expect(actionSettings({ COS_CALENDAR_ENABLED: 'true' })).toEqual({ enabled: false });
  expect(actionSettings({ COS_ACTIONS_ENABLED: 'true' })).toEqual({ enabled: true });
  for (const value of ['TRUE', 'yes', '', '1'])
    expect(() => actionSettings({ COS_ACTIONS_ENABLED: value })).toThrow('COS_ACTIONS_ENABLED');
});
it('opens separately owned writer files and keeps reader and writer revocation independent', () => {
  const { roots, calendar } = setup(),
    writer = openWriterCredentials(roots, inspect),
    reader = openCalendarCredentials(roots, inspect),
    id = randomUUID();
  expect(writer.credentials.root).toBe(path.join(calendar, 'writer-credentials'));
  writer.fences.deny('scope', id, 'revoked');
  expect(() => openWriterCredentials(roots, inspect).fences.assertOpen('scope', id)).toThrow('calendar_auth_revoked');
  expect(() => reader.fences.assertOpen('scope', id)).not.toThrow();
  const other = randomUUID();
  reader.fences.deny('scope', other, 'disconnected');
  expect(() => writer.fences.assertOpen('scope', other)).not.toThrow();
});
it('returns only a host owner and never performs OAuth during opening', async () => {
  const { roots } = setup(),
    fetch = vi.fn(async () => {
      throw Error('PRIVATE_REQUEST_CANARY');
    }),
    opened = openWriterCredentials(roots, inspect, { fetch }),
    id = randomUUID(),
    reference = randomUUID();
  await opened.credentials.install('scope', id, reference, {
    accessToken: 'FIXTURE_ACCESS_TOKEN',
    refreshToken: 'FIXTURE_REFRESH_TOKEN',
    expiresAt: Date.now() + 3600000,
    refreshExpiresAt: null,
    scopes: [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE],
  });
  expect((await opened.credentials.inspect('scope', id, reference)).auth).toBe('ready');
  expect(fetch).not.toHaveBeenCalled();
});
it('never uses reader client or vault as fallback when writer configuration is missing', () => {
  const { roots, calendar } = setup();
  fs.unlinkSync(path.join(calendar, 'writer-oauth-client.json'));
  expect(() => openWriterCredentials(roots, inspect)).toThrow('action_configuration_unavailable');
  expect(() => openCalendarCredentials(roots, inspect)).not.toThrow();
});
it('requires verified encryption and a separately protected backup root', () => {
  const { roots } = setup(false);
  expect(() => openWriterCredentials(roots, inspect)).toThrow('action_configuration_unavailable');
});
it('does not initialize missing writer ownership or denial journals during runtime', () => {
  const { roots, calendar } = setup();
  fs.unlinkSync(path.join(calendar, 'writer-credentials', '.cos-calendar-writer-credentials'));
  expect(() => openWriterCredentials(roots, inspect)).toThrow('action_configuration_unavailable');
  expect(fs.readdirSync(path.join(calendar, 'writer-credentials'))).toEqual([]);
});
it('rejects a reader-owned writer directory', () => {
  const { roots, calendar } = setup(),
    root = path.join(calendar, 'writer-credentials');
  fs.unlinkSync(path.join(root, '.cos-calendar-writer-credentials'));
  CalendarCredentialOwner.initialize(root);
  expect(() => openWriterCredentials(roots, inspect)).toThrow('action_configuration_unavailable');
});
it.each(['mode', 'hardlink', 'symlink', 'corrupt'])(
  'rejects %s writer client without exposing diagnostics',
  (change) => {
    const { roots, calendar } = setup(),
      file = path.join(calendar, 'writer-oauth-client.json');
    if (change === 'mode') fs.chmodSync(file, 0o644);
    if (change === 'hardlink') fs.linkSync(file, path.join(calendar, 'client-copy'));
    if (change === 'symlink') {
      fs.renameSync(file, file + '.actual');
      fs.symlinkSync(file + '.actual', file);
    }
    if (change === 'corrupt') fs.writeFileSync(file, '{PRIVATE_CLIENT_CANARY');
    try {
      openWriterCredentials(roots, inspect);
      throw Error('must refuse');
      // eslint-disable-next-line no-catch-all/no-catch-all -- This test inspects the deliberately fixed diagnostic boundary.
    } catch (error) {
      expect((error as Error).message).toBe('action_configuration_unavailable');
      expect((error as Error).cause).toBeUndefined();
    }
  },
);
it('refuses Git storage and target roots overlapping worker/native data', () => {
  const { roots } = setup();
  for (const installationRoot of [
    roots.targetRoot,
    path.dirname(roots.targetRoot),
    path.join(roots.targetRoot, 'worker'),
  ])
    expect(() => openWriterCredentials({ ...roots, installationRoot }, inspect)).toThrow(
      'action_configuration_unavailable',
    );
  fs.mkdirSync(path.join(roots.targetRoot, '.git'));
  expect(() => openWriterCredentials(roots, inspect)).toThrow('action_configuration_unavailable');
});
it('closes an opened writer when its client or private vault is replaced', () => {
  const { roots, calendar } = setup(),
    opened = openWriterCredentials(roots, inspect),
    client = path.join(calendar, 'writer-oauth-client.json');
  fs.writeFileSync(client, JSON.stringify({ clientId: 'other.apps.googleusercontent.com' }));
  expect(() => opened.verify()).toThrow('action_configuration_unavailable');
  const second = openWriterCredentials(roots, inspect),
    vault = path.join(calendar, 'writer-credentials');
  fs.renameSync(vault, vault + '-old');
  fs.cpSync(vault + '-old', vault, { recursive: true });
  expect(() => second.verify()).toThrow('action_configuration_unavailable');
});
it('closes admission when a copied denial journal replaces its pinned owner', () => {
  const { roots, calendar } = setup(),
    opened = openWriterCredentials(roots, inspect),
    denial = path.join(calendar, 'writer-access-denials');
  fs.renameSync(denial, denial + '-old');
  fs.cpSync(denial + '-old', denial, { recursive: true });
  expect(() => opened.verify()).toThrow('action_configuration_unavailable');
});
it('rechecks encryption and backup policy after opening without provider traffic', () => {
  const { roots } = setup();
  let mounted = true;
  const current: StorageInspection = (command, args) =>
    mounted ? inspect(command, args) : JSON.stringify({ filesystems: [] });
  const opened = openWriterCredentials(roots, current);
  mounted = false;
  expect(() => opened.verify()).toThrow('action_configuration_unavailable');
});
