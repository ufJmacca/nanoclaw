/**
 * Integration tests for the v2 host core.
 * Tests routing, session creation, message writing, and delivery
 * without spawning actual containers.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import {
  resolveSession,
  writeSessionMessage,
  initSessionFolder,
  sessionDir,
  inboundDbPath,
  outboundDbPath,
  readOutboxFiles,
  clearOutbox,
} from './session-manager.js';
import { getSession, findSession } from './db/sessions.js';
import { registerInboundAttachmentLoaderFactory, type InboundEvent } from './channels/adapter.js';

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host' };
});

function now() {
  return new Date().toISOString();
}

const TEST_DIR = '/tmp/nanoclaw-test-host';

beforeEach(() => {
  // Clean test directory
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('session manager', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  it('should create session folder and both DBs', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'outbox'))).toBe(true);

    // Verify inbound.db
    const inPath = inboundDbPath('ag-1', 'sess-test');
    expect(fs.existsSync(inPath)).toBe(true);
    const inDb = new Database(inPath);
    const inTables = inDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(inTables.map((t) => t.name)).toContain('messages_in');
    expect(inTables.map((t) => t.name)).toContain('delivered');
    inDb.close();

    // Verify outbound.db
    const outPath = outboundDbPath('ag-1', 'sess-test');
    expect(fs.existsSync(outPath)).toBe(true);
    const outDb = new Database(outPath);
    const outTables = outDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    expect(outTables.map((t) => t.name)).toContain('messages_out');
    expect(outTables.map((t) => t.name)).toContain('processing_ack');
    outDb.close();
  });

  it('should reject outbound attachment filenames that escape the message outbox', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    const msgOutbox = path.join(dir, 'outbox', 'msg-1');
    fs.mkdirSync(msgOutbox, { recursive: true });

    const outside = path.join(TEST_DIR, 'outside.txt');
    fs.writeFileSync(outside, 'outside secret');

    expect(readOutboxFiles('ag-1', 'sess-test', 'msg-1', ['../../../../../outside.txt'])).toBeUndefined();
  });

  it('should reject outbound attachment symlinks that escape the message outbox', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    const msgOutbox = path.join(dir, 'outbox', 'msg-1');
    fs.mkdirSync(msgOutbox, { recursive: true });

    const outside = path.join(TEST_DIR, 'outside.txt');
    fs.writeFileSync(outside, 'outside secret');
    fs.symlinkSync('../../../../../outside.txt', path.join(msgOutbox, 'safe-name.txt'));

    expect(readOutboxFiles('ag-1', 'sess-test', 'msg-1', ['safe-name.txt'])).toBeUndefined();
  });

  it('should reject an outbox root symlink redirected into another session', () => {
    initSessionFolder('ag-1', 'sess-a');
    initSessionFolder('ag-1', 'sess-b');
    const outboxA = path.join(sessionDir('ag-1', 'sess-a'), 'outbox');
    const outboxB = path.join(sessionDir('ag-1', 'sess-b'), 'outbox');
    const foreignMessageDir = path.join(outboxB, 'msg-foreign');
    fs.mkdirSync(foreignMessageDir, { recursive: true });
    fs.writeFileSync(path.join(foreignMessageDir, 'secret.txt'), 'FOREIGN_SESSION_ATTACHMENT');
    fs.rmSync(outboxA, { recursive: true });
    fs.symlinkSync(outboxB, outboxA, 'dir');

    expect(readOutboxFiles('ag-1', 'sess-a', 'msg-foreign', ['secret.txt'])).toBeUndefined();
  });

  it('should keep an outbox read on its opened directory when the container swaps the root', () => {
    initSessionFolder('ag-1', 'sess-a');
    initSessionFolder('ag-1', 'sess-b');
    const outboxA = path.join(sessionDir('ag-1', 'sess-a'), 'outbox');
    const outboxB = path.join(sessionDir('ag-1', 'sess-b'), 'outbox');
    const ownedMessageDir = path.join(outboxA, 'msg-race');
    const foreignMessageDir = path.join(outboxB, 'msg-race');
    const ownedFile = path.join(ownedMessageDir, 'result.txt');
    fs.mkdirSync(ownedMessageDir, { recursive: true });
    fs.mkdirSync(foreignMessageDir, { recursive: true });
    fs.writeFileSync(ownedFile, 'OWNED_ATTACHMENT');
    fs.writeFileSync(path.join(foreignMessageDir, 'result.txt'), 'FOREIGN_ATTACHMENT');

    const originalReadFileSync = fs.readFileSync;
    let swapped = false;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      candidate: string | Buffer | URL | number,
      ...args: unknown[]
    ) => {
      if (!swapped && (typeof candidate === 'number' || path.resolve(String(candidate)) === ownedFile)) {
        swapped = true;
        fs.renameSync(outboxA, `${outboxA}-opened`);
        fs.symlinkSync(outboxB, outboxA, 'dir');
      }
      return Reflect.apply(originalReadFileSync, fs, [candidate, ...args]);
    }) as typeof fs.readFileSync);

    try {
      const files = readOutboxFiles('ag-1', 'sess-a', 'msg-race', ['result.txt']);
      expect(files?.[0]?.data.toString()).toBe('OWNED_ATTACHMENT');
    } finally {
      readSpy.mockRestore();
    }
    expect(swapped).toBe(true);
  });

  it('should pin the outbox message directory before opening an attachment file', () => {
    initSessionFolder('ag-1', 'sess-a');
    initSessionFolder('ag-1', 'sess-b');
    const outboxA = path.join(sessionDir('ag-1', 'sess-a'), 'outbox');
    const outboxB = path.join(sessionDir('ag-1', 'sess-b'), 'outbox');
    const ownedMessageDir = path.join(outboxA, 'msg-open-race');
    const foreignMessageDir = path.join(outboxB, 'msg-open-race');
    fs.mkdirSync(ownedMessageDir, { recursive: true });
    fs.mkdirSync(foreignMessageDir, { recursive: true });
    fs.writeFileSync(path.join(ownedMessageDir, 'result.txt'), 'OWNED_ATTACHMENT');
    fs.writeFileSync(path.join(foreignMessageDir, 'result.txt'), 'FOREIGN_ATTACHMENT');

    const originalOpenSync = fs.openSync;
    let swapped = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((candidate: fs.PathLike, ...args: unknown[]) => {
      if (!swapped && String(candidate).endsWith('/result.txt')) {
        swapped = true;
        fs.renameSync(outboxA, `${outboxA}-opened`);
        fs.symlinkSync(outboxB, outboxA, 'dir');
      }
      return Reflect.apply(originalOpenSync, fs, [candidate, ...args]);
    }) as typeof fs.openSync);

    try {
      const files = readOutboxFiles('ag-1', 'sess-a', 'msg-open-race', ['result.txt']);
      expect(files?.[0]?.data.toString()).toBe('OWNED_ATTACHMENT');
    } finally {
      openSpy.mockRestore();
    }
    expect(swapped).toBe(true);
  });

  it('should fail explicitly when stable descriptor-relative traversal is unavailable', () => {
    initSessionFolder('ag-1', 'sess-test');
    const messageDir = path.join(sessionDir('ag-1', 'sess-test'), 'outbox', 'msg-1');
    fs.mkdirSync(messageDir, { recursive: true });
    fs.writeFileSync(path.join(messageDir, 'result.txt'), 'OWNED_ATTACHMENT');

    const originalOpenSync = fs.openSync;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((candidate: fs.PathLike, ...args: unknown[]) => {
      if (String(candidate).startsWith('/proc/self/fd/') || String(candidate).startsWith('/dev/fd/')) {
        const err = new Error('descriptor traversal unavailable') as NodeJS.ErrnoException;
        err.code = 'ENOTDIR';
        throw err;
      }
      return Reflect.apply(originalOpenSync, fs, [candidate, ...args]);
    }) as typeof fs.openSync);

    try {
      expect(() => readOutboxFiles('ag-1', 'sess-test', 'msg-1', ['result.txt'])).toThrow(
        'Secure descriptor-relative filesystem access is unavailable',
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it('should not clear another session through a redirected outbox root', () => {
    initSessionFolder('ag-1', 'sess-a');
    initSessionFolder('ag-1', 'sess-b');
    const outboxA = path.join(sessionDir('ag-1', 'sess-a'), 'outbox');
    const outboxB = path.join(sessionDir('ag-1', 'sess-b'), 'outbox');
    const foreignMessageDir = path.join(outboxB, 'msg-foreign');
    const foreignFile = path.join(foreignMessageDir, 'keep.txt');
    fs.mkdirSync(foreignMessageDir, { recursive: true });
    fs.writeFileSync(foreignFile, 'KEEP_FOREIGN_FILE');
    fs.rmSync(outboxA, { recursive: true });
    fs.symlinkSync(outboxB, outboxA, 'dir');

    clearOutbox('ag-1', 'sess-a', 'msg-foreign');

    expect(fs.readFileSync(foreignFile, 'utf8')).toBe('KEEP_FOREIGN_FILE');
  });

  it('should keep outbox cleanup on its opened directory when the container swaps the root', () => {
    initSessionFolder('ag-1', 'sess-a');
    initSessionFolder('ag-1', 'sess-b');
    const outboxA = path.join(sessionDir('ag-1', 'sess-a'), 'outbox');
    const outboxB = path.join(sessionDir('ag-1', 'sess-b'), 'outbox');
    const ownedMessageDir = path.join(outboxA, 'msg-race');
    const foreignMessageDir = path.join(outboxB, 'msg-race');
    const foreignFile = path.join(foreignMessageDir, 'keep.txt');
    fs.mkdirSync(ownedMessageDir, { recursive: true });
    fs.writeFileSync(path.join(ownedMessageDir, 'remove.txt'), 'REMOVE_OWNED_FILE');
    fs.mkdirSync(foreignMessageDir, { recursive: true });
    fs.writeFileSync(foreignFile, 'KEEP_FOREIGN_FILE');

    const originalRmSync = fs.rmSync;
    let swapped = false;
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
      if (!swapped) {
        swapped = true;
        fs.renameSync(outboxA, `${outboxA}-opened`);
        fs.symlinkSync(outboxB, outboxA, 'dir');
      }
      return originalRmSync(candidate, options);
    });

    try {
      clearOutbox('ag-1', 'sess-a', 'msg-race');
    } finally {
      rmSpy.mockRestore();
    }
    expect(swapped).toBe(true);
    expect(fs.readFileSync(foreignFile, 'utf8')).toBe('KEEP_FOREIGN_FILE');
  });

  it('should pin the outbox root before quarantining a cleanup directory', () => {
    initSessionFolder('ag-1', 'sess-a');
    initSessionFolder('ag-1', 'sess-b');
    const outboxA = path.join(sessionDir('ag-1', 'sess-a'), 'outbox');
    const outboxB = path.join(sessionDir('ag-1', 'sess-b'), 'outbox');
    const ownedMessageDir = path.join(outboxA, 'msg-rename-race');
    const foreignMessageDir = path.join(outboxB, 'msg-rename-race');
    const foreignFile = path.join(foreignMessageDir, 'keep.txt');
    fs.mkdirSync(ownedMessageDir, { recursive: true });
    fs.writeFileSync(path.join(ownedMessageDir, 'remove.txt'), 'REMOVE_OWNED_FILE');
    fs.mkdirSync(foreignMessageDir, { recursive: true });
    fs.writeFileSync(foreignFile, 'KEEP_FOREIGN_FILE');

    const originalRenameSync = fs.renameSync;
    let swapped = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      if (!swapped) {
        swapped = true;
        originalRenameSync(outboxA, `${outboxA}-opened`);
        fs.symlinkSync(outboxB, outboxA, 'dir');
      }
      return originalRenameSync(oldPath, newPath);
    });

    try {
      clearOutbox('ag-1', 'sess-a', 'msg-rename-race');
    } finally {
      renameSpy.mockRestore();
    }
    expect(swapped).toBe(true);
    expect(fs.readFileSync(foreignFile, 'utf8')).toBe('KEEP_FOREIGN_FILE');
  });

  it('should not recursively delete outside the outbox for unsafe message ids', () => {
    initSessionFolder('ag-1', 'sess-test');
    const victimDir = path.join(TEST_DIR, 'victim-dir');
    fs.mkdirSync(victimDir, { recursive: true });
    fs.writeFileSync(path.join(victimDir, 'keep.txt'), 'do not delete');

    clearOutbox('ag-1', 'sess-test', '../../../../victim-dir');

    expect(fs.existsSync(path.join(victimDir, 'keep.txt'))).toBe(true);
  });

  it('should still read and clear normal basename outbox files', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    const msgOutbox = path.join(dir, 'outbox', 'msg-1');
    fs.mkdirSync(msgOutbox, { recursive: true });
    fs.writeFileSync(path.join(msgOutbox, 'result.txt'), 'ok');

    const files = readOutboxFiles('ag-1', 'sess-test', 'msg-1', ['result.txt']);
    expect(files).toHaveLength(1);
    expect(files?.[0]?.filename).toBe('result.txt');
    expect(files?.[0]?.data.toString()).toBe('ok');

    clearOutbox('ag-1', 'sess-test', 'msg-1');
    expect(fs.existsSync(msgOutbox)).toBe(false);
  });

  it('should reject inbound attachment writes through a pre-placed symlinked inbox dir', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // The container has /workspace write access, so it can pre create
    // inbox/<msgId> as a symlink to escape.
    const inboxRoot = path.join(sessionDir('ag-1', session.id), 'inbox');
    fs.mkdirSync(inboxRoot, { recursive: true });
    const evilTarget = path.join(TEST_DIR, 'evil-target');
    fs.mkdirSync(evilTarget, { recursive: true });
    fs.symlinkSync(evilTarget, path.join(inboxRoot, 'msg-evil'));

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-evil',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'evil',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    expect(fs.existsSync(path.join(evilTarget, 'photo.png'))).toBe(false);
  });

  it('should reject an inbox root symlink redirected outside its owned session', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const inboxRoot = path.join(sessionDir('ag-1', session.id), 'inbox');
    const foreignInbox = path.join(TEST_DIR, 'foreign-session-inbox');
    fs.mkdirSync(foreignInbox, { recursive: true });
    fs.symlinkSync(foreignInbox, inboxRoot, 'dir');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-root-symlink',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'must remain owned',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    expect(fs.existsSync(path.join(foreignInbox, 'msg-root-symlink', 'photo.png'))).toBe(false);
  });

  it('should keep an inbox write on its opened directory when the container swaps the root', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const inboxRoot = path.join(sessionDir('ag-1', session.id), 'inbox');
    const foreignInbox = path.join(TEST_DIR, 'foreign-racing-inbox');
    fs.mkdirSync(path.join(foreignInbox, 'msg-race'), { recursive: true });

    const originalWriteFileSync = fs.writeFileSync;
    let swapped = false;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      candidate: string | Buffer | URL | number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      if (!swapped && (typeof candidate === 'number' || String(candidate).endsWith('/msg-race/photo.png'))) {
        swapped = true;
        fs.renameSync(inboxRoot, `${inboxRoot}-opened`);
        fs.symlinkSync(foreignInbox, inboxRoot, 'dir');
      }
      return Reflect.apply(originalWriteFileSync, fs, [candidate, data, ...args]);
    }) as typeof fs.writeFileSync);

    try {
      writeSessionMessage('ag-1', session.id, {
        id: 'msg-race',
        kind: 'chat',
        timestamp: now(),
        content: JSON.stringify({
          text: 'must stay on the opened inbox',
          attachments: [{ name: 'photo.png', data: Buffer.from('OWNED_BYTES').toString('base64'), size: 11 }],
        }),
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(swapped).toBe(true);
    expect(fs.existsSync(path.join(foreignInbox, 'msg-race', 'photo.png'))).toBe(false);
    expect(fs.readFileSync(path.join(`${inboxRoot}-opened`, 'msg-race', 'photo.png'), 'utf8')).toBe('OWNED_BYTES');
  });

  it('should pin the inbox message directory before opening an attachment file', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const inboxRoot = path.join(sessionDir('ag-1', session.id), 'inbox');
    const foreignInbox = path.join(TEST_DIR, 'foreign-open-racing-inbox');
    fs.mkdirSync(path.join(foreignInbox, 'msg-open-race'), { recursive: true });

    const originalOpenSync = fs.openSync;
    let swapped = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((candidate: fs.PathLike, ...args: unknown[]) => {
      if (!swapped && String(candidate).endsWith('/photo.png')) {
        swapped = true;
        fs.renameSync(inboxRoot, `${inboxRoot}-opened`);
        fs.symlinkSync(foreignInbox, inboxRoot, 'dir');
      }
      return Reflect.apply(originalOpenSync, fs, [candidate, ...args]);
    }) as typeof fs.openSync);

    try {
      writeSessionMessage('ag-1', session.id, {
        id: 'msg-open-race',
        kind: 'chat',
        timestamp: now(),
        content: JSON.stringify({
          text: 'must stay on the pinned inbox',
          attachments: [{ name: 'photo.png', data: Buffer.from('OWNED_BYTES').toString('base64'), size: 11 }],
        }),
      });
    } finally {
      openSpy.mockRestore();
    }

    expect(swapped).toBe(true);
    expect(fs.existsSync(path.join(foreignInbox, 'msg-open-race', 'photo.png'))).toBe(false);
    expect(fs.readFileSync(path.join(`${inboxRoot}-opened`, 'msg-open-race', 'photo.png'), 'utf8')).toBe('OWNED_BYTES');
  });

  it('should refuse to follow a pre-existing symlink at the inbound attachment path', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // The container pre creates inbox/<msgId>/photo.png as a symlink to a
    // host file. Without the wx flag, writeFileSync would follow it.
    const inboxDir = path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-sym');
    fs.mkdirSync(inboxDir, { recursive: true });
    const outside = path.join(TEST_DIR, 'outside.txt');
    fs.writeFileSync(outside, 'ORIGINAL');
    fs.symlinkSync(outside, path.join(inboxDir, 'photo.png'));

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-sym',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'sym',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    expect(fs.readFileSync(outside, 'utf-8')).toBe('ORIGINAL');
  });

  it('should reject inbound attachments when messageId is unsafe', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: '../../escape',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'msgid',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    const inboxRoot = path.join(sessionDir('ag-1', session.id), 'inbox');
    if (fs.existsSync(inboxRoot)) {
      expect(fs.readdirSync(inboxRoot)).toEqual([]);
    }
  });

  it('should still save inbound attachments with safe basenames', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-ok',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'ok',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    const expected = path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-ok', 'photo.png');
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, 'utf-8')).toBe('PNGBYTES');
  });

  it('should not create inbox artifacts for a message without attachment data', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-no-attachment-data',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'plain message', attachments: [] }),
    });

    expect(fs.existsSync(path.join(sessionDir('ag-1', session.id), 'inbox'))).toBe(false);
  });

  it('stages direct inbound buffers without persisting file bytes in message JSON', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-direct',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ sender: 'User', text: '' }),
      attachments: [
        {
          name: 'code.html',
          mimeType: 'text/html',
          size: 16,
          data: Buffer.from('<h1>fixture</h1>'),
        },
      ],
    });

    const staged = path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-direct', 'code.html');
    expect(fs.readFileSync(staged, 'utf8')).toBe('<h1>fixture</h1>');

    const db = new Database(inboundDbPath('ag-1', session.id));
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-direct') as { content: string };
    db.close();
    const content = JSON.parse(row.content) as Record<string, unknown>;
    expect(content).toEqual({
      sender: 'User',
      text: '',
      attachments: [
        {
          type: 'file',
          name: 'code.html',
          mimeType: 'text/html',
          size: 16,
          localPath: 'inbox/msg-direct/code.html',
        },
      ],
    });
    expect(row.content).not.toContain('fixture');
    expect(row.content).not.toContain('"data"');
  });

  it('uses deterministic safe names and keeps unavailable direct attachments visible', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-direct-failures',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: '' }),
      attachments: [
        {
          name: '../../escape.txt',
          mimeType: 'text/plain',
          size: 5,
          data: Buffer.from('owned'),
        },
        {
          name: 'missing.bin',
          unavailable: 'download_failed',
        },
        {
          name: `${'é'.repeat(121)}.txt`,
          mimeType: 'text/plain',
          size: 4,
          data: Buffer.from('long'),
        },
      ],
    });

    const safePath = path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-direct-failures', 'attachment-1.txt');
    expect(fs.readFileSync(safePath, 'utf8')).toBe('owned');

    const db = new Database(inboundDbPath('ag-1', session.id));
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-direct-failures') as {
      content: string;
    };
    db.close();
    expect(JSON.parse(row.content).attachments).toEqual([
      {
        type: 'file',
        name: 'attachment-1.txt',
        mimeType: 'text/plain',
        size: 5,
        localPath: 'inbox/msg-direct-failures/attachment-1.txt',
      },
      {
        type: 'file',
        name: 'missing.bin',
        unavailable: 'download_failed',
      },
      {
        type: 'file',
        name: 'attachment-3.txt',
        mimeType: 'text/plain',
        size: 4,
        localPath: 'inbox/msg-direct-failures/attachment-3.txt',
      },
    ]);
    expect(
      fs.readFileSync(
        path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-direct-failures', 'attachment-3.txt'),
        'utf8',
      ),
    ).toBe('long');
  });

  it('reuses exact staged bytes for an idempotent inbound attachment replay', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const message = {
      id: 'msg-direct-replay',
      kind: 'chat',
      timestamp: now(),
      channelType: 'mattermost',
      content: JSON.stringify({ senderId: 'mattermost:user-1', text: '' }),
      attachments: [
        {
          name: 'replay.txt',
          mimeType: 'text/plain',
          size: 12,
          data: Buffer.from('replay bytes'),
        },
      ],
      idempotent: true,
    } as const;

    expect(writeSessionMessage('ag-1', session.id, message)).toBe(true);
    expect(writeSessionMessage('ag-1', session.id, message)).toBe(false);
    expect(
      fs.readFileSync(path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-direct-replay', 'replay.txt'), 'utf8'),
    ).toBe('replay bytes');
  });

  it('does not stage orphan files before rejecting a contradictory attachment replay', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const base = {
      id: 'msg-direct-collision',
      kind: 'chat',
      timestamp: now(),
      channelType: 'mattermost',
      content: JSON.stringify({ senderId: 'mattermost:user-1', text: '' }),
      idempotent: true,
    } as const;
    expect(
      writeSessionMessage('ag-1', session.id, {
        ...base,
        attachments: [{ name: 'first.txt', mimeType: 'text/plain', size: 5, data: Buffer.from('first') }],
      }),
    ).toBe(true);

    expect(() =>
      writeSessionMessage('ag-1', session.id, {
        ...base,
        attachments: [{ name: 'orphan.txt', mimeType: 'text/plain', size: 6, data: Buffer.from('second') }],
      }),
    ).toThrow('Mattermost replay message identity collision');

    const inbox = path.join(sessionDir('ag-1', session.id), 'inbox', base.id);
    expect(fs.readdirSync(inbox)).toEqual(['first.txt']);
  });

  it('opens a pre-existing inbound attachment nonblocking before checking its file type', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const inbox = path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-direct-fifo');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'blocked.txt'), 'owned');
    const originalOpenSync = fs.openSync;
    let existingOpenFlags: number | undefined;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((
      candidate: fs.PathLike,
      flags: number,
      mode?: number,
    ) => {
      if (String(candidate).endsWith('/blocked.txt') && (flags & fs.constants.O_NONBLOCK) !== 0) {
        existingOpenFlags = flags;
      }
      return originalOpenSync(candidate, flags, mode);
    }) as typeof fs.openSync);

    try {
      expect(
        writeSessionMessage('ag-1', session.id, {
          id: 'msg-direct-fifo',
          kind: 'chat',
          timestamp: now(),
          channelType: 'mattermost',
          content: JSON.stringify({ senderId: 'mattermost:user-1', text: '' }),
          attachments: [{ name: 'blocked.txt', mimeType: 'text/plain', size: 5, data: Buffer.from('owned') }],
          idempotent: true,
        }),
      ).toBe(true);
    } finally {
      openSpy.mockRestore();
    }

    expect(existingOpenFlags).toBeDefined();
    expect((existingOpenFlags! & fs.constants.O_NONBLOCK) !== 0).toBe(true);
  });

  it('should resolve distinct thread ids to one existing session in shared mode', () => {
    const { session: s1, created: c1 } = resolveSession('ag-1', 'mg-1', 'thread-1', 'shared');
    expect(c1).toBe(true);

    const { session: s2, created: c2 } = resolveSession('ag-1', 'mg-1', 'thread-2', 'shared');
    expect(c2).toBe(false);
    expect(s2.id).toBe(s1.id);
    expect(s2.thread_id).toBeNull();
  });

  it('should create separate sessions per thread (per-thread mode)', () => {
    const { session: s1 } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    const { session: s2 } = resolveSession('ag-1', 'mg-1', 'thread-2', 'per-thread');
    expect(s1.id).not.toBe(s2.id);
  });

  it('should reuse session for same thread', () => {
    const { session: s1 } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    const { session: s2, created } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');
    expect(created).toBe(false);
    expect(s2.id).toBe(s1.id);
  });

  it('should write message to inbound DB', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'chan-123',
      channelType: 'discord',
      threadId: null,
      content: JSON.stringify({ sender: 'User', text: 'Hello' }),
    });

    // Read from the inbound DB
    const dbPath = inboundDbPath('ag-1', session.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{
      id: string;
      kind: string;
      status: string;
      content: string;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('msg-1');
    expect(rows[0].status).toBe('pending');
    expect(JSON.parse(rows[0].content).text).toBe('Hello');
  });

  it('should update last_active on message write', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(getSession(session.id)!.last_active).toBeNull();

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'hi' }),
    });

    expect(getSession(session.id)!.last_active).not.toBeNull();
  });

  it('should refuse path-traversal in attachment filenames', () => {
    // Regression: attachment.name comes from untrusted senders (E2EE-protected
    // chat platforms can't sanitize it server-side). Without the guard, a
    // `../../../tmp/pwned` filename escapes the inbox dir and writes anywhere
    // the host process can reach.
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const inboxBase = path.join(sessionDir('ag-1', session.id), 'inbox');
    const escapeTarget = path.join('/tmp', 'nanoclaw-traversal-canary');
    if (fs.existsSync(escapeTarget)) fs.rmSync(escapeTarget);

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-attack',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'pwn',
        attachments: [
          {
            type: 'document',
            name: '../../../../../../../../tmp/nanoclaw-traversal-canary',
            data: Buffer.from('owned').toString('base64'),
          },
        ],
      }),
    });

    expect(fs.existsSync(escapeTarget)).toBe(false);
    // The bytes should still land — under a synthesized safe name inside the
    // inbox — so the agent doesn't lose data on a malicious filename.
    const inboxDir = path.join(inboxBase, 'msg-attack');
    expect(fs.existsSync(inboxDir)).toBe(true);
    const written = fs.readdirSync(inboxDir);
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain('/');
    expect(written[0]).not.toContain('..');
  });
});

describe('router', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    // Use 'public' policy so the router tests exercise routing, not the
    // access gate. Dedicated access-gate tests live with the access module.
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  it('should route a message end-to-end', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    const event: InboundEvent = {
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-in-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hello agent!' }),
        timestamp: now(),
      },
    };

    await routeInbound(event);

    // Verify session was created
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();

    // Verify message was written to inbound DB
    const dbPath = inboundDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{ id: string; content: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Hello agent!');

    // Verify container was woken
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('routes seeded Telegram input to its existing Telegram agent group', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');

    createAgentGroup({
      id: 'ag-telegram',
      name: 'Telegram Agent',
      folder: 'telegram-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-telegram',
      channel_type: 'telegram',
      platform_id: 'telegram:-100123',
      name: 'Telegram Group',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-telegram',
      messaging_group_id: 'mg-telegram',
      agent_group_id: 'ag-telegram',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: 'telegram:-100123',
      threadId: null,
      message: {
        id: 'telegram-message-1',
        kind: 'chat-sdk',
        content: JSON.stringify({ sender: 'Telegram User', text: 'Hello from Telegram' }),
        timestamp: now(),
      },
    });

    const telegramSessions = getSessionsByAgentGroup('ag-telegram');
    expect(telegramSessions).toHaveLength(1);
    expect(telegramSessions[0].messaging_group_id).toBe('mg-telegram');
    expect(getSessionsByAgentGroup('ag-1')).toHaveLength(0);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect((wakeContainer as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].agent_group_id).toBe('ag-telegram');
  });

  it('does not cross-resolve identical platform ids between Telegram and Mattermost rows', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');

    createAgentGroup({
      id: 'ag-telegram-collision',
      name: 'Telegram Collision Agent',
      folder: 'telegram-collision-agent',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-mattermost-collision',
      name: 'Mattermost Collision Agent',
      folder: 'mattermost-collision-agent',
      agent_provider: null,
      created_at: now(),
    });

    for (const fixture of [
      {
        channelType: 'mattermost',
        messagingGroupId: 'mg-mattermost-collision',
        agentGroupId: 'ag-mattermost-collision',
      },
      {
        channelType: 'telegram',
        messagingGroupId: 'mg-telegram-collision',
        agentGroupId: 'ag-telegram-collision',
      },
    ]) {
      createMessagingGroup({
        id: fixture.messagingGroupId,
        channel_type: fixture.channelType,
        platform_id: 'shared-platform-id',
        name: `${fixture.channelType} collision fixture`,
        is_group: 1,
        unknown_sender_policy: 'public',
        created_at: now(),
      });
      createMessagingGroupAgent({
        id: `mga-${fixture.channelType}-collision`,
        messaging_group_id: fixture.messagingGroupId,
        agent_group_id: fixture.agentGroupId,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now(),
      });
    }
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: 'shared-platform-id',
      threadId: null,
      message: {
        id: 'telegram-collision-message',
        kind: 'chat-sdk',
        content: JSON.stringify({ sender: 'Telegram User', text: 'Stay in Telegram' }),
        timestamp: now(),
      },
    });

    expect(getSessionsByAgentGroup('ag-telegram-collision')).toHaveLength(1);
    expect(getSessionsByAgentGroup('ag-mattermost-collision')).toHaveLength(0);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect((wakeContainer as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].agent_group_id).toBe(
      'ag-telegram-collision',
    );
  });

  it('leaves an addressed unknown channel unwired and does not invoke an agent before approval', async () => {
    const { routeInbound, setChannelRequestGate } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const { getMessagingGroupAgents, getMessagingGroupByPlatform } = await import('./db/messaging-groups.js');
    const requestApproval = vi.fn().mockResolvedValue(undefined);
    setChannelRequestGate(requestApproval);
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound({
      channelType: 'telegram',
      platformId: 'telegram:-100-unapproved',
      threadId: null,
      message: {
        id: 'unknown-channel-message',
        kind: 'chat-sdk',
        content: JSON.stringify({ sender: 'Unknown User', text: '@bot hello' }),
        timestamp: now(),
        isMention: true,
        isGroup: true,
      },
    });

    const messagingGroup = getMessagingGroupByPlatform('telegram', 'telegram:-100-unapproved');
    expect(messagingGroup).toBeDefined();
    expect(getMessagingGroupAgents(messagingGroup!.id)).toHaveLength(0);
    expect(findSession(messagingGroup!.id, null)).toBeUndefined();
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ id: messagingGroup!.id }),
      expect.objectContaining({ channelType: 'telegram', platformId: 'telegram:-100-unapproved' }),
    );
  });

  it('auto-creates messaging group only when the bot is addressed (mention/DM)', async () => {
    // The router's no-mg branch is escalation-gated: plain chatter on an
    // unknown channel stays silent (no DB writes) so a bot that sits in
    // many unwired channels doesn't bloat messaging_groups. Only explicit
    // mentions and DMs trigger auto-create.
    const { routeInbound } = await import('./router.js');
    const { getMessagingGroupByPlatform } = await import('./db/messaging-groups.js');

    // Plain message on unknown channel — should NOT auto-create.
    await routeInbound({
      channelType: 'slack',
      platformId: 'C-PLAIN',
      threadId: null,
      message: {
        id: 'msg-plain',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hi' }),
        timestamp: now(),
      },
    });
    expect(getMessagingGroupByPlatform('slack', 'C-PLAIN')).toBeUndefined();

    // Mention on unknown channel — SHOULD auto-create (next step: channel-registration flow).
    await routeInbound({
      channelType: 'slack',
      platformId: 'C-MENTIONED',
      threadId: null,
      message: {
        id: 'msg-mentioned',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: '@bot hi' }),
        timestamp: now(),
        isMention: true,
      },
    });
    expect(getMessagingGroupByPlatform('slack', 'C-MENTIONED')).toBeDefined();
  });

  it('should route multiple messages to the same session', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-a', kind: 'chat', content: JSON.stringify({ sender: 'A', text: 'First' }), timestamp: now() },
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-b',
        kind: 'chat',
        content: JSON.stringify({ sender: 'B', text: 'Second' }),
        timestamp: now(),
      },
    });

    // Both should be in the same session
    const session = findSession('mg-1', null);
    const dbPath = inboundDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in ORDER BY timestamp').all();
    db.close();

    expect(rows).toHaveLength(2);
  });

  it('fans out to every matching agent, each in its own session', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    // Wire a second agent to the same messaging group.
    createAgentGroup({
      id: 'ag-2',
      name: 'Secondary Agent',
      folder: 'secondary-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-2',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-fan', kind: 'chat', content: JSON.stringify({ text: 'hello all' }), timestamp: now() },
    });

    // Both agents should now have their own session and be woken.
    expect(wakeContainer).toHaveBeenCalledTimes(2);

    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    expect(getSessionsByAgentGroup('ag-1')).toHaveLength(1);
    expect(getSessionsByAgentGroup('ag-2')).toHaveLength(1);
  });

  it('loads inbound attachments once and stages an independent copy for each engaged agent', async () => {
    const { routeInbound } = await import('./router.js');
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    createAgentGroup({
      id: 'ag-2',
      name: 'Secondary Agent',
      folder: 'secondary-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-2',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    const loadAttachments = vi.fn().mockResolvedValue([
      {
        name: 'shared.txt',
        mimeType: 'text/plain',
        size: 12,
        data: Buffer.from('shared bytes'),
      },
    ]);

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-lazy-fanout',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: '' }),
        timestamp: now(),
        loadAttachments,
      },
    });

    expect(loadAttachments).toHaveBeenCalledTimes(1);
    for (const agentGroupId of ['ag-1', 'ag-2']) {
      const [session] = getSessionsByAgentGroup(agentGroupId);
      const namespacedMessageId = `msg-lazy-fanout:${agentGroupId}`;
      const staged = path.join(sessionDir(agentGroupId, session.id), 'inbox', namespacedMessageId, 'shared.txt');
      expect(fs.readFileSync(staged, 'utf8')).toBe('shared bytes');

      const db = new Database(inboundDbPath(agentGroupId, session.id));
      const row = db.prepare('SELECT content FROM messages_in').get() as { content: string };
      db.close();
      const [attachment] = JSON.parse(row.content).attachments as Array<Record<string, unknown>>;
      expect(attachment.localPath).toBe(`inbox/${namespacedMessageId}/shared.txt`);
      expect(attachment).not.toHaveProperty('data');
    }
  });

  it('rehydrates serialized attachment refs only after approval replay reaches an engaged destination', async () => {
    const { routeInbound } = await import('./router.js');
    const serializedEvent = JSON.stringify({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-approval-replay',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: '' }),
        timestamp: now(),
        attachmentRefs: [{ id: 'opaque-file-1' }],
      },
    } satisfies InboundEvent);
    const replayedEvent = JSON.parse(serializedEvent) as InboundEvent;
    const loadAttachments = vi.fn().mockResolvedValue([
      {
        name: 'approved.txt',
        mimeType: 'text/plain',
        size: 14,
        data: Buffer.from('approved bytes'),
      },
    ]);
    const factory = vi.fn().mockReturnValue(loadAttachments);
    const unregister = registerInboundAttachmentLoaderFactory('discord', factory);

    expect(replayedEvent.message.loadAttachments).toBeUndefined();
    expect(replayedEvent.message.attachmentRefs).toEqual([{ id: 'opaque-file-1' }]);
    expect(factory).not.toHaveBeenCalled();
    try {
      await routeInbound(replayedEvent);
    } finally {
      unregister();
    }

    expect(factory).toHaveBeenCalledOnce();
    expect(loadAttachments).toHaveBeenCalledOnce();
    const session = findSession('mg-1', null)!;
    expect(
      fs.readFileSync(
        path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-approval-replay:ag-1', 'approved.txt'),
        'utf8',
      ),
    ).toBe('approved bytes');
  });

  it('persists one explicit unavailable marker per ref when loader rehydration is unavailable', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-unavailable-refs',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: '' }),
        timestamp: now(),
        attachmentRefs: [{ id: 'opaque-file-1' }, { id: 'opaque-file-2' }],
      },
    });

    const session = findSession('mg-1', null)!;
    const db = new Database(inboundDbPath('ag-1', session.id));
    const row = db.prepare('SELECT content FROM messages_in').get() as { content: string };
    db.close();
    expect(JSON.parse(row.content).attachments).toEqual([
      { type: 'file', name: 'attachment-1', unavailable: 'download_failed' },
      { type: 'file', name: 'attachment-2', unavailable: 'download_failed' },
    ]);
  });

  it('accumulates without waking when engage fails + ignored_message_policy=accumulate', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    // Replace the seed row with a mention-only wiring whose accumulate
    // policy should store context even when the message doesn't mention us.
    const { updateMessagingGroupAgent } = await import('./db/messaging-groups.js');
    updateMessagingGroupAgent('mga-1', {
      engage_mode: 'mention',
      ignored_message_policy: 'accumulate',
    });

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'msg-nomatch',
        kind: 'chat',
        content: JSON.stringify({ text: 'no mention here' }),
        timestamp: now(),
      },
    });

    expect(wakeContainer).not.toHaveBeenCalled();

    const session = findSession('mg-1', null);
    expect(session).toBeDefined();
    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT id, trigger FROM messages_in').all() as Array<{
      id: string;
      trigger: number;
    }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe(0);
  });

  it('drops silently when engage fails + ignored_message_policy=drop', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    const { updateMessagingGroupAgent } = await import('./db/messaging-groups.js');
    updateMessagingGroupAgent('mga-1', { engage_mode: 'mention' }); // drop is the default

    await routeInbound({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'msg-drop', kind: 'chat', content: JSON.stringify({ text: 'ignored' }), timestamp: now() },
    });

    expect(wakeContainer).not.toHaveBeenCalled();
    // No session should have been created for this agent.
    expect(findSession('mg-1', null)).toBeUndefined();
  });

  it('does not invoke lazy attachment downloads before engagement, access, and scope checks pass', async () => {
    const { routeInbound, setAccessGate, setSenderScopeGate } = await import('./router.js');
    const { updateMessagingGroupAgent } = await import('./db/messaging-groups.js');
    const loadAttachments = vi.fn().mockResolvedValue([]);
    const factory = vi.fn().mockReturnValue(loadAttachments);
    const unregister = registerInboundAttachmentLoaderFactory('discord', factory);

    setAccessGate((event) =>
      event.message.id === 'msg-access-denied' ? { allowed: false, reason: 'test denial' } : { allowed: true },
    );
    setSenderScopeGate((event) =>
      event.message.id === 'msg-scope-denied' ? { allowed: false, reason: 'test denial' } : { allowed: true },
    );

    try {
      for (const id of ['msg-access-denied', 'msg-scope-denied']) {
        await routeInbound({
          channelType: 'discord',
          platformId: 'chan-123',
          threadId: null,
          message: {
            id,
            kind: 'chat',
            content: JSON.stringify({ text: 'engages' }),
            timestamp: now(),
            attachmentRefs: [{ id: 'opaque-file-1' }],
          },
        });
      }

      updateMessagingGroupAgent('mga-1', { engage_mode: 'mention' });
      await routeInbound({
        channelType: 'discord',
        platformId: 'chan-123',
        threadId: null,
        message: {
          id: 'msg-not-engaged',
          kind: 'chat',
          content: JSON.stringify({ text: 'plain chatter' }),
          timestamp: now(),
          attachmentRefs: [{ id: 'opaque-file-1' }],
        },
      });
    } finally {
      unregister();
    }

    expect(factory).not.toHaveBeenCalled();
    expect(loadAttachments).not.toHaveBeenCalled();
  });
});

describe('delivery', () => {
  it('should detect undelivered messages in outbound DB', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-test',
      channel_type: 'discord',
      platform_id: 'chan-test',
      name: 'Test',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-test', null, 'shared');

    // Write a response to the outbound DB (simulating what the agent-runner does)
    const dbPath = outboundDbPath('ag-1', session.id);
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES ('out-1', datetime('now'), 'chat', 'chan-123', 'discord', ?)`,
    ).run(JSON.stringify({ text: 'Agent response' }));

    const undelivered = db.prepare('SELECT * FROM messages_out').all() as Array<{
      id: string;
      content: string;
    }>;
    db.close();

    expect(undelivered).toHaveLength(1);
    expect(JSON.parse(undelivered[0].content).text).toBe('Agent response');
  });
});
