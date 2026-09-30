import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startSubscriptionTurns } from './subscription-turns.js';
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
function post(socketPath: string, route: string, body: unknown): Promise<{ code: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method: 'POST' }, (response) => {
      let text = '';
      response.on('data', (data) => {
        text += data;
      });
      response.on('end', () => resolve({ code: response.statusCode!, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}
it('opens egress only for one authorized, reserved attempt and closes it on end or revocation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-turns-')),
    socket = path.join(root, 'turn.sock');
  let admitted = true,
    reservations = 0;
  const attempts = new Set<string>();
  const broker = await startSubscriptionTurns({
    socket,
    authorize: async () => admitted,
    reserve(attempt) {
      if (attempts.has(attempt)) return false;
      attempts.add(attempt);
      reservations++;
      return true;
    },
  });
  try {
    expect(await broker.allowed()).toBe(false);
    expect((await post(socket, '/begin', { attemptId: id, model: 'injected' })).code).toBe(400);
    expect((await post(socket, '/begin', { attemptId: id })).code).toBe(200);
    expect(await broker.allowed()).toBe(true);
    expect((await post(socket, '/begin', { attemptId: other })).code).toBe(409);
    expect((await post(socket, '/end', { attemptId: other })).code).toBe(409);
    expect((await post(socket, '/end', { attemptId: id })).code).toBe(200);
    expect(await broker.allowed()).toBe(false);
    expect((await post(socket, '/begin', { attemptId: id })).code).toBe(403);
    expect((await post(socket, '/begin', { attemptId: other })).code).toBe(200);
    admitted = false;
    expect(await broker.allowed()).toBe(false);
    admitted = true;
    expect(await broker.allowed()).toBe(false); // A revoked attempt cannot reopen.
    expect(reservations).toBe(2);
  } finally {
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('a closed or denied session cannot reserve model usage and never exposes private failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-turns-')),
    socket = path.join(root, 'turn.sock');
  let calls = 0;
  const broker = await startSubscriptionTurns({
    socket,
    authorize: async () => {
      throw new Error('private-token-canary');
    },
    reserve() {
      calls++;
      return true;
    },
  });
  try {
    const result = await post(socket, '/begin', { attemptId: id });
    expect(result.code).toBe(403);
    expect(JSON.stringify(result)).not.toContain('private-token-canary');
    expect(calls).toBe(0);
    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
  } finally {
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  expect(await broker.allowed()).toBe(false);
});
