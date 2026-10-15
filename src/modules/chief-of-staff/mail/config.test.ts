import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { mailSettings, openMailCredentials, openMailFences } from './config.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { MailCredentialOwner } from './credentials.js';
import { configureVaultStorage, VAULT_DIRECTORIES } from '../ops/vault-storage.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { GOOGLE_MAIL_READ_SCOPE } from './oauth.js';
import type { CredentialJournal } from '../ops/backup-credential-event.js';
import { mailReaderRootIdentity } from './storage.js';
const cleanup: string[] = [];
function fixture(configured = true) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mail-config-'));
  cleanup.push(base);
  const roots = { targetRoot: base + '/target', installationRoot: base + '/app', dataRoot: base + '/data' },
    vault = base + '/vault';
  for (const directory of [
    ...Object.values(roots),
    vault,
    ...VAULT_DIRECTORIES.map((area) => vault + '/' + area),
    roots.targetRoot + '/calendar',
  ])
    fs.mkdirSync(directory, { mode: 0o700 });
  // Synthetic mounts only. Real encrypted mount proof remains an immutable artifact gate.
  const inspect: StorageInspection = (command, args) =>
    JSON.stringify(
      command.endsWith('/findmnt')
        ? {
            filesystems: [
              {
                target: args[2] === roots.targetRoot + '/calendar' ? args[2] : vault,
                fsroot: '/google/calendar',
                source: '/dev/mapper/fixture',
                fstype: 'ext4',
                'maj:min': '253:0',
                uuid: 'fixture-volume-uuid',
              },
            ],
          }
        : { blockdevices: [{ type: 'crypt', 'maj:min': '253:0', uuid: 'fixture-volume-uuid' }] },
    );
  configureVaultStorage(roots, vault, inspect);
  const root = vault + '/google/calendar/mail-reader';
  if (configured) {
    fs.mkdirSync(root, { mode: 0o700 });
    for (const child of ['credentials', 'access-denials']) fs.mkdirSync(root + '/' + child, { mode: 0o700 });
    fs.writeFileSync(
      root + '/oauth-client.json',
      JSON.stringify({
        clientId: 'mail-fixture.apps.googleusercontent.com',
        clientSecret: 'PRIVATE_MAIL_CLIENT_CANARY',
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      root + '/.cos-mail-reader',
      JSON.stringify(
        mailReaderRootIdentity(roots, {
          filesystemUuid: 'fixture-volume-uuid',
          directoryInodes: {
            profile: fs.statSync(root).ino,
            credentials: fs.statSync(root + '/credentials').ino,
            accessDenials: fs.statSync(root + '/access-denials').ino,
          },
          clientSha256: createHash('sha256')
            .update(fs.readFileSync(root + '/oauth-client.json'))
            .digest('hex'),
        }),
      ),
      { mode: 0o600 },
    );
    MailCredentialOwner.initialize(root + '/credentials');
    CalendarAccessFences.initialize(root + '/access-denials');
  }
  return { roots, vault, root, inspect };
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('keeps mail disabled by default and rejects malformed switches', () => {
  expect(mailSettings({})).toEqual({ enabled: false });
  expect(mailSettings({ COS_MAIL_ENABLED: 'true' })).toEqual({ enabled: true });
  expect(() => mailSettings({ COS_MAIL_ENABLED: 'yes' })).toThrow('COS_MAIL_ENABLED');
});
it('opens only existing protected mail state and never creates a missing profile', async () => {
  const f = fixture(false);
  await expect(
    openMailCredentials(
      f.roots,
      f.inspect,
      () => {},
      async () => {},
    ),
  ).rejects.toThrow('mail_configuration_unavailable');
  expect(fs.existsSync(f.root)).toBe(false);
});
it('holds a cheap current vault guard through the host lifetime, journals its own profile and closes it explicitly', async () => {
  const f = fixture(),
    inspect = vi.fn(f.inspect),
    journal = vi.fn<CredentialJournal>(async () => {});
  const host = await openMailCredentials(f.roots, inspect, () => {}, journal);
  try {
    const calls = inspect.mock.calls.length;
    for (let i = 0; i < 12; i++) host.verifyStorage();
    expect(inspect.mock.calls.length).toBe(calls);
    const binding = randomUUID(),
      reference = randomUUID();
    await host.credentials.install('scope', binding, reference, {
      accessToken: 'PRIVATE_FIXTURE_ACCESS',
      refreshToken: 'PRIVATE_FIXTURE_REFRESH',
      expiresAt: Date.now() + 3600000,
      refreshExpiresAt: null,
      scopes: [GOOGLE_MAIL_READ_SCOPE],
    });
    expect(journal).toHaveBeenCalled();
    expect(journal.mock.calls[0]?.[0]).toMatchObject({ sourceKind: 'mail_reader' });
    expect((await host.credentials.inspect('scope', binding, reference)).scopes).toEqual([GOOGLE_MAIL_READ_SCOPE]);
  } finally {
    await host.close();
  }
  expect(() => host.verifyStorage()).toThrow();
  expect(host.closed()).toBe(true);
  expect(() => host.fences.assertOpen('scope', randomUUID())).toThrow();
});
for (const changed of ['profile', 'credentials', 'fences', 'client', 'marker', 'memory'])
  it(`closes a held mail host after an awaited ${changed} replacement`, async () => {
    const f = fixture();
    let admitted = true;
    const host = await openMailCredentials(
      f.roots,
      f.inspect,
      () => {
        if (!admitted) throw Error('PRIVATE_MEMORY_CANARY');
      },
      async () => {},
    );
    await Promise.resolve();
    if (changed === 'memory') admitted = false;
    else if (changed === 'client' || changed === 'marker')
      fs.writeFileSync(
        f.root + (changed === 'client' ? '/oauth-client.json' : '/.cos-mail-reader'),
        'PRIVATE_REPLACEMENT_CANARY',
        { mode: 0o600 },
      );
    else {
      const original =
        changed === 'profile' ? f.root : f.root + (changed === 'credentials' ? '/credentials' : '/access-denials');
      fs.renameSync(original, original + '-old');
      fs.mkdirSync(original, { mode: 0o700 });
    }
    expect(() => host.verifyStorage()).toThrow();
    expect(() => host.fences.deny('scope', randomUUID(), 'revoked')).toThrow();
    await expect(host.close()).rejects.toThrow('mail_configuration_unavailable');
    expect(host.closed()).toBe(true);
  });
it('does not reveal malformed client bytes through configuration errors', async () => {
  const f = fixture();
  fs.writeFileSync(f.root + '/oauth-client.json', 'PRIVATE_INVALID_JSON_CANARY');
  try {
    await openMailCredentials(
      f.roots,
      f.inspect,
      () => {},
      async () => {},
    );
    throw Error('expected_denial');
    // eslint-disable-next-line no-catch-all/no-catch-all -- This privacy regression must inspect the public error and prove no nested credential diagnostic survives.
  } catch (error) {
    expect((error as Error).message).toBe('mail_configuration_unavailable');
    expect((error as Error).cause).toBeUndefined();
  }
});
it('cannot adopt replacement denial or credential folders after reconstructing the host', async () => {
  for (const child of ['credentials', 'access-denials']) {
    const f = fixture(),
      original = f.root + '/' + child;
    const host = await openMailCredentials(
      f.roots,
      f.inspect,
      () => {},
      async () => {},
    );
    await host.close();
    const held = f.root + '-' + child + '-held';
    fs.renameSync(original, held);
    fs.cpSync(held, original, { recursive: true });
    fs.chmodSync(original, 0o700);
    const opened = await openMailCredentials(
      f.roots,
      f.inspect,
      () => {},
      async () => {},
    ).then(
      (host) => host,
      () => null,
    );
    if (opened) await opened.close();
    expect(opened).toBe(null);
  }
});
for (const kind of ['symlink', 'hardlink', 'permissions', 'unknown-file'])
  it(`refuses an unsafe existing profile before opening credentials: ${kind}`, async () => {
    const f = fixture();
    if (kind === 'symlink') {
      fs.renameSync(f.root, f.root + '-held');
      fs.symlinkSync(f.root + '-held', f.root);
    }
    if (kind === 'hardlink') fs.linkSync(f.root + '/oauth-client.json', f.root + '-client-alias');
    if (kind === 'permissions') fs.chmodSync(f.root + '/oauth-client.json', 0o644);
    if (kind === 'unknown-file') fs.writeFileSync(f.root + '/unexpected.json', '{}', { mode: 0o600 });
    await expect(
      openMailCredentials(
        f.roots,
        f.inspect,
        () => {},
        async () => {},
      ),
    ).rejects.toThrow('mail_configuration_unavailable');
  });
it('does not redirect a rotated token into a replacement directory during the awaited OAuth exchange', async () => {
  const f = fixture(),
    host = await openMailCredentials(
      f.roots,
      f.inspect,
      () => {},
      async () => {},
    );
  const binding = randomUUID(),
    reference = randomUUID(),
    original = f.root + '/credentials',
    held = f.root + '-credentials-held';
  await host.credentials.install('scope', binding, reference, {
    accessToken: 'PRIVATE_OLD_ACCESS',
    refreshToken: 'PRIVATE_OLD_REFRESH',
    expiresAt: Date.now() - 1,
    refreshExpiresAt: null,
    scopes: [GOOGLE_MAIL_READ_SCOPE],
  });
  const fetch = vi.fn(async () => {
    fs.renameSync(original, held);
    fs.mkdirSync(original, { mode: 0o700 });
    fs.copyFileSync(held + '/.cos-mail-reader-credentials', original + '/.cos-mail-reader-credentials');
    return new Response(
      JSON.stringify({
        access_token: 'PRIVATE_NEW_ACCESS',
        refresh_token: 'PRIVATE_NEW_REFRESH',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: GOOGLE_MAIL_READ_SCOPE,
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  await expect(host.credentials.token('scope', binding, reference)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fs.readdirSync(original)).toEqual(['.cos-mail-reader-credentials']);
  await expect(host.close()).rejects.toThrow('mail_configuration_unavailable');
});
it('opens only mail storage and denial authority for disabled-reader retention, without reading token state', async () => {
  const f = fixture(),
    reference = randomUUID();
  fs.writeFileSync(f.root + '/credentials/' + reference + '.json', 'PRIVATE_INVALID_TOKEN_CANARY', { mode: 0o600 });
  const open = vi.spyOn(fs, 'openSync');
  const host = await openMailFences(f.roots, f.inspect, () => {});
  try {
    const binding = randomUUID();
    host.fences.deny('scope', binding, 'revoked');
    expect(() => host.fences.assertOpen('scope', binding)).toThrow('auth_revoked');
    expect(open.mock.calls.some(([file]) => String(file).endsWith('/' + reference + '.json'))).toBe(false);
    expect(host.closed()).toBe(false);
  } finally {
    await host.close();
    open.mockRestore();
  }
  expect(host.closed()).toBe(true);
});
