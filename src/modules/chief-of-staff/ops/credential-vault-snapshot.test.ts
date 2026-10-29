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
import { initializeMailDraftProfile } from '../mail-drafts/setup.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from '../mail-drafts/oauth.js';
import { recordMailRecoveryPage } from '../mail/recovery.js';
import { makeCredentialEvent, type CredentialEvent, type CredentialJournal } from './backup-credential-event.js';
import {
  recordVaultCredentialRecoveryPage,
  recordScheduledCredentialRecoveryPage,
} from './credential-recovery-page.js';
import {
  makeRoutedCredentialRecoveryManifest,
  routedCredentialRecoveryFiles,
  verifyRoutedCredentialRecoveryReceipt,
} from './credential-recovery-routing.js';
import { BackupQueue } from './backup-queue.js';
import { streamBackupArchive } from './backup-archive.js';
import { readBackupArchive } from './backup-archive-reader.js';
import { makeCredentialCapture, streamCredentialCapture, readCredentialCaptureArchive } from './credential-capture.js';
import { withVaultCredentialSnapshot } from './credential-vault-snapshot.js';
import { digest } from '../domain/contracts.js';
import { writeAtomic } from './target-state.js';
import { BackupRepositoryWriter } from './backup-repository-lease.js';
const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(includeDraft = false) {
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
  if (includeDraft)
    await initializeMailDraftProfile(
      roots,
      { clientId: 'draft-fixture.apps.googleusercontent.com' },
      { operationId: randomUUID(), assertAuthority: authority },
      inspect,
      memory,
    );
  const profiles = [],
    events: CredentialEvent[] = [];
  const configuredProfiles: OAuthScopeProfile[] = ['reader', 'owned_event_writer', 'mail_reader'];
  if (includeDraft) configuredProfiles.push('mail_draft_writer');
  for (const profile of configuredProfiles) {
    const root =
        profile === 'mail_reader'
          ? calendar + '/mail-reader'
          : profile === 'mail_draft_writer'
            ? calendar + '/mail-draft-writer'
            : calendar,
      credentials = root + (profile === 'owned_event_writer' ? '/writer-credentials' : '/credentials'),
      denial = root + (profile === 'owned_event_writer' ? '/writer-access-denials' : '/access-denials'),
      clientId =
        (profile === 'reader'
          ? 'reader'
          : profile === 'mail_reader'
            ? 'mail'
            : profile === 'mail_draft_writer'
              ? 'draft'
              : 'writer') + '-fixture.apps.googleusercontent.com';
    if (profile !== 'mail_reader' && profile !== 'mail_draft_writer') {
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
            : profile === 'mail_draft_writer'
              ? [GOOGLE_MAIL_DRAFT_SCOPE]
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
it('includes the complete separate draft-writer configuration, tokens and denial without changing the original profiles', async () => {
  const f = await fixture(true);
  await f.run(async (snapshot) => {
    expect(snapshot.sources).toHaveLength(14);
    const draft = snapshot.sources.filter((source) => source.event.sourceKind === 'mail_draft_writer');
    expect(draft).toHaveLength(3);
    expect(
      draft
        .flatMap((source) => source.files)
        .filter((file) => file.destination !== null)
        .every((file) => file.destination!.startsWith('google/calendar/mail-draft-writer/')),
    ).toBe(true);
    expect(
      draft
        .flatMap((source) => source.files)
        .some((file) => file.destination === 'google/calendar/mail-draft-writer/.cos-mail-draft-writer'),
    ).toBe(true);
    for (const expected of f.events)
      expect(snapshot.sources.some((source) => digest(source.event) === digest(expected))).toBe(true);
    expect(() => makeRoutedCredentialRecoveryManifest(f.owner, snapshot.sources)).not.toThrow();
    snapshot.assertPrimaryUnchanged();
  });
});
it('refuses a configured draft-writer profile whose independently owned proof is missing', async () => {
  const f = await fixture(true);
  fs.unlinkSync(f.calendar + '/mail-draft-writer/.cos-mail-draft-writer');
  await expect(f.run(async () => {})).rejects.toThrow('credential_vault_snapshot_unavailable');
});
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
it('captures credentials after repository initialization while preserving and excluding its kernel writer marker', async () => {
  const f = await fixture();
  const writer = new BackupRepositoryWriter(
    digest({ contract: 'cos-backup-initialization-writer/v1', fixture: f.owner }),
    async (operation) => operation(f.backup),
    '.cos-writer.lock',
  );
  await writer.exclusive(async (lease) => lease.assertCurrent());
  const marker = f.backup + '/.cos-writer.lock',
    before = fs.readFileSync(marker);
  await f.run(async (snapshot) => {
    expect(snapshot.sources).toHaveLength(11);
    expect(snapshot.sources.flatMap((source) => source.files).some((file) => file.name.includes('lock'))).toBe(false);
    snapshot.assertPrimaryUnchanged();
  });
  expect(fs.readFileSync(marker)).toEqual(before);
});
it.each(['linked', 'public', 'oversized', 'changed'])(
  'refuses an unsafe or changed initialization writer marker: %s',
  async (failure) => {
    const f = await fixture(),
      marker = f.backup + '/.cos-writer.lock';
    writeAtomic(f.backup, '.cos-writer.lock', { contract: 'cos-backup-repository-writer/v1', ownerDigest: f.owner });
    if (failure === 'linked') {
      fs.renameSync(marker, f.base + '/held-writer');
      fs.symlinkSync(f.base + '/held-writer', marker);
    }
    if (failure === 'public') fs.chmodSync(marker, 0o644);
    if (failure === 'oversized') fs.writeFileSync(marker, Buffer.alloc(16385));
    await expect(
      f.run(async (snapshot) => {
        if (failure === 'changed') fs.appendFileSync(marker, '\n');
        snapshot.assertPrimaryUnchanged();
      }),
    ).rejects.toThrow('credential_vault_snapshot_unavailable');
  },
);
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
it('streams the actual full primary catalog into a separate capture format without creating queue staging', async () => {
  const f = await fixture(),
    parts: Buffer[] = [];
  const capture = await f.run(async (snapshot) => {
    const capture = makeCredentialCapture(
      snapshot.ownerDigest,
      '2026-10-16T00:00:00.000Z',
      makeRoutedCredentialRecoveryManifest(snapshot.ownerDigest, snapshot.sources),
    );
    await streamCredentialCapture(snapshot, capture, async (bytes) => {
      parts.push(Buffer.from(bytes));
    });
    return capture;
  });
  expect(fs.readdirSync(f.vault + '/journals')).toEqual([]);
  async function* input() {
    for (const part of parts) yield part;
  }
  const recovered = await readCredentialCaptureArchive(
    input(),
    { ownerDigest: f.owner, operationId: capture.operationId },
    () => {},
  );
  expect(recovered.capture).toEqual(capture);
  expect(recovered.capture.set.contents.sources).toHaveLength(11);
  expect('receipt' in recovered).toBe(false);
});
it('journals actual non-token configuration and permanent denials once while preserving token-owner journals', async () => {
  const f = await fixture(),
    queue = new BackupQueue(f.owner, async (_kind, operation) => operation(f.vault + '/journals')),
    borrowed: Buffer[] = [];
  const journal: CredentialJournal = async (change, guard) => {
    borrowed.push(...change.files.map((file) => file.bytes));
    await queue.recordCredential(change, guard);
  };
  const run = () =>
    recordVaultCredentialRecoveryPage(f.roots, { assertAuthority: f.authority }, f.inspect, f.memory, journal);
  expect(await run()).toEqual({
    contract: 'cos-credential-recovery-page/v1',
    ownerDigest: f.owner,
    status: 'recorded',
    recorded: 8,
    next_after: null,
    open_checks: 0,
  });
  const first = await queue.pending('credentials');
  expect(first).toHaveLength(8);
  expect(first.flatMap((receipt) => receipt.files).some((file) => file.name === 'credential.json')).toBe(false);
  expect(await run()).toMatchObject({ recorded: 8, next_after: null });
  expect((await queue.pending('credentials')).map((receipt) => receipt.operationId).sort()).toEqual(
    first.map((receipt) => receipt.operationId).sort(),
  );
  expect(borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
});
it('pages every permanent denial with a bounded opaque cursor and wraps rather than starving earlier sources', async () => {
  const f = await fixture(),
    queue = new BackupQueue(f.owner, async (_kind, operation) => operation(f.vault + '/journals'));
  for (let index = 0; index < 13; index++) f.profiles[0].fences.deny('scope', randomUUID(), 'revoked');
  const journal: CredentialJournal = async (change, guard) => {
    await queue.recordCredential(change, guard);
  };
  const run = (after?: string) =>
    recordVaultCredentialRecoveryPage(
      f.roots,
      { assertAuthority: f.authority, ...(after === undefined ? {} : { after }) },
      f.inspect,
      f.memory,
      journal,
    );
  const first = await run();
  expect(first).toMatchObject({ recorded: 10, next_after: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const second = await run(first.next_after!);
  expect(second).toMatchObject({ recorded: 10, next_after: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await run(second.next_after!)).toMatchObject({ recorded: 1, next_after: null });
  expect(await queue.pending('credentials')).toHaveLength(21);
  expect(await run('f'.repeat(64))).toMatchObject({ recorded: 0, next_after: null });
  expect(await run()).toMatchObject({ recorded: 10 });
});
for (const loss of ['memory', 'authority', 'directory', 'queue'] as const)
  it(`holds existing work and clears borrowed page buffers after awaited ${loss} failure`, async () => {
    const f = await fixture(),
      queue = new BackupQueue(f.owner, async (_kind, operation) => operation(f.vault + '/journals')),
      borrowed: Buffer[] = [];
    const journal: CredentialJournal = async (change, guard) => {
      borrowed.push(...change.files.map((file) => file.bytes));
      await queue.recordCredential(change, guard);
      if (loss === 'memory' || loss === 'authority')
        f[loss].mockImplementation(() => {
          throw Error('PRIVATE_LOSS');
        });
      else if (loss === 'directory') {
        fs.renameSync(f.profiles[0].denial, f.profiles[0].denial + '-held');
        fs.mkdirSync(f.profiles[0].denial, { mode: 0o700 });
      } else throw Error('PRIVATE_QUEUE_CAPACITY');
      guard();
    };
    await expect(
      recordVaultCredentialRecoveryPage(f.roots, { assertAuthority: f.authority }, f.inspect, f.memory, journal),
    ).rejects.toThrow('credential_recovery_page_unavailable');
    expect(await queue.pending('credentials')).toHaveLength(1);
    expect(borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });
it('refuses path-shaped page cursors before reading credential state', async () => {
  const f = await fixture();
  f.authority.mockClear();
  await expect(
    recordVaultCredentialRecoveryPage(
      f.roots,
      { assertAuthority: f.authority, after: '../source' },
      f.inspect,
      f.memory,
      async () => {},
    ),
  ).rejects.toThrow('credential_recovery_page_unavailable');
  expect(f.authority).not.toHaveBeenCalled();
});
async function scheduledCursorFixture() {
  const f = await fixture(),
    queue = new BackupQueue(f.owner, async (_kind, operation) => operation(f.vault + '/journals'));
  for (let index = 0; index < 13; index++) f.profiles[0].fences.deny('scope', randomUUID(), 'revoked');
  const run = (releaseId = 'release-current', generation = 7) =>
    recordScheduledCredentialRecoveryPage(
      f.roots,
      { releaseId, generation, assertAuthority: f.authority },
      f.inspect,
      f.memory,
      async (change, guard) => {
        await queue.recordCredential(change, guard);
      },
    );
  return { f, run, file: f.vault + '/journals/credential-recovery-page.json' };
}
it('persists only an encrypted owner-bound cursor and wraps completed pages', async () => {
  const { f, run, file } = await scheduledCursorFixture();
  expect(await run()).toMatchObject({ recorded: 10, next_after: expect.any(String) });
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(first).toMatchObject({
    contract: 'cos-credential-recovery-cursor/v1',
    ownerDigest: f.owner,
    releaseId: 'release-current',
    generation: 7,
    after: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(await run()).toMatchObject({ recorded: 10 });
  expect(await run()).toMatchObject({ recorded: 1, next_after: null });
  expect(await run()).toMatchObject({ recorded: 10 });
});
it.each(['release', 'generation'] as const)(
  'restarts the scheduled cursor for a changed %s without adopting its old position',
  async (changed) => {
    const { run, file } = await scheduledCursorFixture(),
      first = await run();
    expect(first).toMatchObject({ recorded: 10, next_after: expect.any(String) });
    const release = changed === 'release' ? 'release-newer' : 'release-current',
      generation = changed === 'generation' ? 8 : 7;
    expect(await run(release, generation)).toEqual(first);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ releaseId: release, generation });
  },
);
for (const corruption of ['foreign-owner', 'linked', 'broad', 'extra-field', 'null-value'] as const)
  it(`holds a ${corruption} cursor instead of overwriting it or selecting foreign source paths`, async () => {
    const f = await fixture(),
      queue = new BackupQueue(f.owner, async (_kind, operation) => operation(f.vault + '/journals'));
    const run = () =>
      recordScheduledCredentialRecoveryPage(
        f.roots,
        { releaseId: 'release-current', generation: 7, assertAuthority: f.authority },
        f.inspect,
        f.memory,
        async (change, guard) => {
          await queue.recordCredential(change, guard);
        },
      );
    await run();
    const file = f.vault + '/journals/credential-recovery-page.json';
    if (corruption === 'linked') fs.linkSync(file, f.base + '/held-cursor');
    else if (corruption === 'broad') fs.chmodSync(file, 0o644);
    else if (corruption === 'null-value') fs.writeFileSync(file, 'null\n');
    else {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (corruption === 'foreign-owner') value.ownerDigest = 'f'.repeat(64);
      else value.authority = true;
      fs.writeFileSync(file, JSON.stringify(value) + '\n');
    }
    const before = fs.readFileSync(file),
      count = (await queue.pending('credentials')).length;
    await expect(run()).rejects.toThrow('credential_recovery_page_unavailable');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(await queue.pending('credentials')).toHaveLength(count);
  });
it('serializes scheduled cursor work with the actual live kernel writer and never duplicates source snapshots', async () => {
  const f = await fixture(),
    queue = new BackupQueue(f.owner, async (_kind, operation) => operation(f.vault + '/journals'));
  let entered!: () => void,
    release!: () => void,
    first = true;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const journal: CredentialJournal = async (change, guard) => {
    await queue.recordCredential(change, guard);
    if (first) {
      first = false;
      entered();
      await gate;
    }
    guard();
  };
  const run = () =>
    recordScheduledCredentialRecoveryPage(
      f.roots,
      { releaseId: 'release-current', generation: 7, assertAuthority: f.authority },
      f.inspect,
      f.memory,
      journal,
    );
  const pending = run();
  await ready;
  try {
    await expect(run()).rejects.toThrow('credential_recovery_page_unavailable');
  } finally {
    release();
  }
  expect(await pending).toMatchObject({ recorded: 8, next_after: null });
  expect(await queue.pending('credentials')).toHaveLength(8);
});
it('denies new cursor metadata before creating a writer when journal capacity has no reserved headroom', async () => {
  const f = await fixture(),
    directory = f.vault + '/journals',
    file = directory + '/filled-fixture';
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.ftruncateSync(fd, 128 * 1024 ** 2 - 32768);
  } finally {
    fs.closeSync(fd);
  }
  const journal = vi.fn<CredentialJournal>(async () => {});
  await expect(
    recordScheduledCredentialRecoveryPage(
      f.roots,
      { releaseId: 'release-current', generation: 7, assertAuthority: f.authority },
      f.inspect,
      f.memory,
      journal,
    ),
  ).rejects.toThrow('credential_recovery_page_unavailable');
  expect(journal).not.toHaveBeenCalled();
  expect(fs.existsSync(directory + '/credential-recovery-page.json')).toBe(false);
  expect(fs.existsSync(directory + '/.cos-writer.lock')).toBe(false);
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
