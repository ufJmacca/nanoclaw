import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import type { CosBinding } from '../../../cos-boundary.js';
import { ensureModelBudget } from './model-policy.js';
const state = vi.hoisted(() => ({ session: '', authorize: undefined as undefined | (() => Promise<boolean>) }));
vi.mock('../../../release-runtime.js', () => ({
  releaseMode: () => true,
  currentRelease: () => ({}),
  selectReleaseImage: async () => 'sha256:' + 'a'.repeat(64),
}));
vi.mock('../../../session-manager.js', () => ({ sessionDir: () => state.session }));
vi.mock('./model-gateway.js', () => ({
  startModelGateway: async (options: { socket: string; authorize(): Promise<boolean> }) => {
    state.authorize = options.authorize;
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(options.socket, resolve));
    return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  },
}));
import { createCoordinatorLauncher } from './coordinator-launcher.js';
describe('S01 coordinator admission', () => {
  it('requires separate consent, pins the safe launch, and rechecks ingress, quota and revocation on every model call', async () => {
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
    const launcher = createCoordinatorLauncher({ targetRoot: target, apiKey: 'SYNTHETIC_KEY', db });
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
      const launch = await launcher.prepare(binding, session, authorize);
      expect(launch.args).toContain('--network=none');
      expect(launch.args.join(' ')).not.toContain('SYNTHETIC_KEY');
      authorize.mockResolvedValue(null);
      expect(await state.authorize!()).toBe(false);
      authorize.mockResolvedValue('fixture-ingress');
      expect(await state.authorize!()).toBe(true);
      expect(await state.authorize!()).toBe(false);
      fs.unlinkSync(file);
      expect(launcher.ready(binding)).toBe(false);
      expect(await state.authorize!()).toBe(false);
    } finally {
      await launcher.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
