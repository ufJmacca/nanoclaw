import { afterEach, expect, it, vi } from 'vitest';
const memory = vi.hoisted(() => vi.fn());
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: memory }));
import { consumeBackupCredentials } from './backup-credential-wire.js';

afterEach(() => memory.mockReset());

function bundle(smb = Buffer.from('synthetic-π-password')) {
  return Buffer.concat([Buffer.from([0x43, 0x4f, 0x53, 0x42, 1, smb.length, 64]), smb, Buffer.alloc(64, 0x61)]);
}

it('borrows the exact UTF-8 SMB and hexadecimal Restic bytes only during protected work', async () => {
  const bytes = bundle();
  const smb = Buffer.from('synthetic-π-password');
  let retained: Buffer[] = [];
  await consumeBackupCredentials(bytes, async (credentials) => {
    expect(memory).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(credentials)).toBe(true);
    expect(credentials.smbPassword.equals(smb)).toBe(true);
    expect(credentials.resticPassword.equals(Buffer.alloc(64, 0x61))).toBe(true);
    expect(credentials.smbPassword.buffer).toBe(bytes.buffer);
    retained = [credentials.smbPassword, credentials.resticPassword];
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  expect(memory).toHaveBeenCalledTimes(2);
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(retained.every((value) => value.every((byte) => byte === 0))).toBe(true);
});

it.each([16, 64])('accepts the bounded %i-byte SMB password', async (length) => {
  const bytes = bundle(Buffer.alloc(length, 0x62));
  const callback = vi.fn(async () => {});
  await consumeBackupCredentials(bytes, callback);
  expect(callback).toHaveBeenCalledOnce();
  expect(bytes.every((byte) => byte === 0)).toBe(true);
});

it.each([
  'magic',
  'version',
  'short-smb',
  'long-smb',
  'restic-length',
  'truncated',
  'trailing',
  'uppercase-restic',
  'nonhex-restic',
  'invalid-utf8',
  'nul',
  'carriage-return',
  'newline',
  'oversized',
])('refuses and erases a %s bundle before giving credentials to a callback', async (reason) => {
  let bytes = bundle();
  if (reason === 'magic') bytes[0] = 0;
  if (reason === 'version') bytes[4] = 2;
  if (reason === 'short-smb') bytes = bundle(Buffer.alloc(15, 0x62));
  if (reason === 'long-smb') bytes = bundle(Buffer.alloc(65, 0x62));
  if (reason === 'restic-length') bytes[6] = 63;
  if (reason === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
  if (reason === 'trailing') bytes = Buffer.concat([bytes, Buffer.from([0])]);
  if (reason === 'uppercase-restic') bytes[bytes.length - 1] = 0x41;
  if (reason === 'nonhex-restic') bytes[bytes.length - 1] = 0x67;
  if (reason === 'invalid-utf8') bytes[7] = 0xff;
  if (reason === 'nul') bytes[7] = 0;
  if (reason === 'carriage-return') bytes[7] = 13;
  if (reason === 'newline') bytes[7] = 10;
  if (reason === 'oversized') bytes = Buffer.alloc(136, 0x62);
  const callback = vi.fn(async () => {});
  await expect(consumeBackupCredentials(bytes, callback)).rejects.toThrow(/^backup_credentials_unavailable$/);
  expect(callback).not.toHaveBeenCalled();
  expect(bytes.every((byte) => byte === 0)).toBe(true);
});

it.each([0, 1, 6])('refuses and erases a %i-byte truncated header', async (length) => {
  const bytes = Buffer.alloc(length, 0x62);
  const callback = vi.fn(async () => {});
  await expect(consumeBackupCredentials(bytes, callback)).rejects.toThrow(/^backup_credentials_unavailable$/);
  expect(callback).not.toHaveBeenCalled();
  expect(bytes.every((byte) => byte === 0)).toBe(true);
});

it('refuses unprotected memory and erases the bundle without calling the consumer', async () => {
  memory.mockImplementation(() => {
    throw Error('private cgroup diagnostic');
  });
  const bytes = bundle();
  const callback = vi.fn(async () => {});
  await expect(consumeBackupCredentials(bytes, callback)).rejects.toThrow(/^backup_credentials_unavailable$/);
  expect(callback).not.toHaveBeenCalled();
  expect(bytes.every((byte) => byte === 0)).toBe(true);
});

it('detects lost memory protection across awaited work and erases borrowed views', async () => {
  memory
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw Error('private late diagnostic');
    });
  const bytes = bundle();
  let retained!: Buffer;
  await expect(
    consumeBackupCredentials(bytes, async (credentials) => {
      retained = credentials.resticPassword;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }),
  ).rejects.toThrow(/^backup_credentials_unavailable$/);
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(retained.every((byte) => byte === 0)).toBe(true);
});

it('redacts callback errors and erases credentials on failure', async () => {
  const bytes = bundle();
  let retained!: Buffer;
  const failure = await consumeBackupCredentials(bytes, async (credentials) => {
    retained = credentials.smbPassword;
    throw Error('synthetic-π-password');
  }).catch((error: Error) => error);
  expect(failure).toEqual(Error('backup_credentials_unavailable'));
  expect(failure && failure.cause).toBeUndefined();
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(retained.every((byte) => byte === 0)).toBe(true);
});
