import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { withCredentialPrimarySnapshot } from './credential-primary-source.js';
import { CalendarCredentialCore } from '../calendar/credential-core.js';
import type { OAuthScopeProfile } from '../calendar/oauth-core.js';
import { GOOGLE_EVENT_READ_SCOPE } from '../calendar/reader.js';
import { GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE } from '../actions/writer.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../mail/oauth.js';
import { makeCredentialEvent, type CredentialEvent } from './backup-credential-event.js';
import { writeAtomic } from './target-state.js';
const cleanup: string[] = [],
  owner = 'a'.repeat(64);
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(profile: OAuthScopeProfile = 'mail_reader') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-primary-source-'));
  cleanup.push(base);
  const root = base + '/credentials',
    denialRoot = base + '/denials';
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(denialRoot, { mode: 0o700 });
  CalendarCredentialCore.initialize(root, profile);
  const events: CredentialEvent[] = [];
  const clientId = 'source-fixture.apps.googleusercontent.com';
  const credentials = new CalendarCredentialCore(
    root,
    { clientId },
    CalendarAccessFences.initialize(denialRoot),
    profile,
    {},
    () => {},
    async (change) => {
      events.push(makeCredentialEvent(change, owner));
    },
  );
  const binding = randomUUID(),
    reference = randomUUID();
  const tokens = {
    accessToken: 'PRIVATE_SOURCE_ACCESS',
    refreshToken: 'PRIVATE_SOURCE_REFRESH',
    expiresAt: Date.now() + 3600000,
    refreshExpiresAt: null,
    scopes:
      profile === 'reader'
        ? [GOOGLE_EVENT_READ_SCOPE]
        : profile === 'owned_event_writer'
          ? [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE]
          : [GOOGLE_MAIL_READ_SCOPE],
  };
  await credentials.install('scope', binding, reference, tokens);
  const guard = vi.fn();
  const run = async <T>(operation: Parameters<typeof withCredentialPrimarySnapshot<T>>[1]) => {
    const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      return await withCredentialPrimarySnapshot(
        { directoryFd: fd, ownerDigest: owner, clientId, profile, assertScope: guard },
        operation,
      );
    } finally {
      fs.closeSync(fd);
    }
  };
  return { base, root, events, credentials, reference, tokens, guard, run };
}
it('independently reads actual primary bytes matching the credential owner event and scrubs them on exit', async () => {
  const f = await fixture();
  let borrowed!: Buffer;
  await f.run(async (snapshot) => {
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0].credentialReference).toBe(f.reference);
    expect(snapshot.sources[0].event).toEqual(f.events[0]);
    borrowed = snapshot.sources[0].files[0].bytes;
    expect(borrowed.equals(fs.readFileSync(f.root + '/' + f.reference + '.json'))).toBe(true);
    snapshot.assertPrimaryUnchanged();
    snapshot.assertCurrent();
  });
  expect(borrowed.every((byte) => byte === 0)).toBe(true);
});
it('keeps an as-of snapshot valid while a later source is added, without claiming it is still current', async () => {
  const f = await fixture();
  await f.run(async (snapshot) => {
    await f.credentials.install('scope', randomUUID(), randomUUID(), f.tokens);
    expect(snapshot.sources).toHaveLength(1);
    expect(() => snapshot.assertPrimaryUnchanged()).toThrow('credential_primary_snapshot_unavailable');
    expect(() => snapshot.assertCurrent()).not.toThrow();
  });
});
it('refuses a primary replacement during the synchronous consistency pass before exposing a snapshot', async () => {
  const f = await fixture(),
    read = fs.readSync;
  let replaced = false;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const result = read(...args);
    const file = fs.readlinkSync('/proc/self/fd/' + args[0]);
    if (!replaced && file.endsWith(f.reference + '.json')) {
      replaced = true;
      const value = JSON.parse(fs.readFileSync(f.root + '/' + f.reference + '.json', 'utf8'));
      value.generation++;
      writeAtomic(f.root, f.reference + '.json', value);
    }
    return result;
  });
  const callback = vi.fn();
  await expect(f.run(callback)).rejects.toThrow('credential_primary_snapshot_unavailable');
  expect(callback).not.toHaveBeenCalled();
});
for (const invalid of [
  'foreign-client',
  'foreign-marker',
  'unknown-file',
  'hard-link',
  'temporary',
  'broader-scope',
] as const)
  it(`refuses ${invalid} primary state without changing it or making a provider request`, async () => {
    const f = await fixture(),
      file = f.root + '/' + f.reference + '.json';
    if (invalid === 'foreign-client' || invalid === 'broader-scope') {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (invalid === 'foreign-client') value.clientId = 'other.apps.googleusercontent.com';
      else value.tokens.scopes = ['https://www.googleapis.com/auth/gmail.modify'];
      writeAtomic(f.root, f.reference + '.json', value);
    }
    if (invalid === 'foreign-marker') fs.writeFileSync(f.root + '/.cos-mail-reader-credentials', 'foreign');
    if (invalid === 'unknown-file') fs.writeFileSync(f.root + '/valuable', 'PRIVATE_FOREIGN');
    if (invalid === 'hard-link') fs.linkSync(file, f.base + '/held');
    if (invalid === 'temporary') fs.writeFileSync(f.root + '/.' + randomUUID() + '.tmp', 'PARTIAL');
    const before = fs.readFileSync(file),
      callback = vi.fn();
    await expect(f.run(callback)).rejects.toThrow('credential_primary_snapshot_unavailable');
    expect(callback).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
  });
it('closes borrowed data after an awaited loss of protected source scope', async () => {
  const f = await fixture();
  let borrowed!: Buffer;
  await expect(
    f.run(async (snapshot) => {
      borrowed = snapshot.sources[0].files[0].bytes;
      await Promise.resolve();
      f.guard.mockImplementation(() => {
        throw Error('PRIVATE_SCOPE_LOSS');
      });
      snapshot.assertCurrent();
    }),
  ).rejects.toThrow('credential_primary_snapshot_unavailable');
  expect(borrowed.every((byte) => byte === 0)).toBe(true);
});
it('refuses duplicate logical sources under different credential reference filenames', async () => {
  const f = await fixture();
  fs.copyFileSync(f.root + '/' + f.reference + '.json', f.root + '/' + randomUUID() + '.json');
  fs.chmodSync(
    f.root + '/' + fs.readdirSync(f.root).find((name) => name.endsWith('.json') && name !== f.reference + '.json')!,
    0o600,
  );
  await expect(f.run(async () => {})).rejects.toThrow('credential_primary_snapshot_unavailable');
});
it.each(['reader', 'owned_event_writer'] as const)(
  'reads the existing %s primary profile as data without calling its provider',
  async (profile) => {
    const f = await fixture(profile);
    await f.run(async (snapshot) => {
      expect(snapshot.sources).toHaveLength(1);
      expect(snapshot.sources[0].event).toEqual(f.events[0]);
    });
  },
);
