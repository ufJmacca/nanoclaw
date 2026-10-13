import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { captureNativeDatabase } from './backup-native.js';
import { BackupQueue } from './backup-queue.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-native-'));
  roots.push(root);
  const source = path.join(root, 'native.db');
  const live = new Database(source);
  live.pragma('journal_mode=WAL');
  live.pragma('wal_autocheckpoint=0');
  live.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages VALUES(1,'committed');");
  return { root, source, live };
}
it('captures committed WAL pages into a standalone snapshot without plaintext staging or source changes', () => {
  const { root, source, live } = fixture();
  try {
    const sourceBytes = fs.readFileSync(source),
      wal = fs.readFileSync(source + '-wal');
    live.exec("BEGIN; INSERT INTO messages VALUES(2,'uncommitted')");
    const files = new Map<string, Buffer>(),
      references: Buffer[] = [];
    const receipt = captureNativeDatabase(
      source,
      {
        write(name, bytes) {
          files.set(name, Buffer.from(bytes));
          references.push(bytes);
        },
      },
      'native',
      65536,
    );
    expect([...files.keys()]).toEqual(['native/native.sqlite', 'native/native-backup.json']);
    const snapshot = files.get('native/native.sqlite')!;
    const copy = new Database(snapshot);
    try {
      expect(copy.prepare('SELECT * FROM messages').all()).toEqual([{ id: 1, body: 'committed' }]);
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      copy.close();
    }
    expect(snapshot[18]).toBe(1);
    expect(snapshot[19]).toBe(1);
    expect(receipt.sha256).toBe(createHash('sha256').update(snapshot).digest('hex'));
    expect(JSON.parse(files.get('native/native-backup.json')!.toString())).toEqual(receipt);
    expect(references.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
    expect(fs.readFileSync(source)).toEqual(sourceBytes);
    expect(fs.readFileSync(source + '-wal')).toEqual(wal);
    expect(fs.readdirSync(root).sort()).toEqual(['native.db', 'native.db-shm', 'native.db-wal']);
    live.exec('ROLLBACK');
    expect(live.pragma('journal_mode', { simple: true })).toBe('wal');
    live.exec("INSERT INTO messages VALUES(3,'later arrival')");
  } finally {
    live.close();
  }
});
it('denies an over-budget database before allocating a serialized copy or invoking the sink', () => {
  const { source, live } = fixture();
  try {
    live.prepare('INSERT INTO messages VALUES(2, ?)').run('x'.repeat(32768));
    let called = false;
    expect(() =>
      captureNativeDatabase(
        source,
        {
          write() {
            called = true;
          },
        },
        'native',
        8192,
      ),
    ).toThrow(/^native_snapshot_unavailable$/);
    expect(called).toBe(false);
    expect(live.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 2 });
  } finally {
    live.close();
  }
});
it.each(['symlink', 'hardlink', 'foreign-mode'])('denies unsafe source %s without invoking the sink', (kind) => {
  const { root, source, live } = fixture();
  try {
    let selected = source;
    if (kind === 'symlink') {
      selected = path.join(root, 'link.db');
      fs.symlinkSync(source, selected);
    }
    if (kind === 'hardlink') fs.linkSync(source, path.join(root, 'alias.db'));
    if (kind === 'foreign-mode') fs.chmodSync(source, 0o666);
    let called = false;
    expect(() =>
      captureNativeDatabase(
        selected,
        {
          write() {
            called = true;
          },
        },
        'native',
        65536,
      ),
    ).toThrow(/^native_snapshot_unavailable$/);
    expect(called).toBe(false);
  } finally {
    live.close();
  }
});
it('wipes snapshot bytes and redacts a failed sink while preserving the live database', () => {
  const { source, live } = fixture();
  let retained: Buffer | undefined;
  try {
    expect(() =>
      captureNativeDatabase(
        source,
        {
          write(_name, bytes) {
            retained = bytes;
            throw Error('private fixture failure');
          },
        },
        'native',
        65536,
      ),
    ).toThrow(/^native_snapshot_unavailable$/);
    expect(retained!.every((byte) => byte === 0)).toBe(true);
    expect(live.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
  } finally {
    live.close();
  }
});
it.each(['wal-hardlink', 'shm-writable', 'journal-symlink'])('refuses unsafe SQLite sidecars: %s', (kind) => {
  const { root, source, live } = fixture();
  try {
    if (kind === 'wal-hardlink') fs.linkSync(source + '-wal', path.join(root, 'alias-wal'));
    if (kind === 'shm-writable') fs.chmodSync(source + '-shm', 0o666);
    if (kind === 'journal-symlink') fs.symlinkSync(path.join(root, 'unrelated'), source + '-journal');
    let called = false;
    expect(() =>
      captureNativeDatabase(
        source,
        {
          write() {
            called = true;
          },
        },
        'native',
        65536,
      ),
    ).toThrow(/^native_snapshot_unavailable$/);
    expect(called).toBe(false);
  } finally {
    live.close();
  }
});
it.each(['../escape', '/absolute', 'native/../escape', 'a//b'])('denies unsafe snapshot prefix %s', (prefix) => {
  const { source, live } = fixture();
  try {
    expect(() =>
      captureNativeDatabase(
        source,
        {
          write() {
            throw Error('must not write');
          },
        },
        prefix,
        65536,
      ),
    ).toThrow(/^native_snapshot_unavailable$/);
  } finally {
    live.close();
  }
});
it('publishes a hash-verified native snapshot through the bounded vault queue sink', async () => {
  const { root, source, live } = fixture();
  const area = path.join(root, 'synthetic-vault');
  fs.mkdirSync(area, { mode: 0o700 });
  const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(area));
  const operationId = '9f99d9b4-4dac-423a-956c-afd953993c2d';
  try {
    await queue.capture(
      'state',
      operationId,
      async (sink) => {
        captureNativeDatabase(source, sink, 'native/main', 65536);
      },
      131072,
    );
    await queue.withPending('state', operationId, async (directory, receipt) => {
      expect(receipt.files).toHaveLength(2);
      const copy = new Database(path.join(directory, 'native/main/native.sqlite'), { readonly: true });
      try {
        expect(copy.prepare('SELECT body FROM messages').get()).toEqual({ body: 'committed' });
      } finally {
        copy.close();
      }
    });
  } finally {
    live.close();
  }
});
it('refuses a malformed database without writing a partial snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-native-malformed-'));
  roots.push(root);
  const source = path.join(root, 'native.db');
  fs.writeFileSync(source, 'synthetic invalid database', { mode: 0o600 });
  let called = false;
  expect(() =>
    captureNativeDatabase(
      source,
      {
        write() {
          called = true;
        },
      },
      'native',
      65536,
    ),
  ).toThrow(/^native_snapshot_unavailable$/);
  expect(called).toBe(false);
});
