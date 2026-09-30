import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { parseDatabaseConfig } from './config.js';
import { safeHostEnvironment } from '../../../host-environment.js';

let directory: string;
beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-tls-fixture-'));
  const run = (args: string[]) =>
    execFileSync('openssl', args, { cwd: directory, env: safeHostEnvironment('docker'), stdio: 'ignore' });
  for (const name of ['ca', 'foreign'])
    run([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      '/CN=cos-fixture-' + name,
      '-days',
      '2',
      '-keyout',
      name + '.key',
      '-out',
      name + '.pem',
    ]);
  run([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=cos-fixture.invalid',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr',
  ]);
  fs.writeFileSync(
    path.join(directory, 'extensions'),
    'subjectAltName=DNS:cos-fixture.invalid\nextendedKeyUsage=serverAuth\n',
  );
  for (const [name, days] of [
    ['valid', '1'],
    ['expired', '-1'],
  ])
    run([
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-days',
      days,
      '-extfile',
      'extensions',
      '-out',
      name + '.pem',
    ]);
}, 10000);
afterAll(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

async function handshake(
  cert: 'valid' | 'expired' | 'plaintext',
  host: string,
  ca: string,
): Promise<{ error: string; connections: number }> {
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const context =
    cert === 'plaintext'
      ? undefined
      : tls.createSecureContext({
          key: fs.readFileSync(path.join(directory, 'leaf.key')),
          cert: fs.readFileSync(path.join(directory, cert + '.pem')),
        });
  // TLS-only protocol fixture: accepts the eight-byte SSL negotiation, never SQL or authentication.
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', (bytes) => {
      if (bytes.length !== 8) {
        socket.destroy();
        return;
      }
      if (!context) {
        socket.end('N');
        return;
      }
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
      sockets.add(secure);
      secure.on('error', () => secure.destroy());
      secure.on('close', () => sockets.delete(secure));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  class FixtureSocket extends net.Socket {
    connect(..._args: unknown[]): this {
      return super.connect({ host: '127.0.0.1', port });
    }
  }
  const config = parseDatabaseConfig(
    {
      COS_TEST_PGHOST: host,
      COS_TEST_PGDATABASE: 'synthetic',
      COS_TEST_PGUSER: 'synthetic',
      COS_TEST_PGPASSWORD: 'synthetic',
      COS_TEST_PGSSLROOTCERT: path.join(directory, ca + '.pem'),
      COS_TEST_PG_CONNECT_TIMEOUT_MS: '1000',
    },
    'test',
  );
  const client = new pg.Client({ ...config, stream: () => new FixtureSocket() });
  client.on('error', () => {});
  try {
    await client.connect();
    return { error: 'unexpected connection', connections };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'unknown', connections };
  } finally {
    await client.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
describe('S01-PG03 actual pinned driver TLS rejection without downgrade', () => {
  it('rejects an unknown certificate authority', async () => {
    const result = await handshake('valid', 'cos-fixture.invalid', 'foreign');
    expect(result.error).toMatch(/certificate|issuer/i);
    expect(result.connections).toBe(1);
  });
  it('rejects an expired certificate', async () => {
    const result = await handshake('expired', 'cos-fixture.invalid', 'ca');
    expect(result.error).toMatch(/expired/i);
    expect(result.connections).toBe(1);
  });
  it('rejects a mismatched hostname', async () => {
    const result = await handshake('valid', 'wrong-fixture.invalid', 'ca');
    expect(result.error).toMatch(/hostname|altname/i);
    expect(result.connections).toBe(1);
  });
  it('rejects a server refusing TLS without retrying plaintext', async () => {
    const result = await handshake('plaintext', 'cos-fixture.invalid', 'ca');
    expect(result.error).toMatch(/does not support SSL/i);
    expect(result.connections).toBe(1);
  });
});
