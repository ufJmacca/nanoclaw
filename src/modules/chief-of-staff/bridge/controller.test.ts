import Database from 'better-sqlite3';
import { describe, it, expect, vi, afterEach } from 'vitest';
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
    controller: new CosController({
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
