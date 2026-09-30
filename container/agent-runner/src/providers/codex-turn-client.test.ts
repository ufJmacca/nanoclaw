import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSubscriptionTurnClient } from './codex-turn-client.js';
test('reserves once before native work, ends the same attempt and sends nothing when already cancelled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-turn-client-')),
    socketPath = path.join(root, 'turn.sock');
  const calls: { route: string; id: string }[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (data) => {
      body += data;
    });
    request.on('end', () => {
      const value = JSON.parse(body);
      calls.push({ route: request.url!, id: value.attemptId });
      response.end(JSON.stringify({ version: 1, attemptId: value.attemptId }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const signal = new AbortController();
    const client = createSubscriptionTurnClient({ socketPath, signal: signal.signal });
    await client.begin();
    await expect(client.begin()).rejects.toThrow('subscription_turn_unavailable');
    signal.abort();
    await client.end(); // Cleanup remains possible after query cancellation.
    expect(calls.map((call) => call.route)).toEqual(['/begin', '/end']);
    expect(calls[0].id).toBe(calls[1].id);
    await expect(client.begin()).rejects.toThrow('subscription_turn_unavailable');
    expect(calls).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
