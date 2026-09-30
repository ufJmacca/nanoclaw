import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, expect, vi } from 'vitest';
import { startHostSubscriptionCredentials } from './codex-subscription-runtime.js';
import { subscriptionCoordinator } from './codex-subscription-coordinator.js';
it('installs one lease-fenced owner without a model request or login mutation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-runtime-')),
    home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, '.codex'), { mode: 0o700 });
  const original = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access', id_token: 'id', account_id: 'account', refresh_token: 'master' },
    last_refresh: '2026-09-29T00:00:00Z',
  });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), original, { mode: 0o600 });
  const image = vi.fn();
  let authorized = true;
  const runtime = startHostSubscriptionCredentials({
    root,
    home,
    model: 'gpt-6-astra',
    image,
    assertAuthority() {
      if (!authorized) throw Error('lost lease');
    },
    authorizeSession: async () => true,
  });
  try {
    expect(subscriptionCoordinator()).toBe(runtime.coordinator);
    expect(image).not.toHaveBeenCalled();
    expect(JSON.parse(runtime.coordinator.cached().authJson).tokens.refresh_token).toBe('');
    expect(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).toBe(original);
    authorized = false;
    expect(() => runtime.coordinator.cached()).toThrow('lost lease');
    await runtime.coordinator.close();
    expect(() => runtime.coordinator.cached()).toThrow('subscription_owner_closed');
    expect(subscriptionCoordinator()).toBe(runtime.coordinator);
  } finally {
    runtime.uninstall();
    await runtime.coordinator.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
