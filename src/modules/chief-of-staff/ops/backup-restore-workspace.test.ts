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
it('checks the complete owned payload graph between awaits without borrowing another payload copy', async () => {
  const f = fixture();
  let expired!: () => void;
  await f.invoke(async (scope) => {
    const file = await scope.sink.open('tree/file', 6);
    await file.write(Buffer.from('secret'));
    expect(() => scope.assertPayloadCurrent()).toThrow(/^backup_restore_payload_unavailable$/);
    await file.close();
    scope.ensureDirectory('empty');
    scope.assertPayloadCurrent();
    await Promise.resolve();
    scope.assertPayloadCurrent();
    expired = scope.assertPayloadCurrent;
  });
  expect(fs.existsSync(f.destination)).toBe(false);
  expect(() => expired()).toThrow(/^backup_restore_payload_unavailable$/);
});
it.each(['content', 'missing', 'extra-file', 'extra-directory', 'parent', 'mode'])(
  'refuses complete payload continuity after an awaited %s change',
  async (kind) => {
    const f = fixture();
    await expect(
      f.invoke(async (scope) => {
        const file = await scope.sink.open('tree/file', 6);
        await file.write(Buffer.from('secret'));
        await file.close();
        scope.assertPayloadCurrent();
        await Promise.resolve();
        if (kind === 'content') fs.writeFileSync(scope.directory + '/tree/file', 'forged');
        if (kind === 'missing') fs.unlinkSync(scope.directory + '/tree/file');
        if (kind === 'extra-file') fs.writeFileSync(scope.directory + '/unclaimed', 'PRIVATE', { mode: 0o600 });
        if (kind === 'extra-directory') fs.mkdirSync(scope.directory + '/unclaimed', { mode: 0o700 });
        if (kind === 'parent') {
          fs.renameSync(scope.directory + '/tree', scope.directory + '/held');
          fs.mkdirSync(scope.directory + '/tree', { mode: 0o700 });
        }
        if (kind === 'mode') fs.chmodSync(scope.directory + '/tree/file', 0o644);
        expect(() => scope.assertPayloadCurrent()).toThrow(/^backup_restore_payload_unavailable$/);
      }),
    ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
    expect(fs.existsSync(f.destination)).toBe(true);
  },
);
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
it('tracks private empty history directories without adopting residue and removes its complete graph', async () => {
  const f = fixture();
  let expired!: () => void;
  await f.invoke(async (scope) => {
    scope.ensureDirectory('conversation-backup/history/empty');
    scope.ensureDirectory('conversation-backup/history/empty');
    expect(fs.readdirSync(scope.directory + '/conversation-backup/history')).toEqual(['empty']);
    expect(fs.statSync(scope.directory + '/conversation-backup/history/empty').mode & 0o7777).toBe(0o700);
    expired = () => scope.ensureDirectory('later');
  });
  expect(fs.existsSync(f.destination)).toBe(false);
  expect(() => expired()).toThrow();
});
it('charges missing empty directories before creating any of them', async () => {
  const f = fixture();
  await expect(f.invoke(async (scope) => scope.ensureDirectory('a/b'), 16384)).rejects.toThrow(
    /^backup_restore_workspace_unavailable$/,
  );
  expect(fs.existsSync(f.destination)).toBe(false);
});
it('holds unclaimed empty-directory residue instead of adding it to the owned graph', async () => {
  const f = fixture();
  await expect(
    f.invoke(async (scope) => {
      fs.mkdirSync(scope.directory + '/foreign', { mode: 0o700 });
      scope.ensureDirectory('foreign');
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.existsSync(f.destination + '/foreign')).toBe(true);
});
it.each(['../outside', '/outside', 'a//b', 'a/../b', 'a/.hidden'])(
  'rejects unsafe directory name %s before mutation',
  async (name) => {
    const f = fixture();
    await expect(f.invoke(async (scope) => scope.ensureDirectory(name))).rejects.toThrow(
      /^backup_restore_workspace_unavailable$/,
    );
    expect(fs.existsSync(f.destination)).toBe(false);
  },
);
it('reads only closed owned files, verifies streamed hashes and wipes borrowed validation buffers', async () => {
  const f = fixture();
  const payload = Buffer.alloc(150000, 0x41);
  let retained!: Buffer, expired!: () => void;
  await f.invoke(async (scope) => {
    const file = await scope.sink.open('native/snapshot', payload.length);
    for (let i = 0; i < payload.length; i += 65536) await file.write(payload.subarray(i, i + 65536));
    expect(() => scope.withFileBytes('native/snapshot', payload.length, () => {})).toThrow();
    await file.close();
    const proof = scope.inspectFile('native/snapshot');
    expect(proof).toMatchObject({
      file: 'native/snapshot',
      bytes: payload.length,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const result = scope.withFileBytes('native/snapshot', payload.length, (bytes) => {
      retained = bytes;
      expect(bytes).toEqual(payload);
      return 'checked';
    });
    expect(result).toBe('checked');
    expect(retained.every((byte) => byte === 0)).toBe(true);
    expired = () => scope.inspectFile('native/snapshot');
  }, 262144);
  expect(f.guard.mock.calls.length).toBeGreaterThan(30);
  expect(fs.existsSync(f.destination)).toBe(false);
  expect(() => expired()).toThrow();
});
it('enforces the validation allocation limit before calling the reader', async () => {
  const f = fixture();
  let called = false;
  await expect(
    f.invoke(async (scope) => {
      const file = await scope.sink.open('a', 6);
      await file.write(Buffer.from('secret'));
      await file.close();
      scope.withFileBytes('a', 5, () => {
        called = true;
      });
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(called).toBe(false);
  expect(fs.existsSync(f.destination)).toBe(false);
});
it('wipes borrowed recovery bytes even when the validator fails', async () => {
  const f = fixture();
  let retained!: Buffer;
  await expect(
    f.invoke(async (scope) => {
      const file = await scope.sink.open('a', 6);
      await file.write(Buffer.from('secret'));
      await file.close();
      scope.withFileBytes('a', 6, (bytes) => {
        retained = bytes;
        throw Error('PRIVATE');
      });
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(retained.every((byte) => byte === 0)).toBe(true);
  expect(fs.existsSync(f.destination)).toBe(false);
});
it('checks fresh caller permission after a synchronous validator and keeps withdrawn residue', async () => {
  const f = fixture();
  let retained!: Buffer;
  await expect(
    f.invoke(async (scope) => {
      const file = await scope.sink.open('a', 6);
      await file.write(Buffer.from('secret'));
      await file.close();
      scope.withFileBytes('a', 6, (bytes) => {
        retained = bytes;
        f.guard.mockImplementation(() => {
          throw Error('PRIVATE');
        });
      });
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(retained.every((byte) => byte === 0)).toBe(true);
  expect(fs.readFileSync(f.destination + '/a', 'utf8')).toBe('secret');
});
it('denies edited owned content before the validation callback and holds the changed graph', async () => {
  const f = fixture();
  let called = false;
  await expect(
    f.invoke(async (scope) => {
      const file = await scope.sink.open('a', 6);
      await file.write(Buffer.from('secret'));
      await file.close();
      fs.writeFileSync(scope.directory + '/a', 'edited');
      scope.withFileBytes('a', 6, () => {
        called = true;
      });
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(called).toBe(false);
  expect(fs.readFileSync(f.destination + '/a', 'utf8')).toBe('edited');
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
it('holds changed content even when the filesystem reports unchanged file timestamps', async () => {
  const f = fixture();
  await expect(
    f.invoke(async (scope) => {
      const file = await scope.sink.open('a', 6);
      await file.write(Buffer.from('secret'));
      await file.close();
      const before = fs.statSync(scope.directory + '/a');
      fs.writeFileSync(scope.directory + '/a', 'EDITED');
      const keepTimes = (value: fs.Stats) =>
        value.isFile() && value.ino === before.ino
          ? Object.assign(value, { mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs })
          : value;
      const lstat = fs.lstatSync,
        fstat = fs.fstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: unknown[]) =>
        keepTimes(Reflect.apply(lstat, fs, args))) as typeof fs.lstatSync);
      vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: unknown[]) =>
        keepTimes(Reflect.apply(fstat, fs, args))) as typeof fs.fstatSync);
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.readFileSync(f.destination + '/a', 'utf8')).toBe('EDITED');
});
