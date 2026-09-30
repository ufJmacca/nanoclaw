import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicModelAddress, startSubscriptionEgress } from './subscription-egress.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(role: 'query' | 'auth' = 'query', limits = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-egress-'));
  const socketPath = path.join(directory, 'egress.sock');
  const echo = net.createServer((socket) => socket.pipe(socket));
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const authorize = vi.fn().mockResolvedValue(true);
  const resolve = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  const connect = vi.fn(() =>
    net.createConnection({ host: '127.0.0.1', port: (echo.address() as net.AddressInfo).port }),
  );
  const gateway = await startSubscriptionEgress({
    socketPath,
    role,
    authorize,
    limits: { authorizationIntervalMs: 20, ...limits },
    dependencies: { resolve, connect },
  });
  const clients: net.Socket[] = [];
  cleanups.push(async () => {
    for (const client of clients) client.destroy();
    await gateway.close();
    await new Promise<void>((r) => echo.close(() => r()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(target = 'chatgpt.com:443', extra = '', method = 'CONNECT') {
    const client = net.createConnection(socketPath);
    clients.push(client);
    await once(client, 'connect');
    const response = new Promise<string>((accept, reject) => {
      client.once('data', (data) => accept(data.toString()));
      client.once('error', reject);
    });
    client.write(`${method} ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${extra}`);
    return { client, header: await response };
  }
  return { gateway, authorize, resolve, connect, request, socketPath };
}

describe('native subscription egress', () => {
  it('allows only the selected model host, pins its resolved address, and carries opaque TLS bytes', async () => {
    const f = await fixture();
    const { client, header } = await f.request();
    expect(header).toContain('200 Connection Established');
    const data = once(client, 'data');
    client.write('opaque TLS fixture');
    expect(String((await data)[0])).toBe('opaque TLS fixture');
    expect(f.resolve).toHaveBeenCalledWith('chatgpt.com');
    expect(f.connect).toHaveBeenCalledWith({ address: '8.8.8.8', family: 4 }, 443);
    expect(fs.statSync(f.socketPath).mode & 0o777).toBe(0o600);
  });
  it('rejects arbitrary hosts, API billing, ports, credentials, IP literals and non-CONNECT requests before DNS', async () => {
    const f = await fixture();
    for (const target of [
      'api.openai.com:443',
      'auth.openai.com:443',
      'example.com:443',
      'chatgpt.com:80',
      '127.0.0.1:443',
      'chatgpt.com:443@evil.invalid',
      'chatgpt.com.:443',
      'CHATGPT.COM:443',
    ]) {
      const result = await f.request(target);
      expect(result.header).toContain('403');
      result.client.destroy();
    }
    expect((await f.request('https://chatgpt.com/', '', 'GET')).header).toContain('405');
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it('admits native refresh only for the trusted authentication role', async () => {
    const f = await fixture('auth');
    expect((await f.request('auth.openai.com:443')).header).toContain('200 Connection Established');
    expect((await f.request('api.openai.com:443')).header).toContain('403');
  });
  it('refuses private and mixed DNS results before creating an upstream connection', async () => {
    const f = await fixture();
    for (const address of [
      '127.0.0.1',
      '10.1.1.1',
      '172.16.4.1',
      '192.168.1.3',
      '169.254.169.254',
      '::1',
      'fc00::1',
      '::ffff:127.0.0.1',
    ]) {
      f.resolve.mockResolvedValueOnce([
        { address: '8.8.8.8', family: 4 },
        { address, family: net.isIP(address) },
      ]);
      const result = await f.request();
      expect(result.header).toContain('403');
      result.client.destroy();
    }
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('rechecks authorization after resolution and closes established tunnels after revocation', async () => {
    const f = await fixture();
    f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await f.request()).header).toContain('403');
    expect(f.connect).not.toHaveBeenCalled();
    f.authorize.mockResolvedValue(true);
    const { client, header } = await f.request();
    expect(header).toContain('200 Connection Established');
    const closed = once(client, 'close');
    f.authorize.mockResolvedValue(false);
    await closed;
  });
  it('bounds tunnel lifetime and aggregate bytes', async () => {
    const time = await fixture('query', { maxDurationMs: 80 });
    const live = await time.request();
    expect(live.header).toContain('200');
    await once(live.client, 'close');
    const size = await fixture('query', { maxBytes: 64 });
    const bounded = await size.request();
    const closed = once(bounded.client, 'close');
    bounded.client.write('x'.repeat(128));
    await closed;
  });
  it('fails closed on authorization and DNS errors', async () => {
    const f = await fixture();
    f.authorize.mockRejectedValueOnce(Error('private detail'));
    const denied = await f.request();
    expect(denied.header).toContain('403');
    expect(denied.header).not.toContain('private detail');
    f.resolve.mockRejectedValueOnce(Error('private resolver detail'));
    expect((await f.request()).header).toContain('403');
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('excludes local, reserved, multicast and mapped address families', () => {
    for (const address of [
      '0.0.0.0',
      '100.64.0.1',
      '198.18.0.1',
      '192.0.2.1',
      '224.0.0.1',
      '255.255.255.255',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      '2002:7f00:1::1',
      'not-an-ip',
    ])
      expect(publicModelAddress(address)).toBe(false);
    expect(publicModelAddress('8.8.8.8')).toBe(true);
    expect(publicModelAddress('2606:4700::1111')).toBe(true);
  });
});
