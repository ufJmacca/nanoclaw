import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { startSubscriptionRelay } from './cos-subscription-relay.js';

test('native subscription relay carries CONNECT and TLS bytes only to its fixed Unix socket', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-relay-'));
  const socketPath = path.join(directory, 'egress.sock');
  const sockets = new Set<net.Socket>();
  const host = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  host.listen(socketPath);
  await once(host, 'listening');
  const relay = await startSubscriptionRelay(socketPath);
  const client = net.createConnection(Number(new URL(relay.proxyUrl).port), '127.0.0.1');
  try {
    await once(client, 'connect');
    const received = once(client, 'data');
    const bytes = Buffer.from('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\nopaque fixture bytes');
    client.write(bytes);
    expect((await received)[0]).toEqual(bytes);
    const closed = once(client, 'close');
    await relay.close();
    await closed;
  } finally {
    client.destroy();
    await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('native subscription relay closes its client when the host socket is unavailable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-relay-'));
  const relay = await startSubscriptionRelay(path.join(directory, 'missing.sock'));
  const client = net.createConnection(Number(new URL(relay.proxyUrl).port), '127.0.0.1');
  try {
    await once(client, 'close');
  } finally {
    client.destroy();
    await relay.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
