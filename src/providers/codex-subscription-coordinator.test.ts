import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createSubscriptionCoordinator, installSubscriptionCoordinator } from './codex-subscription-coordinator.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import './codex.js';
import type { Session } from '../types.js';

describe('shared subscription coordinator integration', () => {
  it('replaces only ordinary session credentials and contributes the runtime flag without API fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-owner-')),
      sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir);
    const codexDir = path.join(sessionDir, 'codex');
    fs.mkdirSync(codexDir);
    fs.writeFileSync(path.join(codexDir, 'history-marker'), 'retained');
    fs.writeFileSync(path.join(codexDir, 'auth.json'), 'old-master-canary');
    const coordinator = createSubscriptionCoordinator({
      root,
      store: {
        cached: () => ({ generation: 'a'.repeat(64), authJson: 'access-only-fixture' }),
        refresh: async () => {
          throw Error('unused');
        },
      },
      assertAuthority() {},
      authorizeSession: async () => true,
    });
    const uninstall = installSubscriptionCoordinator(coordinator);
    try {
      const result = getProviderContainerConfig('codex')!({
        sessionDir,
        agentGroupId: 'group',
        hostEnv: {
          HOME: root,
          OPENAI_API_KEY: 'api-canary',
          OPENAI_BASE_URL: 'https://api.invalid',
          CODEX_MODEL: 'selected-model',
        },
      });
      expect(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8')).toBe('access-only-fixture');
      expect(fs.readFileSync(path.join(codexDir, 'history-marker'), 'utf8')).toBe('retained');
      expect(fs.statSync(codexDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(codexDir, 'auth.json')).mode & 0o777).toBe(0o600);
      expect(result.env).toMatchObject({ NANOCLAW_CODEX_SUBSCRIPTION: '1', CODEX_MODEL: 'selected-model' });
      expect(result.env?.OPENAI_API_KEY).toBeUndefined();
      expect(result.env?.OPENAI_BASE_URL).toBeUndefined();
      await coordinator.close();
      expect(() =>
        getProviderContainerConfig('codex')!({ sessionDir, agentGroupId: 'group', hostEnv: { HOME: root } }),
      ).toThrow('subscription_owner_closed');
    } finally {
      uninstall();
      await coordinator.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('creates a session socket only while authorized and removes it when the session closes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-owner-'));
    let allowed = true;
    const coordinator = createSubscriptionCoordinator({
      root,
      store: {
        cached: () => {
          throw Error('unused');
        },
        refresh: async () => {
          throw Error('unused');
        },
      },
      assertAuthority() {},
      authorizeSession: async () => allowed,
    });
    try {
      const session = { id: 'session', agent_group_id: 'group', status: 'active' } as Session;
      const mount = await coordinator.prepare(session);
      expect(mount.readonly).toBe(true);
      expect(fs.statSync(mount.hostPath).isSocket()).toBe(true);
      await coordinator.closeSession(session.id);
      expect(fs.existsSync(mount.hostPath)).toBe(false);
      allowed = false;
      await expect(coordinator.prepare(session)).rejects.toThrow('subscription_session_denied');
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      await coordinator.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
