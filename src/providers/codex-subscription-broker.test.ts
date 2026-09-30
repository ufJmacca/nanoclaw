import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSubscriptionBroker } from './codex-subscription-broker.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-broker-'));
  const socket = path.join(directory, 'credentials.sock');
  const authorize = vi.fn().mockResolvedValue(true);
  const snapshot = {
    generation: 'a'.repeat(64),
    authJson: JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'fixture-access',
        id_token: 'fixture-id',
        refresh_token: '',
        account_id: 'fixture-account',
      },
    }),
  };
  const store = { cached: vi.fn(() => snapshot), refresh: vi.fn().mockResolvedValue(snapshot) };
  const broker = await startSubscriptionBroker({ socket, store, authorize });
  cleanups.push(async () => {
    await broker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (url = '/cached', body = '{}', method = 'POST') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({ socketPath: socket, path: url, method }, (response) => {
        let data = '';
        response.on('data', (part) => (data += part));
        response.on('end', () => resolve({ status: response.statusCode!, body: data }));
      });
      request.on('error', reject);
      request.end(body);
    });
  return { socket, authorize, store, snapshot, request };
}
describe('session-scoped subscription credential broker', () => {
  it('returns only an access snapshot and forwards the expected generation for bounded renewal', async () => {
    const f = await fixture();
    expect(fs.statSync(f.socket).mode & 0o777).toBe(0o600);
    expect(JSON.parse((await f.request()).body)).toEqual({ version: 1, ...f.snapshot });
    expect((await f.request('/refresh', JSON.stringify({ generation: f.snapshot.generation }))).status).toBe(200);
    expect(f.store.refresh).toHaveBeenCalledWith(f.snapshot.generation);
  });
  it('refuses unbound operations, extra fields and oversized requests before credential access', async () => {
    const f = await fixture();
    for (const [url, body] of [
      ['/login', '{}'],
      ['/cached', '{"scope":"other"}'],
      ['/refresh', '{}'],
      ['/refresh', '{"generation":"invalid"}'],
      ['/cached', 'x'.repeat(5000)],
    ])
      expect((await f.request(url, body)).status).not.toBe(200);
    expect((await f.request('/cached', '', 'GET')).status).toBe(405);
    expect(f.store.cached).not.toHaveBeenCalled();
    expect(f.store.refresh).not.toHaveBeenCalled();
  });
  it('rechecks authority after renewal and suppresses private errors or late credentials', async () => {
    const f = await fixture();
    f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await f.request('/refresh', JSON.stringify({ generation: f.snapshot.generation }))).status).toBe(403);
    f.authorize.mockResolvedValue(true);
    f.store.refresh.mockRejectedValueOnce(Error('credential-secret-canary'));
    const failed = await f.request('/refresh', JSON.stringify({ generation: f.snapshot.generation }));
    expect(failed.status).toBe(503);
    expect(failed.body).not.toContain('credential-secret-canary');
  });
  it('refuses to export a snapshot containing a master refresh credential or API key', async () => {
    const f = await fixture();
    for (const value of [
      { auth_mode: 'chatgpt', tokens: { refresh_token: 'master-canary' } },
      { auth_mode: 'apikey', OPENAI_API_KEY: 'api-canary' },
    ]) {
      f.store.cached.mockReturnValueOnce({ ...f.snapshot, authJson: JSON.stringify(value) });
      const result = await f.request();
      expect(result.status).toBe(503);
      expect(result.body).not.toContain('canary');
    }
  });
});
