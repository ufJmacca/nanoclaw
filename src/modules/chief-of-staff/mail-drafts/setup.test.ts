import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { initializeMailProfile } from '../mail/setup.js';
import { initializeMailDraftProfile } from './setup.js';
import { withMailDraftWriterStorage } from './storage.js';
import { mailDraftSettings, openMailDraftCredentials } from './config.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
import { configureVaultStorage, VAULT_DIRECTORIES } from '../ops/vault-storage.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-setup-'));
  cleanup.push(base);
  const roots = { targetRoot: base + '/target', installationRoot: base + '/app', dataRoot: base + '/data' },
    vault = base + '/vault';
  for (const root of [
    ...Object.values(roots),
    vault,
    ...VAULT_DIRECTORIES.map((area) => vault + '/' + area),
    roots.targetRoot + '/calendar',
  ])
    fs.mkdirSync(root, { mode: 0o700 });
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
  const calendar = vault + '/google/calendar',
    reader = calendar + '/mail-reader',
    writer = calendar + '/mail-draft-writer';
  fs.writeFileSync(
    calendar + '/oauth-client.json',
    JSON.stringify({ clientId: 'calendar-fixture.apps.googleusercontent.com' }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    calendar + '/writer-oauth-client.json',
    JSON.stringify({ clientId: 'calendar-writer-fixture.apps.googleusercontent.com' }),
    { mode: 0o600 },
  );
  const memory = vi.fn(),
    authority = { operationId: randomUUID(), assertAuthority: vi.fn() };
  const readerClient = { clientId: 'mail-reader-fixture.apps.googleusercontent.com' };
  const client = {
    clientId: 'mail-draft-writer-fixture.apps.googleusercontent.com',
    clientSecret: 'FIXTURE_PRIVATE_DRAFT_CLIENT',
  };
  await initializeMailProfile(roots, readerClient, authority, inspect, memory);
  return { roots, vault, calendar, reader, writer, readerClient, client, memory, authority, inspect };
}
it('creates only the separate encrypted draft profile and preserves all existing reader and Calendar files', async () => {
  const f = await fixture(),
    readerBefore = fs.readFileSync(f.reader + '/.cos-mail-reader'),
    calendarBefore = fs.readFileSync(f.calendar + '/oauth-client.json');
  expect(await initializeMailDraftProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).toEqual({
    status: 'ready',
  });
  await withMailDraftWriterStorage(
    f.roots,
    async (storage) => {
      expect(storage.root).toBe(f.writer);
      expect(storage.readClient()).toEqual(f.client);
      storage.assertCurrent();
    },
    f.inspect,
    f.memory,
  );
  expect(fs.readFileSync(f.reader + '/.cos-mail-reader')).toEqual(readerBefore);
  expect(fs.readFileSync(f.calendar + '/oauth-client.json')).toEqual(calendarBefore);
  expect(fs.readdirSync(f.writer).sort()).toEqual([
    '.cos-mail-draft-writer',
    'access-denials',
    'credentials',
    'oauth-client.json',
  ]);
  expect(fs.readdirSync(f.writer + '/credentials')).toEqual(['.cos-mail-draft-writer-credentials']);
  const inode = fs.statSync(f.writer).ino;
  await initializeMailDraftProfile(f.roots, f.client, f.authority, f.inspect, f.memory);
  expect(fs.statSync(f.writer).ino).toBe(inode);
});
it.each(['intent', 'directories', 'client', 'markers', 'proof'] as const)(
  'reconciles the same interrupted %s setup while runtime stays closed',
  async (step) => {
    const f = await fixture();
    await expect(
      initializeMailDraftProfile(f.roots, f.client, f.authority, f.inspect, f.memory, {
        afterStep: async (current) => {
          if (current === step) throw Error('fixture_interruption');
        },
      }),
    ).rejects.toThrow();
    await expect(withMailDraftWriterStorage(f.roots, async () => {}, f.inspect, f.memory)).rejects.toThrow();
    await expect(
      initializeMailDraftProfile(f.roots, f.client, { ...f.authority, operationId: randomUUID() }, f.inspect, f.memory),
    ).rejects.toThrow();
    expect(await initializeMailDraftProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).toEqual({
      status: 'ready',
    });
  },
);
it.each(['calendar-fixture', 'calendar-writer-fixture', 'mail-reader-fixture'])(
  'refuses reusing the existing %s client through the fixed private vault error',
  async (name) => {
    const f = await fixture();
    await expect(
      initializeMailDraftProfile(
        f.roots,
        { clientId: name + '.apps.googleusercontent.com' },
        f.authority,
        f.inspect,
        f.memory,
      ),
    ).rejects.toThrow(/^vault_storage_unavailable$/);
    expect(fs.existsSync(f.writer)).toBe(false);
  },
);
it('never initializes a missing writer at runtime or adopts one without the owned reader', async () => {
  const f = await fixture();
  await expect(withMailDraftWriterStorage(f.roots, async () => {}, f.inspect, f.memory)).rejects.toThrow();
  expect(fs.existsSync(f.writer)).toBe(false);
  fs.unlinkSync(f.reader + '/.cos-mail-reader');
  await expect(initializeMailDraftProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).rejects.toThrow();
  expect(fs.existsSync(f.writer)).toBe(false);
});
it('pins the live profile and rejects changed configuration through lifetime close', async () => {
  const f = await fixture();
  await initializeMailDraftProfile(f.roots, f.client, f.authority, f.inspect, f.memory);
  await expect(
    withMailDraftWriterStorage(
      f.roots,
      async (storage) => {
        const file = f.writer + '/oauth-client.json';
        fs.renameSync(file, file + '.old');
        fs.copyFileSync(file + '.old', file);
        expect(() => storage.assertCurrent()).toThrow();
        fs.unlinkSync(file);
        fs.renameSync(file + '.old', file);
      },
      f.inspect,
      f.memory,
    ),
  ).rejects.toThrow();
});
it('stops setup when owner authority is lost around an awaited step', async () => {
  const f = await fixture();
  await expect(
    initializeMailDraftProfile(f.roots, f.client, f.authority, f.inspect, f.memory, {
      afterStep: async (step) => {
        if (step === 'client')
          f.authority.assertAuthority.mockImplementation(() => {
            throw Error('fixture_authority_lost');
          });
      },
    }),
  ).rejects.toThrow();
  await expect(withMailDraftWriterStorage(f.roots, async () => {}, f.inspect, f.memory)).rejects.toThrow();
});
it('keeps draft runtime disabled by default and requires the selected Mail reader when enabled', () => {
  expect(mailDraftSettings({})).toEqual({ enabled: false });
  expect(mailDraftSettings({ COS_MAIL_DRAFTS_ENABLED: 'true', COS_MAIL_ENABLED: 'true' })).toEqual({ enabled: true });
  for (const env of [
    { COS_MAIL_DRAFTS_ENABLED: 'yes' },
    { COS_MAIL_DRAFTS_ENABLED: 'true' },
    { COS_MAIL_DRAFTS_ENABLED: 'true', COS_MAIL_ENABLED: 'false' },
  ])
    expect(() => mailDraftSettings(env)).toThrow();
});
it('holds the actual draft credential vault proof and denials for its complete host lifetime', async () => {
  const f = await fixture();
  await initializeMailDraftProfile(f.roots, f.client, f.authority, f.inspect, f.memory);
  const host = await openMailDraftCredentials(f.roots, f.inspect, f.memory, async () => {});
  expect(host.clientId).toBe(f.client.clientId);
  try {
    const binding = randomUUID(),
      reference = randomUUID();
    await host.credentials.install('scope', binding, reference, {
      accessToken: 'FIXTURE_HOST_DRAFT_ACCESS',
      refreshToken: 'FIXTURE_HOST_DRAFT_REFRESH',
      expiresAt: Date.now() + 3600000,
      refreshExpiresAt: null,
      scopes: [GOOGLE_MAIL_DRAFT_SCOPE],
    });
    expect(await host.credentials.token('scope', binding, reference)).toBe('FIXTURE_HOST_DRAFT_ACCESS');
    host.fences.deny('scope', binding, 'disconnected');
    await expect(host.credentials.token('scope', binding, reference)).rejects.toThrow();
  } finally {
    await host.close();
  }
  expect(host.closed()).toBe(true);
  expect(() => host.verifyStorage()).toThrow();
});
