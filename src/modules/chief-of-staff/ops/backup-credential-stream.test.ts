import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
const memory = vi.hoisted(() => vi.fn());
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: memory }));
import { consumeBackupCredentialStream } from './backup-credential-stream.js';

afterEach(() => memory.mockReset());
function bundle() {
  return Buffer.concat([
    Buffer.from([0x43, 0x4f, 0x53, 0x42, 1, 16, 64]),
    Buffer.alloc(16, 0x62),
    Buffer.alloc(64, 0x61),
  ]);
}

it('waits for EOF, consumes split private bytes and erases incoming chunks and borrowed views', async () => {
  const original = bundle();
  const chunks = [original.subarray(0, 5), original.subarray(5, 31), original.subarray(31)];
  let ended = false;
  const stream = Readable.from(
    (async function* () {
      for (const chunk of chunks) yield chunk;
      ended = true;
    })(),
  );
  let retained!: Buffer;
  await consumeBackupCredentialStream(stream, async (credentials) => {
    expect(ended).toBe(true);
    expect(credentials.smbPassword.equals(Buffer.alloc(16, 0x62))).toBe(true);
    expect(credentials.resticPassword.equals(Buffer.alloc(64, 0x61))).toBe(true);
    retained = credentials.resticPassword;
  });
  expect(original.every((byte) => byte === 0)).toBe(true);
  expect(retained.every((byte) => byte === 0)).toBe(true);
  expect(stream.destroyed).toBe(true);
});

it('does not hand off a valid prefix followed by trailing bytes', async () => {
  const chunks = [bundle(), Buffer.from([1])];
  const callback = vi.fn(async () => {});
  await expect(consumeBackupCredentialStream(Readable.from(chunks), callback)).rejects.toThrow(
    /^backup_credentials_unavailable$/,
  );
  expect(callback).not.toHaveBeenCalled();
  expect(chunks.every((chunk) => chunk.every((byte) => byte === 0))).toBe(true);
});

it.each([0, 6, 86, 136, 4096])('refuses %i bytes without handing credentials to a consumer', async (length) => {
  const chunk = Buffer.alloc(length, 0x62);
  const callback = vi.fn(async () => {});
  await expect(consumeBackupCredentialStream(Readable.from([chunk]), callback)).rejects.toThrow(
    /^backup_credentials_unavailable$/,
  );
  expect(callback).not.toHaveBeenCalled();
  expect(chunk.every((byte) => byte === 0)).toBe(true);
});

it('destroys an unterminated valid prefix at the bounded transport deadline', async () => {
  const chunk = bundle();
  let pushed = false;
  const stream = new Readable({
    read() {
      if (!pushed) {
        pushed = true;
        this.push(chunk);
      }
    },
  });
  const callback = vi.fn(async () => {});
  await expect(consumeBackupCredentialStream(stream, callback, { deadlineMs: 15 })).rejects.toThrow(
    /^backup_credentials_unavailable$/,
  );
  expect(callback).not.toHaveBeenCalled();
  expect(stream.destroyed).toBe(true);
  expect(chunk.every((byte) => byte === 0)).toBe(true);
});

it.each([0, 15001, NaN, Infinity, 1.5])(
  'refuses an invalid deadline %s before reading the pipe',
  async (deadlineMs) => {
    let read = false;
    const stream = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    await expect(consumeBackupCredentialStream(stream, async () => {}, { deadlineMs })).rejects.toThrow(
      /^backup_credentials_unavailable$/,
    );
    expect(read).toBe(false);
    expect(stream.destroyed).toBe(true);
  },
);

it.each(['tty', 'encoding', 'memory'])('refuses %s before reading any credential bytes', async (reason) => {
  let read = false;
  const stream = new Readable({
    read() {
      read = true;
      this.push(null);
    },
  });
  if (reason === 'tty') Object.assign(stream, { isTTY: true });
  if (reason === 'encoding') stream.setEncoding('utf8');
  if (reason === 'memory')
    memory.mockImplementation(() => {
      throw Error('private cgroup diagnostic');
    });
  const callback = vi.fn(async () => {});
  await expect(consumeBackupCredentialStream(stream, callback)).rejects.toThrow(/^backup_credentials_unavailable$/);
  expect(read).toBe(false);
  expect(callback).not.toHaveBeenCalled();
  expect(stream.destroyed).toBe(true);
});

it('refuses a string chunk instead of copying it into a secret string', async () => {
  const callback = vi.fn(async () => {});
  await expect(consumeBackupCredentialStream(Readable.from(['synthetic-string']), callback)).rejects.toThrow(
    /^backup_credentials_unavailable$/,
  );
  expect(callback).not.toHaveBeenCalled();
});

it('erases the current received chunk when memory protection fails during receipt', async () => {
  memory
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw Error('private late cgroup diagnostic');
    });
  const chunk = bundle();
  const callback = vi.fn(async () => {});
  await expect(consumeBackupCredentialStream(Readable.from([chunk]), callback)).rejects.toThrow(
    /^backup_credentials_unavailable$/,
  );
  expect(callback).not.toHaveBeenCalled();
  expect(chunk.every((byte) => byte === 0)).toBe(true);
});

it('redacts an upstream failure and refuses its otherwise valid prefix', async () => {
  const chunk = bundle();
  const callback = vi.fn(async () => {});
  const stream = Readable.from(
    (async function* () {
      yield chunk;
      throw Error('PRIVATE_SSH_DIAGNOSTIC');
    })(),
  );
  const failure = await consumeBackupCredentialStream(stream, callback).catch((error: Error) => error);
  expect(failure).toEqual(Error('backup_credentials_unavailable'));
  expect(failure && failure.cause).toBeUndefined();
  expect(callback).not.toHaveBeenCalled();
  expect(chunk.every((byte) => byte === 0)).toBe(true);
});
