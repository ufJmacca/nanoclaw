import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { configureVaultStorage, VAULT_DIRECTORIES } from './vault-storage.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { CalendarCredentialCore } from '../calendar/credential-core.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import type { OAuthScopeProfile } from '../calendar/oauth-core.js';
import { GOOGLE_EVENT_READ_SCOPE } from '../calendar/reader.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../mail/oauth.js';
import { GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE } from '../actions/writer.js';
import { initializeMailProfile } from '../mail/setup.js';
import { recordMailRecoveryPage } from '../mail/recovery.js';
import { makeCredentialEvent, type CredentialEvent } from './backup-credential-event.js';
import {
  makeRoutedCredentialRecoveryManifest,
  routedCredentialRecoveryFiles,
  verifyRoutedCredentialRecoveryReceipt,
} from './credential-recovery-routing.js';
import { BackupQueue } from './backup-queue.js';
import { streamBackupArchive } from './backup-archive.js';
import { readBackupArchive } from './backup-archive-reader.js';
import { withVaultCredentialSnapshot } from './credential-vault-snapshot.js';
import { digest } from '../domain/contracts.js';
import { writeAtomic } from './target-state.js';
const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-vault-credential-snapshot-'));
  cleanup.push(base);
  const roots = { targetRoot: base + '/target', installationRoot: base + '/app', dataRoot: base + '/data' },
    vault = base + '/vault',
    filesystemUuid = randomUUID();
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
                uuid: filesystemUuid,
              },
            ],
          }
        : { blockdevices: [{ type: 'crypt', 'maj:min': '253:0', uuid: filesystemUuid }] },
    );
  const policy = configureVaultStorage(roots, vault, inspect),
    owner = digest({ targetDigest: policy.targetDigest, filesystemUuid }),
    calendar = vault + '/google/calendar',
    backup = vault + '/backup-credentials',
    memory = vi.fn(),
    authority = vi.fn();
  writeAtomic(calendar, 'oauth-client.json', { clientId: 'reader-fixture.apps.googleusercontent.com' });
  await initializeMailProfile(
    roots,
    { clientId: 'mail-fixture.apps.googleusercontent.com' },
    { operationId: randomUUID(), assertAuthority: authority },
    inspect,
    memory,
  );
  writeAtomic(calendar, 'writer-oauth-client.json', { clientId: 'writer-fixture.apps.googleusercontent.com' });
  const profiles = [],
    events: CredentialEvent[] = [];
  for (const profile of ['reader', 'owned_event_writer', 'mail_reader'] as const) {
    const root = profile === 'mail_reader' ? calendar + '/mail-reader' : calendar,
      credentials = root + (profile === 'owned_event_writer' ? '/writer-credentials' : '/credentials'),
      denial = root + (profile === 'owned_event_writer' ? '/writer-access-denials' : '/access-denials'),
      clientId =
        (profile === 'reader' ? 'reader' : profile === 'mail_reader' ? 'mail' : 'writer') +
        '-fixture.apps.googleusercontent.com';
    if (profile !== 'mail_reader') {
      fs.mkdirSync(credentials, { mode: 0o700 });
      fs.mkdirSync(denial, { mode: 0o700 });
      CalendarCredentialCore.initialize(credentials, profile);
      CalendarAccessFences.initialize(denial);
    }
    const fences = new CalendarAccessFences(denial),
      reference = randomUUID(),
      binding = randomUUID();
    const ownerCore = new CalendarCredentialCore(
      credentials,
      { clientId },
      fences,
      profile,
      {},
      () => {},
      async (change) => {
        events.push(makeCredentialEvent(change, owner));
      },
    );
    const tokens = {
      accessToken: 'PRIVATE_SNAPSHOT_ACCESS',
      refreshToken: 'PRIVATE_SNAPSHOT_REFRESH',
      expiresAt: Date.now() + 3600000,
      refreshExpiresAt: null,
      scopes:
        profile === 'reader'
          ? [GOOGLE_EVENT_READ_SCOPE]
          : profile === 'mail_reader'
            ? [GOOGLE_MAIL_READ_SCOPE]
            : [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE],
    };
    await ownerCore.install('scope', binding, reference, tokens);
    fences.deny('scope', binding, 'disconnected');
    profiles.push({
      profile: profile as OAuthScopeProfile,
      root,
      credentials,
      denial,
      reference,
      ownerCore,
      tokens,
      fences,
    });
  }
  writeAtomic(backup, 'backup-credential-installation.json', {
    contract: 'cos-backup-credential-installation/v1',
    rootsDigest: digest(roots),
    filesystemUuid,
    operationId: randomUUID(),
    credentialReference: randomUUID(),
    phase: 'ready',
  });
  fs.writeFileSync(backup + '/smb-credentials', 'username=nanoclaw-cos-backup\npassword=PRIVATE_SNAPSHOT_PASSWORD\n', {
    mode: 0o600,
  });
  fs.writeFileSync(backup + '/restic-password', 'f'.repeat(64) + '\n', { mode: 0o600 });
  writeAtomic(backup, 'backup-repository.json', {
    contract: 'cos-backup-repository/v1',
    rootsDigest: digest(roots),
    filesystemUuid,
    repositoryId: 'c'.repeat(64),
    mount: { host: '192.0.2.1', share: 'nanoclaw-cos-backups', mount: base + '/nas' },
  });
  const run = async <T>(operation: Parameters<typeof withVaultCredentialSnapshot<T>>[2]) =>
    withVaultCredentialSnapshot(roots, { assertAuthority: authority }, operation, inspect, memory);
  return { base, roots, vault, calendar, backup, owner, profiles, events, memory, authority, inspect, run };
}
it('independently selects all configured Google clients, tokens, permanent denials and backup credentials with checked origins', async () => {
  const f = await fixture();
  const borrowed: Buffer[] = [];
  await f.run(async (snapshot) => {
    expect(snapshot.ownerDigest).toBe(f.owner);
    expect(snapshot.sources).toHaveLength(11);
    expect(snapshot.openChecks).toBe(0);
    for (const expected of f.events)
      expect(snapshot.sources.some((s) => digest(s.event) === digest(expected))).toBe(true);
    const manifest = makeRoutedCredentialRecoveryManifest(snapshot.ownerDigest, snapshot.sources);
    expect(
      manifest.origins.flatMap((origin) => origin.files).filter((file) => file.destination?.endsWith('.json')),
    ).toEqual(
      expect.arrayContaining(
        f.profiles.map((p) =>
          expect.objectContaining({
            destination:
              (p.profile === 'mail_reader'
                ? 'google/calendar/mail-reader/credentials/'
                : p.profile === 'reader'
                  ? 'google/calendar/credentials/'
                  : 'google/calendar/writer-credentials/') +
              p.reference +
              '.json',
          }),
        ),
      ),
    );
    borrowed.push(...snapshot.sources.flatMap((source) => source.files.map((file) => file.bytes)));
    snapshot.assertPrimaryUnchanged();
    snapshot.assertCurrent();
  });
  expect(borrowed.length).toBeGreaterThan(20);
  expect(borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
});
it('matches the existing immutable mail configuration and permanent-denial recovery identities', async () => {
  const f = await fixture(),
    recorded: CredentialEvent[] = [];
  await recordMailRecoveryPage(f.roots, { assertAuthority: f.authority }, f.inspect, f.memory, async (change) => {
    recorded.push(makeCredentialEvent(change, f.owner));
  });
  await f.run(async (snapshot) => {
    for (const event of recorded)
      expect(snapshot.sources.some((source) => digest(source.event) === digest(event))).toBe(true);
  });
});
it('round-trips the actual full primary catalog through the queue and isolated archive reader', async () => {
  const f = await fixture(),
    queue = new BackupQueue(f.owner, async (_kind, operation) => operation(f.vault + '/journals'));
  const captured = await f.run(async (snapshot) => {
    const manifest = makeRoutedCredentialRecoveryManifest(snapshot.ownerDigest, snapshot.sources),
      expected = routedCredentialRecoveryFiles(manifest, f.owner);
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
    try {
      const payload = [manifestBytes, ...snapshot.sources.flatMap((source) => source.files.map((file) => file.bytes))];
      await queue.capture('credentials', manifest.operationId, async (sink) => {
        snapshot.assertCurrent();
        for (const file of expected) {
          const bytes = payload.find(
            (bytes) => bytes.length === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256,
          )!;
          expect(bytes).toBeDefined();
          sink.write(file.name, bytes);
        }
        snapshot.assertCurrent();
      });
      const receipt = (await queue.pending('credentials'))[0];
      verifyRoutedCredentialRecoveryReceipt(manifest, f.owner, receipt, snapshot.sources);
      return {
        manifest,
        expected,
        inventory: structuredClone(
          snapshot.sources.map(({ event, files }) => ({
            event,
            files: files.map(({ name, destination }) => ({ name, destination })),
          })),
        ),
      };
    } finally {
      manifestBytes.fill(0);
    }
  });
  const parts: Buffer[] = [];
  await queue.withPending('credentials', captured.manifest.operationId, async (directory, receipt) =>
    streamBackupArchive(directory, receipt, async (bytes) => {
      parts.push(Buffer.from(bytes));
    }),
  );
  async function* chunks() {
    for (const part of parts) yield part;
  }
  const recovered = new Map<string, Buffer[]>();
  const result = await readBackupArchive(
    chunks(),
    { ownerDigest: f.owner, kind: 'credentials', operationId: captured.manifest.operationId },
    {
      open: async (name) => {
        recovered.set(name, []);
        return {
          write: async (bytes) => {
            recovered.get(name)!.push(Buffer.from(bytes));
          },
          close: async () => {},
        };
      },
    },
    () => {},
  );
  const manifest = JSON.parse(Buffer.concat(recovered.get('credential-set.json')!).toString('utf8'));
  verifyRoutedCredentialRecoveryReceipt(manifest, f.owner, result.receipt, captured.inventory);
  for (const file of captured.expected)
    expect(
      createHash('sha256')
        .update(Buffer.concat(recovered.get(file.name)!))
        .digest('hex'),
    ).toBe(file.sha256);
  expect(fs.readdirSync(f.profiles[0].credentials).filter((name) => name.endsWith('.json'))).toEqual([
    f.profiles[0].reference + '.json',
  ]);
});
it('records absent optional profiles without initializing them or inferring account authority', async () => {
  const f = await fixture();
  fs.rmSync(f.calendar + '/mail-reader', { recursive: true });
  for (const name of ['writer-credentials', 'writer-access-denials', 'writer-oauth-client.json'])
    fs.rmSync(f.calendar + '/' + name, { recursive: true });
  await f.run(async (snapshot) => {
    expect(snapshot.sources).toHaveLength(5);
  });
  expect(fs.existsSync(f.calendar + '/mail-reader')).toBe(false);
});
for (const problem of [
  'partial-profile',
  'unknown-google',
  'unknown-backup',
  'missing-repository',
  'preparing-installation',
  'foreign-repository',
] as const)
  it(`refuses ${problem} state rather than presenting an incomplete primary catalog`, async () => {
    const f = await fixture(),
      callback = vi.fn();
    if (problem === 'partial-profile') fs.rmSync(f.calendar + '/writer-oauth-client.json');
    if (problem === 'unknown-google') fs.writeFileSync(f.calendar + '/unexpected-secret', 'PRIVATE', { mode: 0o600 });
    if (problem === 'unknown-backup') fs.writeFileSync(f.backup + '/unexpected-secret', 'PRIVATE', { mode: 0o600 });
    if (problem === 'missing-repository') fs.rmSync(f.backup + '/backup-repository.json');
    if (problem === 'preparing-installation') {
      const value = JSON.parse(fs.readFileSync(f.backup + '/backup-credential-installation.json', 'utf8'));
      writeAtomic(f.backup, 'backup-credential-installation.json', { ...value, phase: 'preparing' });
    }
    if (problem === 'foreign-repository') {
      const value = JSON.parse(fs.readFileSync(f.backup + '/backup-repository.json', 'utf8'));
      writeAtomic(f.backup, 'backup-repository.json', { ...value, rootsDigest: 'e'.repeat(64) });
    }
    await expect(f.run(callback)).rejects.toThrow('credential_vault_snapshot_unavailable');
    expect(callback).not.toHaveBeenCalled();
  });
for (const loss of ['memory', 'authority', 'directory', 'client'] as const)
  it(`checks ${loss} continuity during the borrowed snapshot and clears buffers after failure`, async () => {
    const f = await fixture(),
      borrowed: Buffer[] = [];
    await expect(
      f.run(async (snapshot) => {
        borrowed.push(...snapshot.sources.flatMap((s) => s.files.map((file) => file.bytes)));
        if (loss === 'memory' || loss === 'authority')
          f[loss].mockImplementation(() => {
            throw Error('PRIVATE_LOSS');
          });
        if (loss === 'directory') {
          fs.renameSync(f.profiles[0].credentials, f.profiles[0].credentials + '-held');
          fs.mkdirSync(f.profiles[0].credentials, { mode: 0o700 });
        }
        if (loss === 'client')
          writeAtomic(f.calendar, 'oauth-client.json', { clientId: 'changed.apps.googleusercontent.com' });
        await Promise.resolve();
        snapshot.assertCurrent();
      }),
    ).rejects.toThrow('credential_vault_snapshot_unavailable');
    expect(borrowed.length).toBeGreaterThan(0);
    expect(borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });
it('allows later legitimate tokens and denials while distinguishing an as-of snapshot from current primary coverage', async () => {
  const f = await fixture();
  await f.run(async (snapshot) => {
    const p = f.profiles[0];
    await p.ownerCore.install('scope', randomUUID(), randomUUID(), p.tokens);
    p.fences.deny('scope', randomUUID(), 'revoked');
    expect(snapshot.sources).toHaveLength(11);
    expect(() => snapshot.assertCurrent()).not.toThrow();
    expect(() => snapshot.assertPrimaryUnchanged()).toThrow('credential_vault_snapshot_unavailable');
  });
});
it('refuses a token replaced during collection before exposing any catalog', async () => {
  const f = await fixture(),
    read = fs.readSync,
    callback = vi.fn();
  let changed = false;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const result = read(...args);
    if (!changed && fs.readlinkSync('/proc/self/fd/' + args[0]).endsWith('/restic-password')) {
      changed = true;
      const p = f.profiles[0],
        value = JSON.parse(fs.readFileSync(p.credentials + '/' + p.reference + '.json', 'utf8'));
      writeAtomic(p.credentials, p.reference + '.json', { ...value, generation: value.generation + 1 });
    }
    return result;
  });
  await expect(f.run(callback)).rejects.toThrow('credential_vault_snapshot_unavailable');
  expect(callback).not.toHaveBeenCalled();
});
it('reports active access checks separately without promoting them to permanent credential sources', async () => {
  const f = await fixture(),
    p = f.profiles[0];
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const check = p.fences.runCheck('scope', randomUUID(), async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  try {
    await f.run(async (snapshot) => {
      expect(snapshot.openChecks).toBe(1);
      expect(snapshot.sources).toHaveLength(11);
    });
  } finally {
    release();
  }
  await check;
});
for (const link of ['symbolic', 'hard'] as const)
  it(`refuses a ${link} link to a permanent denial without changing it`, async () => {
    const f = await fixture(),
      p = f.profiles[0],
      name = fs.readdirSync(p.denial).find((name) => name.endsWith('.json'))!,
      file = p.denial + '/' + name,
      bytes = fs.readFileSync(file);
    if (link === 'hard') fs.linkSync(file, f.base + '/held');
    else {
      fs.renameSync(file, f.base + '/held');
      fs.symlinkSync(f.base + '/held', file);
    }
    await expect(f.run(vi.fn())).rejects.toThrow('credential_vault_snapshot_unavailable');
    expect(fs.readFileSync(file)).toEqual(bytes);
  });
for (const problem of [
  'denial-shape',
  'denial-time',
  'denial-marker',
  'pending-shape',
  'oversize-password',
  'shared-client',
] as const)
  it(`refuses ${problem} source state before exposing borrowed credentials`, async () => {
    const f = await fixture(),
      p = f.profiles[0],
      callback = vi.fn();
    if (problem === 'denial-shape' || problem === 'denial-time') {
      const name = fs.readdirSync(p.denial).find((name) => name.endsWith('.json'))!,
        value = JSON.parse(fs.readFileSync(p.denial + '/' + name, 'utf8'));
      writeAtomic(
        p.denial,
        name,
        problem === 'denial-shape' ? { ...value, authority: true } : { ...value, at: 'invalid' },
      );
    }
    if (problem === 'denial-marker') fs.writeFileSync(p.denial + '/.cos-calendar-fences', 'foreign');
    if (problem === 'pending-shape')
      writeAtomic(p.denial, 'f'.repeat(64) + '.json.pending', {
        version: 1,
        scopeDigest: 'd'.repeat(64),
        bindingId: randomUUID(),
      });
    if (problem === 'oversize-password') fs.writeFileSync(f.backup + '/restic-password', Buffer.alloc(129, 65));
    if (problem === 'shared-client')
      writeAtomic(f.calendar, 'writer-oauth-client.json', { clientId: 'reader-fixture.apps.googleusercontent.com' });
    await expect(f.run(callback)).rejects.toThrow('credential_vault_snapshot_unavailable');
    expect(callback).not.toHaveBeenCalled();
  });
