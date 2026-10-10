import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { withBackupNasInitializationRetirementJournal } from './backup-nas-initialization-retirement-journal.js';
import type {
  BackupNasInitializationRetirementJournal,
  BackupNasInitializationRetirementScope,
} from './backup-nas-initialization-retirement-state.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const denied = /^backup_nas_initialization_retirement_journal_unavailable$/;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-nas-retirement-journal-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const scope: BackupNasInitializationRetirementScope = {
    nasDigest: 'a'.repeat(64),
    vaultStateDigest: 'b'.repeat(64),
    resource: {
      kind: 'configuration-stage',
      stageId: randomUUID(),
      device: 1,
      inode: 2,
      contentDigest: 'c'.repeat(64),
    },
  };
  const filename = root + '/nas-initialization-retirement.' + digest(scope) + '.json';
  const controls = { controlFd: fd, assertAuthority: vi.fn(async () => {}), assertMemory: vi.fn() };
  const record = (phase: 'retiring' | 'retired'): BackupNasInitializationRetirementJournal => ({
    contract: 'cos-backup-nas-initialization-retirement/v1',
    ...scope,
    phase,
  });
  return { root, fd, scope, filename, controls, record };
}
it('publishes and replaces only the private fixed journal and syncs its file and parent before returning', async () => {
  const f = fixture(),
    sync = vi.spyOn(fs, 'fsyncSync');
  try {
    expect(process.getuid?.()).toBe(0);
    await withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) => {
      expect(lease.readJournal()).toBeNull();
      await lease.writeJournal(f.record('retiring'));
      expect(lease.readJournal()).toEqual(f.record('retiring'));
      const first = fs.lstatSync(f.filename);
      expect(first.uid).toBe(0);
      expect(first.mode & 0o7777).toBe(0o600);
      expect(first.nlink).toBe(1);
      await lease.writeJournal(f.record('retired'));
      expect(lease.readJournal()).toEqual(f.record('retired'));
      expect(fs.lstatSync(f.filename).ino).not.toBe(first.ino);
    });
    expect(fs.readdirSync(f.root)).toEqual([path.basename(f.filename)]);
    expect(sync.mock.calls.length).toBeGreaterThanOrEqual(6);
  } finally {
    fs.closeSync(f.fd);
  }
});
it('repeats durability of an existing exact journal before exposing it to a retry', async () => {
  const f = fixture();
  fs.writeFileSync(f.filename, JSON.stringify(f.record('retiring')), { mode: 0o600 });
  const before = fs.lstatSync(f.filename),
    sync = vi.spyOn(fs, 'fsyncSync');
  try {
    await withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) => {
      expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2);
      const value = lease.readJournal();
      expect(value).toEqual(f.record('retiring'));
      expect(Object.isFrozen(value)).toBe(true);
      await lease.assertCurrent();
    });
    expect(fs.lstatSync(f.filename).ino).toBe(before.ino);
  } finally {
    fs.closeSync(f.fd);
  }
});
it('recovers an interrupted first publication only by its exact private temporary alias under fresh permission', async () => {
  const f = fixture(),
    alias = f.root + '/.nas-initialization-retirement.' + randomUUID() + '.tmp';
  fs.writeFileSync(f.filename, JSON.stringify(f.record('retiring')), { mode: 0o600 });
  fs.linkSync(f.filename, alias);
  const before = fs.lstatSync(f.filename),
    unlink = fs.unlinkSync;
  let effect = false;
  vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    if (String(file).endsWith('/' + path.basename(alias))) {
      effect = true;
      expect(f.controls.assertAuthority.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(fs.lstatSync(f.filename).ino).toBe(before.ino);
    }
    unlink(file);
  });
  try {
    await withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) => {
      expect(lease.readJournal()).toEqual(f.record('retiring'));
      expect(fs.lstatSync(f.filename).nlink).toBe(1);
      expect(fs.existsSync(alias)).toBe(false);
    });
    expect(effect).toBe(true);
    expect(fs.lstatSync(f.filename).ino).toBe(before.ino);
  } finally {
    fs.closeSync(f.fd);
  }
});
it('retries a failed temporary unlink during initial publication without replacing the published journal', async () => {
  const f = fixture(),
    original = fs.unlinkSync;
  const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    if (String(file).includes('/.nas-initialization-retirement.')) throw Error('PRIVATE_INTERRUPTED_UNLINK');
    original(file);
  });
  try {
    await expect(
      withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) =>
        lease.writeJournal(f.record('retiring')),
      ),
    ).rejects.toThrow(denied);
    const before = fs.lstatSync(f.filename);
    expect(before.nlink).toBe(2);
    unlink.mockRestore();
    await withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) =>
      expect(lease.readJournal()).toEqual(f.record('retiring')),
    );
    expect(fs.lstatSync(f.filename).ino).toBe(before.ino);
    expect(fs.lstatSync(f.filename).nlink).toBe(1);
    expect(fs.readdirSync(f.root)).toEqual([path.basename(f.filename)]);
  } finally {
    fs.closeSync(f.fd);
  }
});
it.each(['foreign-name', 'two-aliases', 'changed-alias', 'permission'])(
  'refuses %s publication recovery and preserves uncertain metadata',
  async (reason) => {
    const f = fixture(),
      alias = f.root + '/.nas-initialization-retirement.' + randomUUID() + '.tmp';
    fs.writeFileSync(f.filename, JSON.stringify(f.record('retiring')), { mode: 0o600 });
    fs.linkSync(f.filename, alias);
    if (reason === 'foreign-name') fs.renameSync(alias, f.filename + '.keep');
    if (reason === 'two-aliases')
      fs.linkSync(f.filename, f.root + '/.nas-initialization-retirement.' + randomUUID() + '.tmp');
    if (reason === 'permission') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_REVOKED'));
    if (reason === 'changed-alias') {
      let calls = 0;
      f.controls.assertAuthority.mockImplementation(async () => {
        if (++calls === 2) fs.renameSync(alias, f.filename + '.keep');
      });
    }
    try {
      await expect(
        withBackupNasInitializationRetirementJournal(f.scope, f.controls, async () => undefined),
      ).rejects.toThrow(denied);
      expect(fs.lstatSync(f.filename).nlink).toBe(reason === 'two-aliases' ? 3 : 2);
      expect(JSON.parse(fs.readFileSync(f.filename, 'utf8'))).toEqual(f.record('retiring'));
    } finally {
      fs.closeSync(f.fd);
    }
  },
);
it.each([
  'parent-mode',
  'parent-owner',
  'file-mode',
  'file-owner',
  'symlink',
  'hardlink',
  'partial',
  'oversized',
  'scope',
  'resource',
  'selector',
  'permission',
  'memory',
])('refuses %s without changing the journal', async (reason) => {
  const f = fixture();
  let record: unknown = f.record('retiring');
  if (reason === 'scope') record = { ...f.record('retiring'), nasDigest: 'd'.repeat(64) };
  if (reason === 'resource') record = { ...f.record('retiring'), resource: { ...f.scope.resource, inode: 3 } };
  if (reason === 'selector') record = { ...f.record('retiring'), path: '/tmp/foreign' };
  fs.writeFileSync(
    f.filename,
    reason === 'partial' ? '{' : reason === 'oversized' ? 'x'.repeat(4097) : JSON.stringify(record),
    { mode: 0o600 },
  );
  if (reason === 'parent-mode') fs.chmodSync(f.root, 0o755);
  if (reason === 'parent-owner') fs.chownSync(f.root, 1000, 1000);
  if (reason === 'file-mode') fs.chmodSync(f.filename, 0o644);
  if (reason === 'file-owner') fs.chownSync(f.filename, 1000, 1000);
  if (reason === 'symlink') {
    fs.renameSync(f.filename, f.filename + '.keep');
    fs.symlinkSync(f.filename + '.keep', f.filename);
  }
  if (reason === 'hardlink') fs.linkSync(f.filename, f.filename + '.keep');
  if (reason === 'permission') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_PROOF'));
  if (reason === 'memory')
    f.controls.assertMemory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  const before = fs.readFileSync(f.filename);
  try {
    await expect(withBackupNasInitializationRetirementJournal(f.scope, f.controls, async () => 'BAD')).rejects.toThrow(
      denied,
    );
    expect(fs.readFileSync(f.filename)).toEqual(before);
  } finally {
    fs.closeSync(f.fd);
  }
});
it.each(['replacement', 'bytes', 'new-file', 'parent-mode', 'revocation'])(
  'refuses %s across a fresh permission boundary',
  async (reason) => {
    const f = fixture();
    if (reason !== 'new-file') fs.writeFileSync(f.filename, JSON.stringify(f.record('retiring')), { mode: 0o600 });
    try {
      await expect(
        withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) => {
          f.controls.assertAuthority.mockImplementationOnce(async () => {
            if (reason === 'replacement') {
              fs.renameSync(f.filename, f.filename + '.keep');
              fs.writeFileSync(f.filename, JSON.stringify(f.record('retiring')), { mode: 0o600 });
            }
            if (reason === 'bytes') fs.writeFileSync(f.filename, JSON.stringify(f.record('retired')));
            if (reason === 'new-file')
              fs.writeFileSync(f.filename, JSON.stringify(f.record('retiring')), { mode: 0o600 });
            if (reason === 'parent-mode') fs.chmodSync(f.root, 0o755);
            if (reason === 'revocation') throw Error('PRIVATE_REVOKED');
          });
          await lease.assertCurrent();
        }),
      ).rejects.toThrow(denied);
    } finally {
      fs.closeSync(f.fd);
    }
  },
);
it('does not acknowledge a failed publication sync and repeats durability with fresh permission on retry', async () => {
  const f = fixture(),
    original = fs.fsyncSync;
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.existsSync(f.filename)) throw Error('PRIVATE_SYNC');
    original(fd);
  });
  try {
    await expect(
      withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) =>
        lease.writeJournal(f.record('retiring')),
      ),
    ).rejects.toThrow(denied);
    expect(JSON.parse(fs.readFileSync(f.filename, 'utf8'))).toEqual(f.record('retiring'));
    sync.mockRestore();
    await withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) => {
      expect(lease.readJournal()).toEqual(f.record('retiring'));
    });
  } finally {
    fs.closeSync(f.fd);
  }
});
it('denies overlapping or detached writes and closes retained callbacks after the operation', async () => {
  const f = fixture();
  let retained: (() => Promise<void>) | undefined;
  try {
    await expect(
      withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) => {
        retained = lease.assertCurrent;
        const first = lease.writeJournal(f.record('retiring'));
        await expect(lease.writeJournal(f.record('retired'))).rejects.toThrow(denied);
        await first.catch(() => {});
      }),
    ).rejects.toThrow(denied);
    await expect(retained!()).rejects.toThrow(denied);
    await expect(
      withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) => {
        void lease.writeJournal(f.record('retiring')).catch(() => {});
      }),
    ).rejects.toThrow(denied);
  } finally {
    fs.closeSync(f.fd);
  }
});
it('preserves foreign temporary files and independently scoped journals', async () => {
  const f = fixture(),
    keep = f.root + '/.nas-initialization-retirement.foreign.tmp';
  fs.writeFileSync(keep, 'KEEP', { mode: 0o600 });
  try {
    await withBackupNasInitializationRetirementJournal(f.scope, f.controls, async (lease) =>
      lease.writeJournal(f.record('retiring')),
    );
    expect(fs.readFileSync(keep, 'utf8')).toBe('KEEP');
    const next = { ...f.scope, resource: { ...f.scope.resource, inode: 3 } };
    await withBackupNasInitializationRetirementJournal(next, f.controls, async (lease) => {
      expect(lease.readJournal()).toBeNull();
    });
    expect(fs.readFileSync(keep, 'utf8')).toBe('KEEP');
  } finally {
    fs.closeSync(f.fd);
  }
});
