import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withIsolatedBackupRestore } from './backup-restore-workspace.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const requestId = '5f74b367-fd8f-449c-a832-dbe40cff9ae3';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-restore-workspace-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(root + '/live-sentinel', 'CURRENT_MESSAGES_COUNTERS_REVOCATIONS', { mode: 0o600 });
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW),
    guard = vi.fn(),
    destination = root + '/.cos-restore-' + requestId;
  const invoke = async <T>(operation: Parameters<typeof withIsolatedBackupRestore<T>>[4], budget = 65536) => {
    try {
      return await withIsolatedBackupRestore('/proc/self/fd/' + fd, requestId, budget, guard, operation);
    } finally {
      fs.closeSync(fd);
    }
  };
  return { root, fd, guard, destination, invoke };
}
it('writes only new private files through held descriptors and removes the verified isolated graph after checking', async () => {
  const f = fixture();
  let expired!: () => void;
  const result = await f.invoke(async (scope) => {
    const file = await scope.sink.open('coordinated/remote.json', 6);
    await file.write(Buffer.from('secret'));
    await file.close();
    const empty = await scope.sink.open('empty', 0);
    await empty.close();
    expect(fs.readFileSync(scope.directory + '/coordinated/remote.json', 'utf8')).toBe('secret');
    expect(fs.statSync(scope.directory + '/coordinated').mode & 0o777).toBe(0o700);
    expect(fs.statSync(scope.directory + '/coordinated/remote.json').mode & 0o777).toBe(0o600);
    scope.assertCurrent();
    expired = scope.assertCurrent;
    return 'verified';
  });
  expect(result).toBe('verified');
  expect(fs.existsSync(f.destination)).toBe(false);
  expect(fs.readFileSync(f.root + '/live-sentinel', 'utf8')).toBe('CURRENT_MESSAGES_COUNTERS_REVOCATIONS');
  expect(() => expired()).toThrow();
});
it('does not accept an ordinary filesystem path in place of the trusted vault descriptor', async () => {
  const f = fixture();
  try {
    await expect(withIsolatedBackupRestore(f.root, requestId, 65536, f.guard, async () => {})).rejects.toThrow(
      /^backup_restore_workspace_unavailable$/,
    );
  } finally {
    fs.closeSync(f.fd);
  }
  expect(fs.existsSync(f.destination)).toBe(false);
});
it('never adopts or overwrites an existing restore operation', async () => {
  const f = fixture();
  fs.mkdirSync(f.destination, { mode: 0o700 });
  fs.writeFileSync(f.destination + '/valuable', 'PRESERVE', { mode: 0o600 });
  await expect(
    f.invoke(async () => {
      throw Error('must_not_run');
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.readFileSync(f.destination + '/valuable', 'utf8')).toBe('PRESERVE');
});
it.each(['../outside', '/outside', 'a//b', 'a/../b', 'a/.hidden'])(
  'refuses unsafe file name %s before mutation',
  async (name) => {
    const f = fixture();
    await expect(
      f.invoke(async (scope) => {
        await scope.sink.open(name, 1);
      }),
    ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
    expect(fs.existsSync(f.destination)).toBe(false);
    expect(fs.readdirSync(f.root)).toEqual(['live-sentinel']);
  },
);
it('denies allocation before a file or its parents are created when the isolated budget is exhausted', async () => {
  const f = fixture();
  await expect(
    f.invoke(async (scope) => {
      await scope.sink.open('a/b/c', 1);
    }, 16384),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.existsSync(f.destination)).toBe(false);
});
it('does not charge already reserved output bytes again while streaming a file', async () => {
  const f = fixture();
  await f.invoke(async (scope) => {
    const file = await scope.sink.open('a', 1);
    await file.write(Buffer.from('a'));
    await file.close();
  }, 20480);
  expect(fs.existsSync(f.destination)).toBe(false);
});
it('uses actual current filesystem free space and preserves the vault reserve', async () => {
  const f = fixture();
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096n, bavail: 1n } as never);
  await expect(
    f.invoke(async () => {
      throw Error('must_not_run');
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.existsSync(f.destination)).toBe(false);
});
it('denies further payload bytes when actual filesystem headroom disappears during the restore', async () => {
  const f = fixture();
  await expect(
    f.invoke(async (scope) => {
      const file = await scope.sink.open('a', 6);
      await file.write(Buffer.from('first'));
      vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096n, bavail: 1n } as never);
      await file.write(Buffer.from('x'));
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.existsSync(f.destination)).toBe(false);
});
it('checks actual headroom after awaited verification before reporting success', async () => {
  const f = fixture();
  await expect(
    f.invoke(async (scope) => {
      const file = await scope.sink.open('a', 0);
      await file.close();
      await Promise.resolve();
      vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096n, bavail: 1n } as never);
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.existsSync(f.destination)).toBe(false);
});
it('a reported producer failure closes and retires only this invocation’s known private nodes', async () => {
  const f = fixture();
  await expect(
    f.invoke(async (scope) => {
      const file = await scope.sink.open('a/b', 100);
      await file.write(Buffer.from('partial'));
      throw Error('PRIVATE_DIAGNOSTIC');
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.existsSync(f.destination)).toBe(false);
  expect(fs.readdirSync(f.root)).toEqual(['live-sentinel']);
});
it('withdrawn permission stops further writes and holds the isolated residue without deleting live data', async () => {
  const f = fixture();
  await expect(
    f.invoke(async (scope) => {
      const file = await scope.sink.open('a', 10);
      await file.write(Buffer.from('first'));
      f.guard.mockImplementation(() => {
        throw Error('PRIVATE_WITHDRAWN');
      });
      await file.write(Buffer.from('later'));
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.readFileSync(f.destination + '/a', 'utf8')).toBe('first');
  expect(fs.readFileSync(f.root + '/live-sentinel', 'utf8')).toBe('CURRENT_MESSAGES_COUNTERS_REVOCATIONS');
});
it.each(['foreign', 'replacement', 'hardlink', 'edited'])(
  'holds a %s destination graph before any cleanup deletion',
  async (reason) => {
    const f = fixture();
    await expect(
      f.invoke(async (scope) => {
        const file = await scope.sink.open('a', 6);
        await file.write(Buffer.from('secret'));
        await file.close();
        if (reason === 'foreign') fs.writeFileSync(scope.directory + '/unknown', 'PRESERVE', { mode: 0o600 });
        if (reason === 'replacement') {
          fs.renameSync(scope.directory + '/a', scope.directory + '/old');
          fs.writeFileSync(scope.directory + '/a', 'PRESERVE', { mode: 0o600 });
        }
        if (reason === 'hardlink') fs.linkSync(scope.directory + '/a', f.root + '/linked');
        if (reason === 'edited') fs.writeFileSync(scope.directory + '/a', 'EDITED');
      }),
    ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
    expect(fs.existsSync(f.destination + '/a')).toBe(true);
  },
);
it('denies short, oversized and duplicate output rather than returning an incomplete workspace', async () => {
  for (const reason of ['short', 'oversized', 'duplicate']) {
    const f = fixture();
    await expect(
      f.invoke(async (scope) => {
        const file = await scope.sink.open('a', 6);
        if (reason === 'short') {
          await file.write(Buffer.from('short'));
          await file.close();
        }
        if (reason === 'oversized') await file.write(Buffer.from('toolong'));
        if (reason === 'duplicate') {
          await file.write(Buffer.from('secret'));
          await file.close();
          await scope.sink.open('a', 6);
        }
      }),
    ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
    expect(fs.existsSync(f.destination)).toBe(false);
  }
});
