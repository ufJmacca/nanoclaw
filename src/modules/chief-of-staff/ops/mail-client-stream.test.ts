import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
const memory = vi.hoisted(() => vi.fn());
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: memory }));
import { consumeMailClientStream } from './mail-client-stream.js';

afterEach(() => memory.mockReset());
const client = { clientId: 'mail-fixture.apps.googleusercontent.com', clientSecret: 'PRIVATE_CLIENT_CANARY' };
function downloaded() {
  return {
    installed: {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      project_id: 'fixture-project',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      redirect_uris: ['http://localhost'],
    },
  };
}
it('accepts only the complete downloaded Desktop client after EOF and erases the received chunks', async () => {
  const bytes = Buffer.from(JSON.stringify(downloaded()));
  let ended = false;
  const stream = Readable.from(
    (async function* () {
      yield bytes.subarray(0, 31);
      yield bytes.subarray(31);
      ended = true;
    })(),
  );
  const install = vi.fn(async (value) => {
    expect(ended).toBe(true);
    expect(value).toEqual(client);
  });
  await consumeMailClientStream(stream, install);
  expect(install).toHaveBeenCalledOnce();
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(stream.destroyed).toBe(true);
});
it.each([
  null,
  client,
  { web: downloaded().installed },
  { ...downloaded(), token: 'PRIVATE_TOKEN_CANARY' },
  { installed: { ...downloaded().installed, token_uri: 'https://attacker.invalid/token' } },
  { installed: { ...downloaded().installed, redirect_uris: ['https://attacker.invalid/'] } },
  { installed: { ...downloaded().installed, access_token: 'PRIVATE_TOKEN_CANARY' } },
  { installed: { ...downloaded().installed, client_secret: '' } },
])(
  'refuses non-Desktop, changed endpoint or credential-bearing input without calling the installer: %j',
  async (value) => {
    const bytes = Buffer.from(JSON.stringify(value)),
      install = vi.fn();
    await expect(consumeMailClientStream(Readable.from([bytes]), install)).rejects.toThrow(
      /^mail_client_input_unavailable$/,
    );
    expect(install).not.toHaveBeenCalled();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  },
);
it.each(['oversized', 'trailing', 'invalid-utf8', 'string', 'upstream'])(
  'refuses %s input and redacts private errors',
  async (reason) => {
    const bytes =
      reason === 'oversized'
        ? Buffer.alloc(16385, 65)
        : reason === 'invalid-utf8'
          ? Buffer.from([0xff])
          : Buffer.from(JSON.stringify(downloaded()));
    const install = vi.fn();
    const stream = Readable.from(
      (async function* () {
        yield reason === 'string' ? 'PRIVATE_CLIENT_CANARY' : bytes;
        if (reason === 'trailing') yield Buffer.from('trailing');
        if (reason === 'upstream') throw Error('PRIVATE_TRANSPORT_CANARY');
      })(),
    );
    const result = await consumeMailClientStream(stream, install).catch((error: Error) => error);
    expect(result).toEqual(Error('mail_client_input_unavailable'));
    expect(result).not.toHaveProperty('cause');
    expect(install).not.toHaveBeenCalled();
    if (reason !== 'string') expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(stream.destroyed).toBe(true);
  },
);
it.each(['tty', 'encoding', 'memory'])('rejects %s before reading input', async (reason) => {
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
      throw Error('PRIVATE_MEMORY_CANARY');
    });
  await expect(consumeMailClientStream(stream, vi.fn())).rejects.toThrow(/^mail_client_input_unavailable$/);
  expect(read).toBe(false);
  expect(stream.destroyed).toBe(true);
});
it('closes an unfinished pipe at the bounded deadline without handing off its valid prefix', async () => {
  const bytes = Buffer.from(JSON.stringify(downloaded())),
    install = vi.fn();
  const stream = new Readable({
    read() {
      this.push(bytes);
      this._read = () => {};
    },
  });
  await expect(consumeMailClientStream(stream, install, { deadlineMs: 10 })).rejects.toThrow(
    /^mail_client_input_unavailable$/,
  );
  expect(install).not.toHaveBeenCalled();
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(stream.destroyed).toBe(true);
});
it('erases received bytes when protection is lost or the installer fails', async () => {
  const bytes = Buffer.from(JSON.stringify(downloaded())),
    install = vi.fn();
  memory
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw Error('PRIVATE_MEMORY_CANARY');
    });
  await expect(consumeMailClientStream(Readable.from([bytes]), install)).rejects.toThrow(
    /^mail_client_input_unavailable$/,
  );
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(install).not.toHaveBeenCalled();
  memory.mockReset();
  await expect(
    consumeMailClientStream(Readable.from([Buffer.from(JSON.stringify(downloaded()))]), async () => {
      throw Error('PRIVATE_CLIENT_CANARY');
    }),
  ).rejects.toThrow(/^mail_client_input_unavailable$/);
});
