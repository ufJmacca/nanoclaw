import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSubscriptionAuthStore } from './codex-subscription-auth.js';

const roots: string[] = [];
const nativeAuth = (generation = 'old', account = 'fixture-account') => ({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: 'synthetic-id',
    access_token: `access-${generation}`,
    refresh_token: `refresh-${generation}`,
    account_id: account,
  },
  last_refresh: '2026-09-29T00:00:00.000Z',
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-native-auth-'));
  roots.push(root);
  const sourceFile = path.join(root, 'auth.json');
  const stateDirectory = path.join(root, 'broker');
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  fs.writeFileSync(sourceFile, JSON.stringify(nativeAuth()), { mode: 0o600 });
  return { root, sourceFile, stateDirectory };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('native Codex subscription credential owner', () => {
  it('keeps the admitted account binding across owner restarts and refuses an external account switch', () => {
    const options = setup();
    const owner = () => createSubscriptionAuthStore({ ...options, assertAuthority() {}, async nativeCheck() {} });
    owner().cached();
    fs.writeFileSync(options.sourceFile, JSON.stringify(nativeAuth('other', 'different-account')));
    expect(() => owner().cached()).toThrow('subscription_account_changed');
  });
  it('persists a minimum interval between real refresh attempts across owner reconstruction', async () => {
    const options = setup();
    let now = 100000,
      calls = 0;
    const owner = () =>
      createSubscriptionAuthStore({
        ...options,
        now: () => now,
        assertAuthority() {},
        async nativeCheck(directory) {
          calls++;
          fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify(nativeAuth(String(calls))));
        },
      });
    const first = owner();
    const updated = await first.refresh(first.cached().generation);
    await expect(owner().refresh(updated.generation)).rejects.toThrow('subscription_refresh_limited');
    expect(calls).toBe(1);
    now += 60000;
    await owner().refresh(updated.generation);
    expect(calls).toBe(2);
  });
  it('does not report a forced refresh as successful when native account inspection returns an unchanged cache', async () => {
    const options = setup();
    const store = createSubscriptionAuthStore({ ...options, assertAuthority() {}, async nativeCheck() {} });
    await expect(store.refresh(store.cached().generation)).rejects.toThrow('subscription_refresh_uncertain');
    expect(JSON.parse(fs.readFileSync(options.sourceFile, 'utf8')).tokens.access_token).toBe('access-old');
  });
  it('exports only access credentials after native checking, without changing the source on a read', async () => {
    const options = setup();
    const original = fs.readFileSync(options.sourceFile, 'utf8');
    const store = createSubscriptionAuthStore({
      ...options,
      assertAuthority() {},
      async nativeCheck(directory, mode) {
        expect(mode).toBe('check');
        expect(directory).not.toBe(path.dirname(options.sourceFile));
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'auth.json'), 'utf8')).tokens.refresh_token).toBe(
          'refresh-old',
        );
      },
    });
    const result = await store.prepare();
    const exported = JSON.parse(result.authJson);
    expect(exported.tokens.access_token).toBe('access-old');
    expect(exported.tokens.refresh_token).toBe('');
    expect(exported.OPENAI_API_KEY).toBeNull();
    expect(result.authJson).not.toContain('refresh-old');
    expect(fs.readFileSync(options.sourceFile, 'utf8')).toBe(original);
  });

  it('serializes competing refresh requests and discards stale generations', async () => {
    const options = setup();
    let refreshes = 0;
    const store = createSubscriptionAuthStore({
      ...options,
      assertAuthority() {},
      async nativeCheck(directory, mode) {
        if (mode === 'refresh') {
          refreshes++;
          await new Promise((r) => setTimeout(r, 10));
          fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify(nativeAuth('new')));
        }
      },
    });
    const original = store.cached();
    const results = await Promise.all([
      store.refresh(original.generation),
      store.refresh(original.generation),
      store.refresh(original.generation),
    ]);
    expect(refreshes).toBe(1);
    expect(new Set(results.map((r) => r.generation)).size).toBe(1);
    expect(JSON.parse(fs.readFileSync(options.sourceFile, 'utf8')).tokens.refresh_token).toBe('refresh-new');
    expect(fs.statSync(options.sourceFile).mode & 0o777).toBe(0o600);
  });

  it('preserves the primary login after a partial native write and does not retry an uncertain refresh', async () => {
    const options = setup();
    const original = fs.readFileSync(options.sourceFile, 'utf8');
    let calls = 0;
    const store = createSubscriptionAuthStore({
      ...options,
      assertAuthority() {},
      async nativeCheck(directory) {
        calls++;
        fs.writeFileSync(path.join(directory, 'auth.json'), '{partial');
        throw Error('private credential error must not escape');
      },
    });
    await expect(store.prepare()).rejects.toThrow('subscription_refresh_uncertain');
    expect(fs.readFileSync(options.sourceFile, 'utf8')).toBe(original);
    await expect(store.prepare()).rejects.toThrow('subscription_refresh_uncertain');
    expect(calls).toBe(1);
  });

  it('does not overwrite a newer login changed outside this operation', async () => {
    const options = setup();
    const store = createSubscriptionAuthStore({
      ...options,
      assertAuthority() {},
      async nativeCheck(directory) {
        fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify(nativeAuth('staged')));
        fs.writeFileSync(options.sourceFile, JSON.stringify(nativeAuth('external')));
      },
    });
    await expect(store.prepare()).rejects.toThrow('subscription_auth_changed');
    expect(JSON.parse(fs.readFileSync(options.sourceFile, 'utf8')).tokens.access_token).toBe('access-external');
  });

  it('refuses account switches and API authentication without altering the login', async () => {
    const options = setup();
    const store = createSubscriptionAuthStore({
      ...options,
      assertAuthority() {},
      async nativeCheck(directory) {
        fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify(nativeAuth('new', 'other-account')));
      },
    });
    await expect(store.prepare()).rejects.toThrow('subscription_refresh_uncertain');
    expect(JSON.parse(fs.readFileSync(options.sourceFile, 'utf8')).tokens.account_id).toBe('fixture-account');
    fs.writeFileSync(
      options.sourceFile,
      JSON.stringify({ ...nativeAuth(), auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-api' }),
    );
    expect(() => store.cached()).toThrow('subscription_auth_invalid');
  });

  it('requires host execution authority before accessing or publishing credentials', async () => {
    const options = setup();
    let allowed = false;
    let calls = 0;
    const store = createSubscriptionAuthStore({
      ...options,
      assertAuthority() {
        if (!allowed) throw Error('host_lease_required');
      },
      async nativeCheck(directory) {
        calls++;
        fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify(nativeAuth('new')));
        allowed = false;
      },
    });
    await expect(store.prepare()).rejects.toThrow('host_lease_required');
    expect(calls).toBe(0);
    allowed = true;
    await expect(store.prepare()).rejects.toThrow('host_lease_required');
    expect(JSON.parse(fs.readFileSync(options.sourceFile, 'utf8')).tokens.access_token).toBe('access-old');
    // A new legitimate owner can finish a durable, already checked update without refreshing twice.
    allowed = true;
    const restarted = createSubscriptionAuthStore({
      ...options,
      assertAuthority() {
        if (!allowed) throw Error('host_lease_required');
      },
      async nativeCheck() {
        throw Error('must_not_repeat_refresh');
      },
    });
    const recovered = await restarted.prepare();
    expect(JSON.parse(recovered.authJson).tokens.access_token).toBe('access-new');
    expect(calls).toBe(1);
  });

  it('rejects symlinks and unsafe permissions rather than reading through them', () => {
    const options = setup();
    const store = createSubscriptionAuthStore({ ...options, assertAuthority() {}, async nativeCheck() {} });
    fs.chmodSync(options.sourceFile, 0o644);
    expect(() => store.cached()).toThrow('subscription_auth_unsafe');
    fs.chmodSync(options.sourceFile, 0o600);
    const other = path.join(options.root, 'other.json');
    fs.renameSync(options.sourceFile, other);
    fs.symlinkSync(other, options.sourceFile);
    expect(() => store.cached()).toThrow('subscription_auth_unsafe');
  });
});
