import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSubscriptionCredentialClient } from './codex-credential-client.js';

test('refreshes only the access cache while retaining provider history and expected generation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-client-'));
  const home = path.join(directory, 'home');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, '.codex'), { mode: 0o700 });
  fs.writeFileSync(path.join(home, '.codex', 'session-marker'), 'keep this history');
  const seen: Array<{ url: string; body: string }> = [];
  let unsafe = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (x) => (body += x));
    req.on('end', () => {
      seen.push({ url: req.url!, body });
      res.end(
        JSON.stringify({
          version: 1,
          generation: 'a'.repeat(64),
          authJson: JSON.stringify({
            auth_mode: 'chatgpt',
            OPENAI_API_KEY: null,
            tokens: {
              access_token: 'access-fixture',
              id_token: 'id-fixture',
              account_id: 'account-fixture',
              refresh_token: unsafe ? 'master-canary' : '',
            },
            last_refresh: '2026-09-29T00:00:00Z',
          }),
        }),
      );
    });
  });
  const socketPath = path.join(directory, 'credentials.sock');
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const client = createSubscriptionCredentialClient({ socketPath, home });
    await client.prepare();
    await client.refresh();
    expect(seen).toEqual([
      { url: '/cached', body: '{}' },
      { url: '/refresh', body: JSON.stringify({ generation: 'a'.repeat(64) }) },
    ]);
    const authFile = path.join(home, '.codex', 'auth.json'),
      original = fs.readFileSync(authFile, 'utf8');
    expect(JSON.parse(original).tokens.refresh_token).toBe('');
    expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(home, '.codex', 'session-marker'), 'utf8')).toBe('keep this history');
    unsafe = true;
    await expect(client.prepare()).rejects.toThrow('subscription_credentials_unavailable');
    expect(fs.readFileSync(authFile, 'utf8')).toBe(original);
    unsafe = false;
    const cancellation = new AbortController();
    cancellation.abort();
    const before = seen.length;
    await expect(
      createSubscriptionCredentialClient({ socketPath, home, signal: cancellation.signal }).prepare(),
    ).rejects.toThrow('subscription_credentials_unavailable');
    expect(seen).toHaveLength(before);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not attempt renewal before receiving an admitted snapshot', async () => {
  const client = createSubscriptionCredentialClient();
  await expect(client.refresh()).rejects.toThrow('subscription_credentials_unavailable');
});
