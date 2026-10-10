import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { prepareBackupNasUnderlay } from './backup-nas-underlay.js';
import { withBackupNasRootJournal, type BackupNasRootJournalLease } from './backup-nas-root-journal.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-nas-root-journal-'));
  roots.push(root);
  const configRoot = path.join(root, 'config'),
    controlRoot = path.join(configRoot, 'control'),
    storageRoot = path.join(root, 'storage');
  for (const [directory, mode] of [
    [configRoot, 0o700],
    [controlRoot, 0o700],
    [storageRoot, 0o711],
  ] as const)
    fs.mkdirSync(directory, { mode });
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const vault = vaultRootConfiguration({
    contract: 'cos-vault-root-config/v2',
    authority: { operationId: randomUUID() },
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: 3 },
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const inode = (directory: string) => {
    const stat = fs.lstatSync(directory);
    return { device: stat.dev, inode: stat.ino };
  };
  const bootstrap = {
    contract: 'cos-vault-root-state/v1',
    identityDigest: vaultRootStateDigest(vault),
    phase: 'complete',
    claims: { control: inode(controlRoot), storage: inode(storageRoot) },
  };
  const nas = {
    contract: 'cos-backup-nas-root-config/v1' as const,
    host: '192.168.56.12',
    credentialReference: randomUUID(),
    vaultStateDigest: vaultRootStateDigest(vault),
  };
  const bootstrapFile = path.join(configRoot, 'vault-bootstrap.json'),
    nasFile = path.join(configRoot, 'backup-nas.json'),
    journalFile = path.join(controlRoot, 'nas-mount.json');
  fs.writeFileSync(bootstrapFile, JSON.stringify(bootstrap), { mode: 0o600 });
  fs.writeFileSync(nasFile, JSON.stringify(nas), { mode: 0o600 });
  const controls = {
    paths: { configRoot, controlRoot, storageRoot, mount: path.join(storageRoot, 'nas') },
    assertMemory: vi.fn(),
    assertAuthority: vi.fn(async () => {}),
  };
  const initial = await prepareBackupNasUnderlay(vault, nas, { ...controls, isMounted: () => false });
  controls.assertAuthority.mockClear();
  return { root, vault, nas, initial, controls, bootstrap, bootstrapFile, nasFile, journalFile };
}
it('holds real root claims and kernel writer while durably replacing only the claimed journal', async () => {
  const s = await fixture(),
    before = fs.readFileSync(s.bootstrapFile),
    nasBefore = fs.readFileSync(s.nasFile);
  let released!: BackupNasRootJournalLease;
  const attemptId = randomUUID();
  await withBackupNasRootJournal(
    s.vault,
    s.nas,
    async (lease) => {
      released = lease;
      expect(lease.readJournal()).toEqual(s.initial);
      await lease.writeJournal({ ...s.initial, phase: 'mounting', attemptId });
      expect(lease.readJournal()).toEqual({ ...s.initial, phase: 'mounting', attemptId });
      await lease.assertCurrent();
      const stat = fs.lstatSync(s.journalFile);
      expect(stat.uid).toBe(0);
      expect(stat.mode & 0o7777).toBe(0o600);
      expect(stat.nlink).toBe(1);
      expect(fs.readdirSync(s.controls.paths.controlRoot).sort()).toEqual(['nas-mount.json', 'repository.lock']);
    },
    s.controls,
  );
  expect(fs.readFileSync(s.bootstrapFile).equals(before)).toBe(true);
  expect(fs.readFileSync(s.nasFile).equals(nasBefore)).toBe(true);
  expect(() => released.readJournal()).toThrow(/^backup_nas_root_journal_unavailable$/);
  await expect(released.assertCurrent()).rejects.toThrow(/^backup_nas_root_journal_unavailable$/);
});
it('refuses a competing real kernel writer without stealing its live lease', async () => {
  const s = await fixture(),
    effect = vi.fn(async () => {});
  await withBackupNasRootJournal(
    s.vault,
    s.nas,
    async (lease) => {
      await expect(withBackupNasRootJournal(s.vault, s.nas, effect, s.controls)).rejects.toThrow(
        /^backup_nas_root_journal_unavailable$/,
      );
      expect(effect).not.toHaveBeenCalled();
      await lease.assertCurrent();
    },
    s.controls,
  );
  await withBackupNasRootJournal(s.vault, s.nas, effect, s.controls);
  expect(effect).toHaveBeenCalledTimes(1);
});
it.each([
  'missing-journal',
  'journal-link',
  'journal-hardlink',
  'journal-owner',
  'journal-mode',
  'journal-bounds',
  'journal-scope',
  'bootstrap-phase',
  'bootstrap-claim',
  'nas-scope',
  'parent',
  'authority',
  'memory',
])('denies initial %s without creating or repairing resources', async (reason) => {
  const s = await fixture(),
    effect = vi.fn(async () => {});
  if (reason === 'missing-journal') fs.unlinkSync(s.journalFile);
  if (reason === 'journal-link') {
    fs.renameSync(s.journalFile, s.journalFile + '-old');
    fs.symlinkSync(s.journalFile + '-old', s.journalFile);
  }
  if (reason === 'journal-hardlink') fs.linkSync(s.journalFile, s.journalFile + '-other');
  if (reason === 'journal-owner') fs.chownSync(s.journalFile, 1000, 1000);
  if (reason === 'journal-mode') fs.chmodSync(s.journalFile, 0o644);
  if (reason === 'journal-bounds') fs.writeFileSync(s.journalFile, 'x'.repeat(4097));
  if (reason === 'journal-scope')
    fs.writeFileSync(s.journalFile, JSON.stringify({ ...s.initial, configurationDigest: 'f'.repeat(64) }));
  if (reason === 'bootstrap-phase')
    fs.writeFileSync(s.bootstrapFile, JSON.stringify({ ...s.bootstrap, phase: 'intent' }));
  if (reason === 'bootstrap-claim')
    fs.writeFileSync(
      s.bootstrapFile,
      JSON.stringify({ ...s.bootstrap, claims: { ...s.bootstrap.claims, storage: { device: 1, inode: 1 } } }),
    );
  if (reason === 'nas-scope')
    fs.writeFileSync(s.nasFile, JSON.stringify({ ...s.nas, credentialReference: randomUUID() }));
  if (reason === 'parent') fs.chmodSync(s.controls.paths.storageRoot, 0o777);
  if (reason === 'authority') s.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
  if (reason === 'memory')
    s.controls.assertMemory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  await expect(withBackupNasRootJournal(s.vault, s.nas, effect, s.controls)).rejects.toThrow(
    /^backup_nas_root_journal_unavailable$/,
  );
  expect(effect).not.toHaveBeenCalled();
  if (reason === 'missing-journal') expect(fs.existsSync(s.journalFile)).toBe(false);
});
it.each(['journal-replace', 'journal-byte', 'nas-replace', 'bootstrap-byte', 'parent-replace', 'authority'])(
  'rejects %s after an awaited operation before any next journal effect',
  async (reason) => {
    const s = await fixture(),
      before = fs.readFileSync(s.journalFile);
    await expect(
      withBackupNasRootJournal(
        s.vault,
        s.nas,
        async (lease) => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (reason === 'journal-replace') {
            fs.renameSync(s.journalFile, s.journalFile + '-old');
            fs.writeFileSync(s.journalFile, before, { mode: 0o600 });
          }
          if (reason === 'journal-byte')
            fs.writeFileSync(
              s.journalFile,
              JSON.stringify({ ...s.initial, phase: 'mounting', attemptId: randomUUID() }),
            );
          if (reason === 'nas-replace') {
            fs.renameSync(s.nasFile, s.nasFile + '-old');
            fs.writeFileSync(s.nasFile, JSON.stringify(s.nas), { mode: 0o600 });
          }
          if (reason === 'bootstrap-byte')
            fs.writeFileSync(s.bootstrapFile, JSON.stringify({ ...s.bootstrap, phase: 'intent' }));
          if (reason === 'parent-replace') {
            fs.renameSync(s.controls.paths.storageRoot, s.controls.paths.storageRoot + '-old');
            fs.mkdirSync(s.controls.paths.storageRoot, { mode: 0o711 });
          }
          if (reason === 'authority') s.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
          await lease.writeJournal({ ...s.initial, phase: 'mounting', attemptId: randomUUID() });
        },
        s.controls,
      ),
    ).rejects.toThrow(/^backup_nas_root_journal_unavailable$/);
    if (reason !== 'journal-byte') expect(fs.readFileSync(s.journalFile).equals(before)).toBe(true);
  },
);
it('never changes the original underlay identity through a journal update', async () => {
  const s = await fixture(),
    before = fs.readFileSync(s.journalFile);
  await expect(
    withBackupNasRootJournal(
      s.vault,
      s.nas,
      async (lease) => {
        await lease.writeJournal({
          ...s.initial,
          underlay: { ...s.initial.underlay, inode: s.initial.underlay.inode + 1 },
        });
      },
      s.controls,
    ),
  ).rejects.toThrow(/^backup_nas_root_journal_unavailable$/);
  expect(fs.readFileSync(s.journalFile).equals(before)).toBe(true);
});
it('denies overlapping writes and terminates their owned work before releasing the root scope', async () => {
  const s = await fixture(),
    before = fs.readFileSync(s.journalFile);
  await expect(
    withBackupNasRootJournal(
      s.vault,
      s.nas,
      async (lease) => {
        let resume!: () => void;
        s.controls.assertAuthority.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resume = resolve;
            }),
        );
        const first = lease.writeJournal({ ...s.initial, phase: 'mounting', attemptId: randomUUID() });
        void first.catch(() => {});
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          await expect(
            lease.writeJournal({ ...s.initial, phase: 'mounting', attemptId: randomUUID() }),
          ).rejects.toThrow(/^backup_nas_root_journal_unavailable$/);
        } finally {
          resume();
        }
        await expect(first).rejects.toThrow(/^backup_nas_root_journal_unavailable$/);
      },
      s.controls,
    ),
  ).rejects.toThrow(/^backup_nas_root_journal_unavailable$/);
  expect(fs.readFileSync(s.journalFile).equals(before)).toBe(true);
  expect(fs.readdirSync(s.controls.paths.controlRoot).sort()).toEqual(['nas-mount.json', 'repository.lock']);
});
it('does not acknowledge a callback that leaves a journal update awaiting fresh authority', async () => {
  const s = await fixture(),
    before = fs.readFileSync(s.journalFile);
  let pending!: Promise<void>;
  await expect(
    withBackupNasRootJournal(
      s.vault,
      s.nas,
      async (lease) => {
        s.controls.assertAuthority.mockImplementationOnce(() => new Promise<void>((resolve) => setImmediate(resolve)));
        pending = lease.writeJournal({ ...s.initial, phase: 'mounting', attemptId: randomUUID() });
        void pending.catch(() => {});
      },
      s.controls,
    ),
  ).rejects.toThrow(/^backup_nas_root_journal_unavailable$/);
  await expect(pending).rejects.toThrow(/^backup_nas_root_journal_unavailable$/);
  expect(fs.readFileSync(s.journalFile).equals(before)).toBe(true);
});
it('requires file and parent sync before acknowledging a replacement, and repeats sync on re-entry', async () => {
  const s = await fixture();
  const attemptId = randomUUID();
  await withBackupNasRootJournal(
    s.vault,
    s.nas,
    async (lease) => {
      const sync = fs.fsyncSync;
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        if (fs.readlinkSync('/proc/self/fd/' + fd) === s.controls.paths.controlRoot)
          throw Error('PRIVATE_DIRECTORY_SYNC');
        return sync(fd);
      });
      await expect(lease.writeJournal({ ...s.initial, phase: 'mounting', attemptId })).rejects.toThrow(
        /^backup_nas_root_journal_unavailable$/,
      );
      expect(() => lease.readJournal()).toThrow(/^backup_nas_root_journal_unavailable$/);
    },
    s.controls,
  ).catch((error: Error) => expect(error.message).toBe('backup_nas_root_journal_unavailable'));
  vi.restoreAllMocks();
  const synced: string[] = [],
    sync = fs.fsyncSync;
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    synced.push(fs.readlinkSync('/proc/self/fd/' + fd));
    return sync(fd);
  });
  await withBackupNasRootJournal(
    s.vault,
    s.nas,
    async (lease) => expect(lease.readJournal()).toEqual({ ...s.initial, phase: 'mounting', attemptId }),
    s.controls,
  );
  expect(synced).toContain(s.journalFile);
  expect(synced).toContain(s.controls.paths.controlRoot);
});
