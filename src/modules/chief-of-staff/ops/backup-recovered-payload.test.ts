import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { captureNativeDatabase, verifyRecoveredNativeDatabase } from './backup-native.js';
import {
  capturePrivateHistory,
  verifyRecoveredPrivateHistory,
  verifyPrivateHistory,
} from './private-history-backup.js';
import { BackupQueue, type BackupQueueReceipt } from './backup-queue.js';
import { streamBackupArchive } from './backup-archive.js';
import { readBackupArchive } from './backup-archive-reader.js';
import type { IsolatedBackupRestore } from './backup-restore-workspace.js';

const roots: string[] = [],
  owner = 'a'.repeat(64),
  operationId = '9f99d9b4-4dac-423a-956c-afd953993c2d',
  requestId = '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
  generation = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-recovered-payload-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  for (const name of ['state', 'credentials', 'source']) fs.mkdirSync(root + '/' + name, { mode: 0o700 });
  const queue = new BackupQueue(owner, async (kind, callback) => callback(root + '/' + kind)),
    guard = vi.fn(),
    files = new Map<string, Buffer>(),
    sink = {
      write: (name: string, bytes: Buffer) => {
        files.set(name, Buffer.concat([files.get(name) ?? Buffer.alloc(0), bytes]));
      },
    };
  const recover = async <T>(
    validate: (scope: IsolatedBackupRestore, entries: BackupQueueReceipt['files']) => Promise<T>,
    diagnostics = false,
  ) => {
    await queue.capture(
      'state',
      operationId,
      async (output) => {
        for (const [name, bytes] of files) output.write(name, bytes);
      },
      1024 ** 2,
    );
    const parts: Buffer[] = [];
    await queue.withPending('state', operationId, async (directory, receipt) => {
      await streamBackupArchive(directory, receipt, async (bytes) => {
        parts.push(Buffer.from(bytes));
      });
    });
    const archive = Buffer.concat(parts),
      before = await queue.pending('state');
    let validationError: unknown;
    try {
      return await queue.withRestoreWorkspace(requestId, guard, async (scope) => {
        const source = {
          async *[Symbol.asyncIterator]() {
            for (let offset = 0; offset < archive.length; offset += 65536)
              yield Buffer.from(archive.subarray(offset, offset + 65536));
          },
        };
        const read = await readBackupArchive(
          source,
          { ownerDigest: owner, kind: 'state', operationId },
          scope.sink,
          scope.assertCurrent,
        );
        try {
          return await validate(scope, read.receipt.files);
        } catch (error) {
          validationError = error;
          throw error;
        }
      });
    } catch (error) {
      if (diagnostics && validationError) throw validationError;
      throw error;
    } finally {
      archive.fill(0);
      expect(await queue.pending('state')).toEqual(before);
    }
  };
  return { root, queue, guard, files, sink, recover };
}
function nativeFixture() {
  const f = fixture(),
    source = f.root + '/source/native.db',
    live = new Database(source);
  live.pragma('journal_mode=WAL');
  live.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages VALUES(1,'old');");
  const capture = captureNativeDatabase(source, f.sink, 'coordinated/sqlite/0', 65536);
  live.exec("INSERT INTO messages VALUES(2,'later message');");
  return { ...f, source, live, capture };
}
it('checks recovered native SQLite in read-only memory, preserving newer messages and creating no sidecars', async () => {
  const f = nativeFixture();
  try {
    const result = await f.recover(async (scope) => {
      const checked = verifyRecoveredNativeDatabase(scope, f.capture);
      expect(fs.readdirSync(scope.directory + '/coordinated/sqlite/0').sort()).toEqual([
        'native-backup.json',
        'native.sqlite',
      ]);
      expect(
        scope.withFileBytes(f.capture.file, 65536, (bytes) => {
          const db = new Database(bytes, { readonly: true });
          try {
            return db.prepare('SELECT * FROM messages').all();
          } finally {
            db.close();
          }
        }),
      ).toEqual([{ id: 1, body: 'old' }]);
      return checked;
    });
    expect(result).toMatchObject({
      file: f.capture.file,
      bytes: f.capture.bytes,
      sha256: f.capture.sha256,
      writerActivated: false,
    });
    expect(f.live.prepare('SELECT * FROM messages').all()).toEqual([
      { id: 1, body: 'old' },
      { id: 2, body: 'later message' },
    ]);
    expect(fs.readdirSync(f.root + '/state')).toEqual(['backup-queue']);
  } finally {
    f.live.close();
  }
});
it.each(['hash', 'length', 'header', 'corrupt-page', 'mode', 'bounds'])(
  'refuses invalid recovered SQLite %s without changing the live database',
  async (reason) => {
    const f = nativeFixture();
    try {
      const receipt = { ...f.capture };
      if (reason === 'hash') receipt.sha256 = 'f'.repeat(64);
      if (reason === 'length') receipt.bytes++;
      if (reason === 'bounds') receipt.bytes = 64 * 1024 ** 2 + 1;
      if (reason === 'header') f.files.get(receipt.file)![18] = 2;
      if (reason === 'corrupt-page') f.files.get(receipt.file)![100] = 0xff;
      if (['header', 'corrupt-page'].includes(reason)) {
        const { createHash } = await import('node:crypto');
        receipt.sha256 = createHash('sha256').update(f.files.get(receipt.file)!).digest('hex');
      }
      await expect(
        f.recover(async (scope) => {
          if (reason === 'mode') fs.chmodSync(scope.directory + '/' + receipt.file, 0o644);
          expect(() => verifyRecoveredNativeDatabase(scope, receipt)).toThrow(/^native_recovery_check_unavailable$/);
          throw Error('validation_denied');
        }),
      ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
      expect(f.live.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 2 });
    } finally {
      f.live.close();
    }
  },
);
function historyFixture(profile: 'conversation' | 'mission') {
  const f = fixture(),
    source = f.root + '/source/history';
  fs.mkdirSync(source, { mode: 0o700 });
  const base = source + '/' + (profile === 'conversation' ? generation : 'missions/' + generation + '/provider');
  fs.mkdirSync(base + '/sessions', { recursive: true, mode: 0o700 });
  fs.mkdirSync(base + '/empty', { mode: 0o700 });
  fs.writeFileSync(base + '/sessions/history.jsonl', Buffer.alloc(150000, 0x41), { mode: 0o600 });
  fs.writeFileSync(base + '/auth.json', 'CURRENT_AUTH_PRESERVE', { mode: 0o600 });
  if (profile === 'mission') {
    fs.mkdirSync(source + '/missions/' + generation + '/control', { mode: 0o700 });
    fs.writeFileSync(source + '/missions/' + generation + '/control/capability', 'CURRENT_ADMISSION_PRESERVE', {
      mode: 0o600,
    });
    fs.writeFileSync(source + '/credentials.json', 'CURRENT_MASTER_PRESERVE', { mode: 0o600 });
  }
  return { ...f, source, base };
}
it.each(['conversation', 'mission'] as const)(
  'checks recovered %s history using the v1 hash and tracked empty directories',
  async (profile) => {
    const f = historyFixture(profile),
      receipt = await capturePrivateHistory(f.source, f.sink, profile);
    fs.appendFileSync(f.base + '/sessions/history.jsonl', 'CURRENT_LATER_HISTORY');
    const result = await f.recover(async (scope, entries) => {
      const checked = verifyRecoveredPrivateHistory(scope, entries, f.source, profile);
      expect(
        fs.readdirSync(
          scope.directory +
            '/' +
            profile +
            '-backup/history/' +
            (profile === 'conversation' ? generation : 'missions/' + generation + '/provider'),
        ),
      ).toEqual(['empty', 'sessions']);
      expect(await verifyPrivateHistory(f.source, fs.realpathSync(scope.directory), profile)).toEqual(receipt);
      return checked;
    }, true);
    expect(result).toEqual(receipt);
    expect(fs.readFileSync(f.base + '/auth.json', 'utf8')).toBe('CURRENT_AUTH_PRESERVE');
    expect(fs.readFileSync(f.base + '/sessions/history.jsonl', 'utf8').endsWith('CURRENT_LATER_HISTORY')).toBe(true);
    if (profile === 'mission')
      expect(fs.readFileSync(f.source + '/credentials.json', 'utf8')).toBe('CURRENT_MASTER_PRESERVE');
    expect(fs.readdirSync(f.root + '/state')).toEqual(['backup-queue']);
  },
);
it('verifies absent history without creating a live source or leaving isolated empty directories', async () => {
  const f = historyFixture('conversation');
  fs.rmSync(f.source, { recursive: true });
  const receipt = await capturePrivateHistory(f.source, f.sink, 'conversation');
  expect(
    await f.recover(async (scope, entries) => verifyRecoveredPrivateHistory(scope, entries, f.source, 'conversation')),
  ).toEqual(receipt);
  expect(fs.existsSync(f.source)).toBe(false);
  expect(fs.readdirSync(f.root + '/state')).toEqual(['backup-queue']);
});
it.each([
  'hash',
  'files',
  'bytes',
  'source',
  'duplicate-directory',
  'missing-parent',
  'traversal',
  'unknown-field',
  'absent',
])('denies invalid history metadata %s before creating recorded empty directories', async (reason) => {
  const f = historyFixture('conversation'),
    receipt = await capturePrivateHistory(f.source, f.sink, 'conversation');
  const changed: Record<string, unknown> = { ...receipt, directories: [...receipt.directories] };
  if (reason === 'hash') changed.sha256 = 'f'.repeat(64);
  if (reason === 'files') changed.files = receipt.files + 1;
  if (reason === 'bytes') changed.bytes = receipt.bytes + 1;
  if (reason === 'source') changed.source = f.root + '/another';
  if (reason === 'duplicate-directory') (changed.directories as string[]).push(receipt.directories[0]);
  if (reason === 'missing-parent') changed.directories = receipt.directories.slice(1);
  if (reason === 'traversal') (changed.directories as string[]).push('../escape');
  if (reason === 'unknown-field') changed.admissionRestored = true;
  if (reason === 'absent') changed.present = false;
  f.files.set('conversation-backup/receipt.json', Buffer.from(JSON.stringify(changed) + '\n'));
  await f.recover(async (scope, entries) => {
    expect(() => verifyRecoveredPrivateHistory(scope, entries, f.source, 'conversation')).toThrow(
      /^private_history_recovery_check_unavailable$/,
    );
    expect(fs.existsSync(scope.directory + '/conversation-backup/history/' + generation + '/empty')).toBe(false);
  });
  expect(fs.readdirSync(f.root + '/state')).toEqual(['backup-queue']);
});
it.each(['conversation-auth', 'mission-control', 'mission-master', 'foreign-receipt-child'])(
  'rejects unselected recovered history %s',
  async (reason) => {
    const profile = reason === 'conversation-auth' || reason === 'foreign-receipt-child' ? 'conversation' : 'mission';
    const f = historyFixture(profile);
    await capturePrivateHistory(f.source, f.sink, profile);
    const name =
      reason === 'conversation-auth'
        ? 'conversation-backup/history/' + generation + '/auth.json'
        : reason === 'mission-control'
          ? 'mission-backup/history/missions/' + generation + '/control/capability'
          : reason === 'mission-master'
            ? 'mission-backup/history/credentials.json'
            : 'conversation-backup/unknown.json';
    f.files.set(name, Buffer.from('PRIVATE_NOT_ADMISSION'));
    await f.recover(async (scope, entries) => {
      expect(() => verifyRecoveredPrivateHistory(scope, entries, f.source, profile)).toThrow(
        /^private_history_recovery_check_unavailable$/,
      );
    });
  },
);
