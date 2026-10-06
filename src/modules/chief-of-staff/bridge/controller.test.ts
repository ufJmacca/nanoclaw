import Database from 'better-sqlite3';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installScheduledOrigin, scheduledContext } from '../automation/scheduled-origin.js';
import { CosController } from './controller.js';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import type { InboundEvent } from '../../../channels/adapter.js';
import type { Session } from '../../../types.js';
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const binding: CosBinding = {
  scopeId: 'scope',
  agentGroupId: 'group',
  messagingGroupId: 'mg',
  sessionId: 'session',
  provider: 'codex',
  instanceId: 'fixture',
  channelId: 'private',
  ownerId: 'owner',
  botId: 'bot',
};
const session = {
  id: 'session',
  agent_group_id: 'group',
  messaging_group_id: 'mg',
  thread_id: null,
  status: 'active',
  agent_provider: 'codex',
} as Session;
const now = Date.now();
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  installCosBoundary(binding, db);
  db.exec('UPDATE cos_identity_boundaries SET paused=0');
  const facts = vi
    .fn()
    .mockResolvedValue({ id: 'private', type: 'P', delete_at: 0, members: ['bot', 'owner'], activeSubscription: true });
  const verifyScheduled = vi.fn().mockResolvedValue(true);
  const decide = vi.fn().mockResolvedValue({ status: 'ok' }),
    acknowledge = vi.fn(),
    stop = vi.fn(),
    enabled = vi.fn().mockReturnValue(true),
    project = vi.fn(),
    wake = vi.fn().mockResolvedValue(undefined);
  return {
    db,
    facts,
    decide,
    acknowledge,
    stop,
    enabled,
    project,
    wake,
    verifyScheduled,
    controller: new CosController({
      verifyScheduled,
      db,
      facts,
      decide,
      acknowledge,
      stop,
      enabled,
      project,
      wake,
      session: () => session,
      now: () => now,
    }),
  };
}
const event = (text: string, id = 'ingress'): InboundEvent => ({
  channelType: 'mattermost',
  platformId: 'mattermost:fixture:private',
  threadId: null,
  message: {
    id,
    kind: 'chat',
    content: JSON.stringify({ senderId: 'mattermost:owner', text }),
    timestamp: new Date(now).toISOString(),
  },
});
const command = 'cos approve 11111111-1111-4111-8111-111111111111 abcdefghijklmnopqrstuvwxyz123456';
it('S11-UI01 scoped host pause/cancel controls remain available without the model or database and never project conversation input', async () => {
  const f = fixture();
  f.enabled.mockReturnValue(false);
  await f.controller.ingress(binding, event('cos cancel mission mission', 'offline-cancel'));
  expect(f.db.prepare('SELECT kind,target,state FROM cos_operator_denials').get()).toEqual({
    kind: 'cancel_mission',
    target: 'mission',
    state: 'recorded',
  });
  await f.controller.ingress(binding, event('cos pause admission', 'offline-pause'));
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  expect(f.stop).toHaveBeenCalledWith('session');
  expect(f.project).not.toHaveBeenCalled();
  expect(f.wake).not.toHaveBeenCalled();
  expect(f.decide).not.toHaveBeenCalled();
});
it('S11-UI01 malformed or quoted denial commands cannot become model instructions', async () => {
  const f = fixture();
  for (const text of [
    'please cos stop',
    '> cos cancel mission mission',
    'cos pause admission extra',
    'cos cancel mission ../../other',
  ])
    await f.controller.ingress(binding, event(text, text));
  expect(f.project).not.toHaveBeenCalled();
  expect(f.wake).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
});
it('S11-UI01 event identities cannot be reused to turn a prior status/message into a different stop command', async () => {
  const f = fixture();
  const controller = new CosController({
    ...f.controller.dependencies,
    inspect: vi.fn().mockResolvedValue({ status: 'unavailable' }),
  });
  await controller.ingress(binding, event('cos status', 'same-status'));
  await controller.ingress(binding, event('cos stop', 'same-status'));
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 0 });
  await controller.ingress(binding, event('hello', 'same-message'));
  await controller.ingress(binding, event('cos stop', 'same-message'));
  expect(f.stop).not.toHaveBeenCalled();
});
it('S11-UI01 control acknowledgements are private, stable and never resend after an ambiguous delivery', async () => {
  const f = fixture(),
    replyControl = vi.fn().mockRejectedValue(Error('PRIVATE_SEND_ERROR'));
  const controller = new CosController({ ...f.controller.dependencies, replyControl });
  await controller.ingress(binding, event('cos pause admission', 'control-reply'));
  await controller.ingress(binding, event('cos pause admission', 'control-reply'));
  expect(replyControl).toHaveBeenCalledOnce();
  expect(replyControl.mock.calls[0][2]).toMatchObject({
    state: 'admission_paused',
    effects: 'requires_reconciliation',
  });
  expect(f.db.prepare('SELECT state FROM cos_operator_requests').get()).toEqual({ state: 'delivery_uncertain' });
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
});
it('S11-UI01 owner status works while paused/model unavailable, without a model wake or changing admission', async () => {
  const f = fixture();
  f.enabled.mockReturnValue(false);
  f.db.exec('UPDATE cos_identity_boundaries SET paused=1');
  const inspect = vi.fn().mockResolvedValue({ status: 'ok', format: 'cos-operator-status/v1' }),
    reply = vi.fn().mockResolvedValue(true);
  const controller = new CosController({ ...f.controller.dependencies, inspect, replyStatus: reply });
  await controller.ingress(binding, event('cos status missions', 'status-event'));
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner', scopeId: 'scope' }), {
    category: 'missions',
  });
  expect(reply).toHaveBeenCalledOnce();
  expect(f.project).not.toHaveBeenCalled();
  expect(f.wake).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  await controller.ingress(binding, event('cos status missions', 'status-event'));
  expect(reply).toHaveBeenCalledOnce();
});
it('S11-UI01 database loss gives only unavailable metadata, and changed private membership prevents delivery', async () => {
  const f = fixture(),
    reply = vi.fn().mockResolvedValue(true),
    inspect = vi.fn().mockRejectedValue(new Error('PRIVATE_DATABASE_ERROR'));
  const controller = new CosController({ ...f.controller.dependencies, inspect, replyStatus: reply });
  await controller.ingress(binding, event('cos status', 'status-outage'));
  expect(reply.mock.calls[0][2]).toEqual({ status: 'unavailable' });
  f.facts.mockResolvedValue({
    id: 'private',
    type: 'O',
    delete_at: 0,
    members: ['owner', 'bot'],
    activeSubscription: true,
  });
  await controller.ingress(binding, event('cos status', 'status-public'));
  expect(reply).toHaveBeenCalledOnce();
});
it('S11-UI01 ambiguous delivery stays explicit and replay cannot send again or grant admission', async () => {
  const f = fixture(),
    reply = vi.fn().mockRejectedValue(new Error('PRIVATE_TRANSPORT_ERROR'));
  const controller = new CosController({
    ...f.controller.dependencies,
    inspect: vi.fn().mockResolvedValue({ status: 'ok' }),
    replyStatus: reply,
  });
  await controller.ingress(binding, event('cos status', 'status-uncertain'));
  await controller.ingress(binding, event('cos status', 'status-uncertain'));
  expect(reply).toHaveBeenCalledOnce();
  expect(f.db.prepare('SELECT state FROM cos_operator_requests WHERE ingress_id=?').get('status-uncertain')).toEqual({
    state: 'delivery_uncertain',
  });
});
describe('S01 deterministic host control and replay authority', () => {
  it('S01-UI08 persists emergency pause without model or PostgreSQL, even disabled', async () => {
    const f = fixture();
    f.enabled.mockReturnValue(false);
    f.decide.mockRejectedValue(new Error('database unavailable'));
    expect(await f.controller.ingress(binding, event('cos pause automation'))).toBe(true);
    expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
    expect(f.stop).toHaveBeenCalledWith('session');
    expect(f.decide).not.toHaveBeenCalled();
  });
  it('durably decides before acknowledging the native projection and never applies inline', async () => {
    const f = fixture();
    expect(await f.controller.ingress(binding, event(command))).toBe(true);
    expect(f.decide).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner', scopeId: 'scope', ingressId: 'ingress' }),
      expect.any(String),
      expect.any(String),
      'approve',
    );
    expect(f.acknowledge).toHaveBeenCalledOnce();
    expect(f.decide.mock.invocationCallOrder[0]).toBeLessThan(f.acknowledge.mock.invocationCallOrder[0]);
  });
  it('retains the approval projection when acknowledgement of database commit is uncertain', async () => {
    const f = fixture();
    f.decide.mockResolvedValue({ status: 'pending' });
    await f.controller.ingress(binding, event(command));
    expect(f.acknowledge).not.toHaveBeenCalled();
    f.decide.mockResolvedValue({ status: 'ok' });
    await f.controller.ingress(binding, event(command));
    expect(f.acknowledge).toHaveBeenCalledOnce();
  });
  it('admits a normal owner event once, derives RPC authority from host state and rechecks privacy', async () => {
    const f = fixture();
    expect(await f.controller.ingress(binding, event('what matters?'))).toBe(true);
    expect(f.project).toHaveBeenCalledOnce();
    expect(f.wake).toHaveBeenCalledOnce();
    expect(await f.controller.context(session)).toMatchObject({ ingressId: 'ingress', sessionId: 'session' });
    expect(await f.controller.ingress(binding, event('what matters?'))).toBe(true);
    expect(f.project).toHaveBeenCalledOnce();
    f.facts.mockResolvedValue({
      id: 'private',
      type: 'O',
      members: ['owner', 'bot'],
      delete_at: 0,
      activeSubscription: true,
    });
    expect(await f.controller.context(session)).toBeNull();
  });
  it('does not admit RPC when no verified ingress exists or the module is disabled', async () => {
    const f = fixture();
    expect(await f.controller.context(session)).toBeNull();
    await f.controller.ingress(binding, event('hello'));
    f.enabled.mockReturnValue(false);
    expect(await f.controller.context(session)).toBeNull();
  });
});

describe('S01 ingress projection crash recovery', () => {
  it('retries a pending projection after restart without admitting RPC prematurely', async () => {
    const f = fixture();
    f.project.mockImplementationOnce(() => {
      throw new Error('injected_before_projection');
    });
    await expect(f.controller.ingress(binding, event('hello'))).rejects.toThrow('injected_before_projection');
    expect(await f.controller.context(session)).toBeNull();
    expect(f.wake).not.toHaveBeenCalled();
    const restarted = new CosController(f.controller.dependencies);
    await restarted.ingress(binding, event('hello'));
    expect(f.project).toHaveBeenCalledTimes(2);
    expect(await restarted.context(session)).toMatchObject({ ingressId: 'ingress' });
    await restarted.ingress(binding, event('hello'));
    expect(f.project).toHaveBeenCalledTimes(2);
  });
  it('rejects changed payloads with the same pending ingress ID', async () => {
    const f = fixture();
    f.project.mockImplementationOnce(() => {
      throw new Error('injected_before_projection');
    });
    await expect(f.controller.ingress(binding, event('original'))).rejects.toThrow();
    await f.controller.ingress(binding, event('changed'));
    expect(f.project).toHaveBeenCalledOnce();
    expect(await f.controller.context(session)).toBeNull();
  });
  it('does not reauthorize older delivered ingress when a newer message is current', async () => {
    const f = fixture();
    await f.controller.ingress(binding, event('first', 'first'));
    await f.controller.ingress(binding, event('second', 'second'));
    await f.controller.ingress(binding, event('first', 'first'));
    expect(await f.controller.context(session)).toMatchObject({ ingressId: 'second' });
    expect(f.project).toHaveBeenCalledTimes(2);
  });
});

const lease = {
  runId: 'a'.repeat(64),
  generation: 1,
  hostId: 'host',
  deadlineAt: new Date(now + 120000).toISOString(),
};
describe('S04 scheduled origin admission and owner preemption', () => {
  it('uses the shared session with fresh remote run authority, without extending owner ingress', async () => {
    const f = fixture();
    expect(installScheduledOrigin(f.db, binding, session, lease, now)).toBe(true);
    expect(await f.controller.context(session)).toMatchObject({
      sessionId: 'session',
      origin: { kind: 'schedule', runId: lease.runId, generation: 1 },
    });
    expect(f.verifyScheduled).toHaveBeenCalledOnce();
    f.verifyScheduled.mockResolvedValue(false);
    expect(await f.controller.context(session)).toBeNull();
    f.verifyScheduled.mockRejectedValue(Error('database unavailable'));
    expect(await f.controller.context(session)).toBeNull();
    const noVerifier = new CosController({ ...f.controller.dependencies, verifyScheduled: undefined });
    expect(await noVerifier.context(session)).toBeNull();
  });
  it('fences a scheduled container before projecting fresh owner input, retaining the fence until reconciliation', async () => {
    const f = fixture();
    await f.controller.ingress(binding, event('first', 'first'));
    expect(installScheduledOrigin(f.db, binding, session, lease, now)).toBe(true);
    await f.controller.ingress(binding, event('first', 'first'));
    expect(f.stop).not.toHaveBeenCalled();
    f.project.mockImplementation(() => expect(f.controller.localContext(session)).toBeNull());
    await f.controller.ingress(binding, event('new', 'new'));
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(f.project.mock.invocationCallOrder[1]);
    expect(scheduledContext(session, f.db, now)).toBeNull();
    expect(await f.controller.context(session)).toBeNull();
  });
  it('rejects a scheduled verification that races with pause or fresh owner ingress', async () => {
    const f = fixture();
    installScheduledOrigin(f.db, binding, session, lease, now);
    let finish!: (value: boolean) => void;
    f.verifyScheduled.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.controller.context(session);
    await vi.waitFor(() => expect(f.verifyScheduled).toHaveBeenCalledOnce());
    await f.controller.ingress(binding, event('new', 'new'));
    finish(true);
    expect(await pending).toBeNull();
  });
});
