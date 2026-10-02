import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
const fixture = vi.hoisted(() => ({ root: '/tmp/cos-mission-launch-' + process.pid }));
vi.mock('../../../config.js', async () => ({
  ...(await vi.importActual('../../../config.js')),
  DATA_DIR: fixture.root + '/data',
}));
vi.mock('../../../release-runtime.js', () => ({
  releaseMode: () => true,
  currentRelease: () => ({}),
  selectReleaseImage: async () => 'sha256:' + 'a'.repeat(64),
}));
import { initTestDb, closeDb, getDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { getSession } from '../../../db/sessions.js';
import { type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { isCosMissionStopped, stopCosMissionAttempt } from '../../../cos-mission-stop.js';
import { digest } from '../domain/contracts.js';
import { MISSION_DEFAULT_LIMITS } from '../contracts/mission-protocol.js';
import { sealResearchWorkOrder, RESEARCH_TEMPLATE } from './work-order.js';
import { NativeMissionAllocation } from './native-allocation.js';
import { createMissionLauncher } from './launcher.js';
import { ensureModelBudget, type SubscriptionActivation } from '../bridge/model-policy.js';
import {
  createSubscriptionCoordinator,
  installSubscriptionCoordinator,
} from '../../../providers/codex-subscription-coordinator.js';
function input(policy: SubscriptionActivation, canary = 'A', contextGeneration = policy.contextGeneration) {
  const identity: CosMissionIdentity = {
    scopeId: 'private',
    missionId: 'mission-' + randomUUID(),
    attemptId: randomUUID(),
    generation: 1,
    agentGroupId: 'cos-mission-' + randomUUID(),
    sessionId: randomUUID(),
    provider: 'codex',
  };
  const order = sealResearchWorkOrder({
    missionId: identity.missionId,
    request: {
      question: 'Compare note ' + canary,
      goal_id: null,
      project_id: null,
      sources: [{ source_id: 'note-' + canary, revision_id: 'rev-' + canary }],
      acceptance_criteria: [{ id: 'comparison', description: 'Cite the note.' }],
      limits: { ...MISSION_DEFAULT_LIMITS },
    },
    origin: {
      scopeId: 'private',
      ownerId: 'owner',
      sessionId: 'main',
      agentGroupId: 'main',
      ingressId: 'ingress',
      bindingDigest: digest('binding'),
      delegationDigest: 'd'.repeat(64),
      contextGeneration,
    },
    related: { goal: null, project: null },
    sources: [
      {
        source_id: 'note-' + canary,
        revision_id: 'rev-' + canary,
        source_version: 1,
        revision_digest: digest(canary),
        title: 'Note ' + canary,
        status: 'current',
        chunks: [{ ordinal: 0, start_line: 1, end_line: 1, text: 'CANARY_' + canary }],
      },
    ],
    provider: { profile: RESEARCH_TEMPLATE.providerProfile, model: 'fixture', policyDigest: digest(policy) },
    reviewedTemplateDigest: digest(RESEARCH_TEMPLATE),
    issuedAt: new Date().toISOString(),
  });
  return { identity, order, inputId: 'cos-mission-input-' + randomUUID() };
}

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  runMigrations(initTestDb());
  ensureModelBudget(getDb());
  fs.mkdirSync(fixture.root, { recursive: true, mode: 0o700 });
  for (const dir of ['data', 'target', 'missions', 'credentials'])
    fs.mkdirSync(fixture.root + '/' + dir, { mode: 0o700 });
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  closeDb();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});
async function setup() {
  const policy: SubscriptionActivation = {
    version: 2,
    runtime: 'codex-subscription/v1',
    activationId: 'a'.repeat(32),
    consentRef: 'fixture-owner',
    scopeId: 'private',
    provider: 'codex',
    model: 'fixture',
    maxAttempts: 8,
    accountFingerprint: createHash('sha256').update('fixture-account').digest('hex'),
    contextGeneration: randomUUID(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  const savePolicy = (value: unknown = policy) =>
    fs.writeFileSync(fixture.root + '/target/model-activation.json', JSON.stringify(value), { mode: 0o600 });
  savePolicy();
  const owner = createSubscriptionCoordinator({
    root: fixture.root + '/credentials',
    assertAuthority() {},
    authorizeSession: async () => true,
    store: {
      cached: () => ({
        generation: 'a'.repeat(64),
        authJson: JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            account_id: 'fixture-account',
            access_token: 'fixture-secret',
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
  const uninstall = installSubscriptionCoordinator(owner);
  cleanup.push(async () => {
    uninstall();
    await owner.close();
  });
  const reserve = vi.fn(async () => ({ status: 'ok' as const, reserved: true }));
  const running = vi.fn(() => false),
    authorize = vi.fn(async () => true);
  const currentAuthority = {
    bindingDigest: digest('binding'),
    delegationDigest: 'd'.repeat(64),
    contextGeneration: policy.contextGeneration,
    provider: { profile: RESEARCH_TEMPLATE.providerProfile, model: policy.model, policyDigest: digest(policy) },
  };
  const authority = vi.fn(() => currentAuthority);
  const launcher = createMissionLauncher({
    targetRoot: fixture.root + '/target',
    db: getDb(),
    runs: { reserve },
    running,
    authority,
  });
  cleanup.push(() => launcher.shutdown());
  const allocate = async (canary = 'A') => {
    const value = input(policy, canary, currentAuthority.contextGeneration),
      paths = await new NativeMissionAllocation({ root: fixture.root + '/missions' }).prepare(value, async () => true);
    return { value, paths, session: getSession(value.identity.sessionId)! };
  };
  return { policy, savePolicy, launcher, reserve, running, authorize, allocate, currentAuthority, authority };
}
function mount(args: string[], destination: string) {
  return args
    .find((a) => a.includes('dst=' + destination))!
    .split(',')
    .find((a) => a.startsWith('src='))!
    .slice(4);
}
function turn(socket: string, attemptId: string, route = '/begin') {
  return new Promise<number>((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: route, method: 'POST' }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode!));
    });
    request.once('error', reject);
    request.end(JSON.stringify({ attemptId }));
  });
}
it('S05 launcher reuses the subscription owner with exact isolated native allocations and no credential values in config', async () => {
  const f = await setup(),
    a = await f.allocate('A'),
    b = await f.allocate('B');
  const launchA = await f.launcher.prepare(a.value, a.paths, a.session, f.authorize),
    launchB = await f.launcher.prepare(b.value, b.paths, b.session, f.authorize);
  expect(mount(launchA.args, '/home/node/.codex')).toBe(a.paths.providerDirectory);
  expect(mount(launchB.args, '/home/node/.codex')).toBe(b.paths.providerDirectory);
  expect(mount(launchA.args, '/run/cos/turn.sock')).not.toBe(mount(launchB.args, '/run/cos/turn.sock'));
  expect(mount(launchA.args, '/run/nanoclaw/codex-credentials.sock')).not.toBe(
    mount(launchB.args, '/run/nanoclaw/codex-credentials.sock'),
  );
  const config = JSON.parse(fs.readFileSync(mount(launchA.args, '/workspace/agent/container.json'), 'utf8'));
  expect(config.mission.attemptId).toBe(a.value.identity.attemptId);
  expect(config.contextGeneration).not.toBe(f.policy.contextGeneration);
  expect(JSON.stringify(config) + launchA.args.join(' ')).not.toContain('fixture-secret');
  expect(launchA.args.join(' ')).not.toContain(b.paths.contextDirectory);
  expect(fs.readdirSync(fixture.root + '/target').filter((name) => !name.startsWith('mission-'))).toEqual([
    'model-activation.json',
  ]);
});
it('S05 actual turn socket requires one fresh root reservation and counts the existing subscription allowance', async () => {
  const f = await setup(),
    a = await f.allocate();
  const launch = await f.launcher.prepare(a.value, a.paths, a.session, f.authorize),
    socket = mount(launch.args, '/run/cos/turn.sock');
  f.reserve.mockResolvedValueOnce({ status: 'ok', reserved: false });
  expect(await turn(socket, randomUUID())).toBe(403);
  expect(getDb().prepare('SELECT count(*) AS n FROM cos_model_attempts').get()).toEqual({ n: 0 });
  const id = randomUUID();
  expect(await turn(socket, id)).toBe(200);
  expect(await turn(socket, id, '/end')).toBe(200);
  expect(f.reserve.mock.calls[1]).toEqual([
    a.value.identity,
    'model-' + id,
    'model',
    expect.stringMatching(/^[a-f0-9]{64}$/),
  ]);
  expect(getDb().prepare('SELECT count(*) AS n FROM cos_model_attempts').get()).toEqual({ n: 1 });
  f.authorize.mockResolvedValue(false);
  expect(await turn(socket, randomUUID())).toBe(403);
  expect(f.reserve).toHaveBeenCalledTimes(2);
});
it('S05 launcher accepts host-verified renewed main context without changing the policy generation or child isolation', async () => {
  const f = await setup();
  f.currentAuthority.contextGeneration = randomUUID();
  const a = await f.allocate();
  const launch = await f.launcher.prepare(a.value, a.paths, a.session, f.authorize);
  expect(mount(launch.args, '/home/node/.codex')).toBe(a.paths.providerDirectory);
  expect(a.value.order.body.origin.contextGeneration).not.toBe(f.policy.contextGeneration);
  expect(await turn(mount(launch.args, '/run/cos/turn.sock'), randomUUID())).toBe(200);
  expect(f.authority).toHaveBeenCalledWith({
    scopeId: 'private',
    ownerId: 'owner',
    agentGroupId: 'main',
    sessionId: 'main',
    ingressId: 'ingress',
  });
});
it('S05 delegation change closes an existing worker and prevents another launch under the old authority', async () => {
  const f = await setup(),
    a = await f.allocate(),
    b = await f.allocate('B');
  const launch = await f.launcher.prepare(a.value, a.paths, a.session, f.authorize);
  f.currentAuthority.delegationDigest = 'e'.repeat(64);
  expect(await turn(mount(launch.args, '/run/cos/turn.sock'), randomUUID())).toBe(403);
  expect(f.reserve).not.toHaveBeenCalled();
  expect(isCosMissionStopped(a.value.identity, getDb())).toBe(true);
  await expect(f.launcher.prepare(b.value, b.paths, b.session, f.authorize)).rejects.toThrow('mission_launch_denied');
});
it('S05 changed policy or revoked local identity closes turns; expired consent cannot prepare another launch', async () => {
  const f = await setup(),
    a = await f.allocate(),
    launch = await f.launcher.prepare(a.value, a.paths, a.session, f.authorize);
  const socket = mount(launch.args, '/run/cos/turn.sock');
  f.savePolicy({ ...f.policy, model: 'other' });
  expect(await turn(socket, randomUUID())).toBe(403);
  expect(f.reserve).not.toHaveBeenCalled();
  f.savePolicy();
  stopCosMissionAttempt(a.value.identity, 'authority_lost', getDb());
  expect(await turn(socket, randomUUID())).toBe(403);
  const b = await f.allocate('B');
  f.savePolicy({ ...f.policy, expiresAt: '2000-01-01T00:00:00Z' });
  await expect(f.launcher.prepare(b.value, b.paths, b.session, f.authorize)).rejects.toThrow('mission_launch_denied');
});
it('S05 launcher refuses foreign paths, replaced sessions and duplicate preparation while a child is running', async () => {
  const f = await setup(),
    a = await f.allocate(),
    b = await f.allocate('B');
  await expect(f.launcher.prepare(a.value, b.paths, a.session, f.authorize)).rejects.toThrow('mission_launch_denied');
  await expect(f.launcher.prepare(a.value, a.paths, b.session, f.authorize)).rejects.toThrow('mission_launch_denied');
  f.running.mockReturnValue(true);
  await expect(f.launcher.prepare(a.value, a.paths, a.session, f.authorize)).rejects.toThrow('mission_launch_denied');
});
it('S05 an uncertain root reservation durably fences this child even after database authority returns', async () => {
  const f = await setup(),
    a = await f.allocate();
  const launch = await f.launcher.prepare(a.value, a.paths, a.session, f.authorize),
    socket = mount(launch.args, '/run/cos/turn.sock');
  f.reserve.mockRejectedValueOnce(new Error('fixture database unavailable'));
  expect(await turn(socket, randomUUID())).toBe(403);
  expect(isCosMissionStopped(a.value.identity, getDb())).toBe(true);
  expect(await turn(socket, randomUUID())).toBe(403);
  expect(f.reserve).toHaveBeenCalledTimes(1);
  await f.launcher.close(a.session.id);
  expect(fs.existsSync(socket)).toBe(false);
  expect(fs.existsSync(a.paths.providerDirectory)).toBe(true);
  await expect(f.launcher.prepare(a.value, a.paths, a.session, f.authorize)).rejects.toThrow('mission_launch_denied');
});
