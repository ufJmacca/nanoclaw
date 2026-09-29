import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startCosRelay } from './cos-relay.js';

test('CoS relay forwards only model requests to the fixed Unix socket without worker headers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-relay-'));
  const socket = path.join(root, 'model.sock');
  const received: http.IncomingHttpHeaders[] = [];
  const host = http.createServer((req, res) => {
    received.push(req.headers);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('fixture');
    });
  });
  await new Promise<void>((resolve) => host.listen(socket, resolve));
  const relay = await startCosRelay(socket, 0);
  try {
    const response = await fetch(relay.baseUrl + '/responses', {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'worker-secret', 'x-routing': 'foreign' },
    });
    expect(await response.text()).toBe('fixture');
    expect(received[0].authorization).toBeUndefined();
    expect(received[0]['x-routing']).toBeUndefined();
    for (const suffix of ['/files', '/responses?redirect=other'])
      expect((await fetch(relay.baseUrl + suffix, { method: 'POST' })).status).toBe(404);
    expect(received.length).toBe(1);
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
