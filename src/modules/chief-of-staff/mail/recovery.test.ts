import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { recordMailRecoveryPage } from './recovery.js';
import { initializeMailProfile } from './setup.js';
import { configureVaultStorage, VAULT_DIRECTORIES } from '../ops/vault-storage.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { BackupQueue } from '../ops/backup-queue.js';
import type { CredentialJournal } from '../ops/backup-credential-event.js';
const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mail-recovery-'));
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
  fs.writeFileSync(
    vault + '/google/calendar/oauth-client.json',
    JSON.stringify({ clientId: 'calendar-recovery.apps.googleusercontent.com' }),
    { mode: 0o600 },
  );
  const authority = vi.fn(),
    memory = vi.fn();
  await initializeMailProfile(
    roots,
    { clientId: 'mail-recovery.apps.googleusercontent.com', clientSecret: 'PRIVATE_MAIL_RECOVERY_CLIENT' },
    { operationId: randomUUID(), assertAuthority: authority },
    inspect,
    memory,
  );
  const root = vault + '/google/calendar/mail-reader';
  const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(vault + '/journals'));
  const journal = vi.fn<CredentialJournal>(async (change, guard) => {
    await queue.recordCredential(change, guard);
  });
  const fences = new CalendarAccessFences(root + '/access-denials');
  const run = (after?: string, selected: CredentialJournal = journal) =>
    recordMailRecoveryPage(
      roots,
      { assertAuthority: authority, ...(after ? { after } : {}) },
      inspect,
      memory,
      selected,
    );
  return { base, roots, vault, root, authority, memory, inspect, queue, journal, fences, run };
}
it('queues private configuration and immutable denials once without copying token files or contacting the NAS', async () => {
  const f = await fixture();
  fs.writeFileSync(f.root + '/credentials/fixture-token.json', 'PRIVATE_TOKEN_ALREADY_HAS_ITS_OWN_JOURNAL', {
    mode: 0o600,
  });
  f.fences.deny('scope', randomUUID(), 'revoked');
  expect(await f.run()).toEqual({ status: 'recorded', recorded: 2, next_after: null, open_checks: 0 });
  const first = await f.queue.pending('credentials');
  expect(first).toHaveLength(2);
  const names = first.flatMap((item) => item.files.map((file) => file.name));
  expect(names).toContain('oauth-client.json');
  expect(names).toContain('access-denial.json');
  expect(names).not.toContain('fixture-token.json');
  expect(await f.run()).toEqual({ status: 'recorded', recorded: 2, next_after: null, open_checks: 0 });
  expect((await f.queue.pending('credentials')).map((x) => x.operationId).sort()).toEqual(
    first.map((x) => x.operationId).sort(),
  );
  for (const [change] of f.journal.mock.calls)
    for (const file of change.files) expect(file.bytes.every((byte) => byte === 0)).toBe(true);
});
it('pages all closed bindings and exposes only a checked hash cursor, without one source per poll', async () => {
  const f = await fixture();
  for (let n = 0; n < 13; n++) f.fences.deny('scope', randomUUID(), 'disconnected');
  const first = await f.run();
  expect(first.recorded).toBe(11);
  expect(first.next_after).toMatch(/^[a-f0-9]{64}\.json$/);
  const last = await f.run(first.next_after!);
  expect(last).toEqual({ status: 'recorded', recorded: 3, next_after: null, open_checks: 0 });
  expect(await f.queue.pending('credentials')).toHaveLength(14);
});
it('reports transient access checks without generating a snapshot source for every read poll', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const checking = f.fences.runCheck('scope', randomUUID(), async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  try {
    expect(await f.run()).toEqual({ status: 'recorded', recorded: 1, next_after: null, open_checks: 1 });
  } finally {
    release();
  }
  await checking;
  expect((await f.run()).open_checks).toBe(0);
  expect(await f.queue.pending('credentials')).toHaveLength(1);
});
for (const loss of ['authority', 'memory', 'profile', 'denials'] as const)
  it(`refuses an awaited ${loss} change and scrubs held snapshot bytes`, async () => {
    const f = await fixture();
    const journal = vi.fn<CredentialJournal>(async (_change, guard) => {
      if (loss === 'authority')
        f.authority.mockImplementation(() => {
          throw Error('PRIVATE_AUTHORITY');
        });
      else if (loss === 'memory')
        f.memory.mockImplementation(() => {
          throw Error('PRIVATE_MEMORY');
        });
      else {
        const root = loss === 'profile' ? f.root : f.root + '/access-denials';
        fs.renameSync(root, root + '-held');
        fs.mkdirSync(root, { mode: 0o700 });
      }
      guard();
    });
    await expect(f.run(undefined, journal)).rejects.toThrow('mail_recovery_snapshot_unavailable');
    for (const [change] of journal.mock.calls)
      for (const file of change.files) expect(file.bytes.every((byte) => byte === 0)).toBe(true);
  });
it('refuses malformed denial records rather than backing up arbitrary private files', async () => {
  const f = await fixture();
  const binding = randomUUID();
  f.fences.deny('scope', binding, 'expired');
  const name = fs.readdirSync(f.root + '/access-denials').find((x) => x.endsWith('.json'))!;
  fs.writeFileSync(f.root + '/access-denials/' + name, 'PRIVATE_MALFORMED_FILE');
  await expect(f.run()).rejects.toThrow('mail_recovery_snapshot_unavailable');
  expect(await f.queue.pending('credentials')).toHaveLength(1);
});
it('refuses linked denial records without changing their bytes', async () => {
  const f = await fixture();
  f.fences.deny('scope', randomUUID(), 'revoked');
  const name = fs.readdirSync(f.root + '/access-denials').find((x) => x.endsWith('.json'))!;
  const file = f.root + '/access-denials/' + name,
    before = fs.readFileSync(file);
  fs.linkSync(file, f.vault + '/held-denial');
  await expect(f.run()).rejects.toThrow('mail_recovery_snapshot_unavailable');
  expect(fs.readFileSync(file)).toEqual(before);
});
it('does not initialize a missing profile and rejects path-shaped paging input', async () => {
  const f = await fixture();
  await expect(f.run('../credentials')).rejects.toThrow('mail_recovery_snapshot_unavailable');
  fs.renameSync(f.root, f.root + '-held');
  expect(await f.run()).toEqual({ status: 'not_configured', recorded: 0, next_after: null, open_checks: 0 });
  expect(fs.existsSync(f.root)).toBe(false);
  expect((await f.queue.inspectDelivery('credentials')).items).toHaveLength(0);
});
it('rechecks the exact immutable denial file across the awaited queue call', async () => {
  const f = await fixture();
  f.fences.deny('scope', randomUUID(), 'expired');
  const name = fs.readdirSync(f.root + '/access-denials').find((x) => x.endsWith('.json'))!;
  const journal: CredentialJournal = async (change, guard) => {
    if (change.files.some((file) => file.name === 'access-denial.json'))
      fs.writeFileSync(f.root + '/access-denials/' + name, 'PRIVATE_CHANGED_DENIAL');
    guard();
  };
  await expect(f.run(undefined, journal)).rejects.toThrow('mail_recovery_snapshot_unavailable');
});
it('keeps primary credentials unchanged when encrypted queue recording fails', async () => {
  const f = await fixture();
  const before = fs.readFileSync(f.root + '/oauth-client.json');
  await expect(
    f.run(undefined, async () => {
      throw Error('PRIVATE_QUEUE_CAPACITY');
    }),
  ).rejects.toThrow('mail_recovery_snapshot_unavailable');
  expect(fs.readFileSync(f.root + '/oauth-client.json')).toEqual(before);
});
