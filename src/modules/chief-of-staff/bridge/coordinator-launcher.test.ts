import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import type { CosBinding } from '../../../cos-boundary.js';
import { ensureModelBudget } from './model-policy.js';
const state = vi.hoisted(() => ({ session: '' }));
vi.mock('../../../release-runtime.js', () => ({
  releaseMode: () => true,
  currentRelease: () => ({}),
  selectReleaseImage: async () => 'sha256:' + 'a'.repeat(64),
}));
vi.mock('../../../session-manager.js', () => ({ sessionDir: () => state.session }));
import { createCoordinatorLauncher } from './coordinator-launcher.js';
import {
  createSubscriptionCoordinator,
  installSubscriptionCoordinator,
} from '../../../providers/codex-subscription-coordinator.js';
describe('S01 coordinator admission', () => {
  it('uses the existing subscription owner and durable context with no API credential', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-native-coordinator-'));
    const target = path.join(root, 'target'),
      credentialRoot = path.join(root, 'credentials');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.mkdirSync(credentialRoot, { mode: 0o700 });
    state.session = path.join(root, 'cos-v1');
    fs.mkdirSync(state.session, { mode: 0o700 });
    fs.writeFileSync(path.join(state.session, 'inbound.db'), 'fixture');
    const db = new Database(':memory:');
    ensureModelBudget(db);
    const binding = { scopeId: 'native', provider: 'codex', agentGroupId: 'group', sessionId: 'session' } as CosBinding;
    const credentials = createSubscriptionCoordinator({
      root: credentialRoot,
      assertAuthority() {},
      authorizeSession: async () => true,
      store: {
        cached: () => ({
          generation: 'a'.repeat(64),
          authJson: JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
              account_id: 'fixture-account',
              access_token: 'fixture-access',
              id_token: 'fixture-id',
              refresh_token: '',
            },
          }),
        }),
        refresh: async () => {
          throw Error('unused');
        },
      },
    });
    const uninstall = installSubscriptionCoordinator(credentials);
    const launcher = createCoordinatorLauncher({ targetRoot: target, db });
    try {
      const context = launcher.context(binding);
      const policy = {
        version: 2,
        runtime: 'codex-subscription/v1',
        activationId: 'c'.repeat(32),
        consentRef: 'fixture',
        scopeId: binding.scopeId,
        provider: 'codex',
        model: 'fixture-model',
        maxAttempts: 1,
        accountFingerprint: context.accountFingerprint,
        contextGeneration: context.generation,
        expiresAt: '2030-01-01T00:00:00Z',
      };
      fs.writeFileSync(path.join(target, 'model-activation.json'), JSON.stringify(policy), { mode: 0o600 });
      expect(launcher.ready(binding)).toBe(true);
      const reserve = vi.fn().mockResolvedValue(false);
      const authorize = Object.assign(
        vi.fn(async (_mode?: 'poll'): Promise<string | null> => 'ingress'),
        { reserve },
      );
      const launch = await launcher.prepare(binding, { id: 'session' } as Session, authorize);
      expect(launch.args).toContain(`type=bind,src=${context.directory},dst=/home/node/.codex`);
      expect(launch.args.some((arg) => arg.includes('dst=/run/cos/turn.sock'))).toBe(true);
      expect(launch.args.join(' ')).not.toContain('fixture-access');
      expect(launcher.context(binding)).toEqual(context);

      const turnSocket = path.join(
        target,
        fs
          .readdirSync(target, { withFileTypes: true })
          .find((entry) => entry.isDirectory() && entry.name.startsWith('model-'))!.name,
        'turn.sock',
      );
      const begin = () =>
        new Promise<number | undefined>((resolve, reject) => {
          const request = http.request({ socketPath: turnSocket, path: '/begin', method: 'POST' }, (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
          });
          request.once('error', reject);
          request.end(JSON.stringify({ attemptId: randomUUID() }));
        });
      expect(await begin()).toBe(403);
      expect(reserve).toHaveBeenCalledOnce();
      // Polling success cannot admit a new turn after a fresh check denies it.
      authorize.mockImplementation(async (mode) => (mode === 'poll' ? 'ingress' : null));
      expect(await begin()).toBe(403);
      // A running container cannot transfer its allowance to a different origin.
      authorize.mockResolvedValue('new-ingress');
      reserve.mockResolvedValue(true);
      expect(await begin()).toBe(403);
      expect(reserve).toHaveBeenCalledOnce();
      launcher.invalidate(binding.scopeId);
      expect(launcher.ready(binding)).toBe(false);
    } finally {
      await launcher.close();
      uninstall();
      await credentials.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses a legacy API-only activation without a bound subscription owner and context', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-coordinator-'));
    const target = path.join(root, 'target');
    fs.mkdirSync(target, { mode: 0o700 });
    state.session = path.join(root, 'cos-v1');
    fs.mkdirSync(state.session, { mode: 0o700 });
    fs.writeFileSync(path.join(state.session, 'inbound.db'), 'fixture');
    const db = new Database(':memory:');
    ensureModelBudget(db);
    const binding = { scopeId: 'fixture', provider: 'codex', agentGroupId: 'fixture-group' } as CosBinding;
    const session = { id: 'fixture-session' } as Session;
    const authorize = vi.fn().mockResolvedValue('fixture-ingress');
    const launcher = createCoordinatorLauncher({ targetRoot: target, db });
    try {
      expect(launcher.ready(binding)).toBe(false);
      await expect(launcher.prepare(binding, session, authorize)).rejects.toThrow('restricted_launch_denied');
      const file = path.join(target, 'model-activation.json');
      const policy = {
        version: 1,
        activationId: 'b'.repeat(32),
        consentRef: 'fixture-only',
        scopeId: 'fixture',
        provider: 'codex',
        model: 'fixture-model',
        maxRequests: 1,
        expiresAt: '2030-01-01T00:00:00Z',
      };
      fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
      await expect(launcher.prepare(binding, session, authorize)).rejects.toThrow('restricted_launch_denied');
      fs.unlinkSync(file);
      expect(launcher.ready(binding)).toBe(false);
    } finally {
      await launcher.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
