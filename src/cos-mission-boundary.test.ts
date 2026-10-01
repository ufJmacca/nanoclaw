import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import {
  cosBoundary,
  hasCosStateBoundary,
  installCosBoundary,
  permitCosExecution,
  permitCosOutbound,
  prepareCosLaunch,
  setCosBoundaryHooks,
} from './cos-boundary.js';
import { installCosMissionBoundary, missionBoundary, type CosMissionIdentity } from './cos-mission-boundary.js';
import type { Session } from './types.js';

const identity: CosMissionIdentity = {
  scopeId: 'private-cos',
  missionId: 'mission-1',
  attemptId: 'attempt-1',
  generation: 1,
  agentGroupId: 'fresh-child-1',
  sessionId: 'fresh-session-1',
  provider: 'codex',
};
const child = {
  id: identity.sessionId,
  agent_group_id: identity.agentGroupId,
  messaging_group_id: null,
  agent_provider: 'codex',
  thread_id: null,
  status: 'active',
} as Session;
beforeEach(() => initTestDb());
afterEach(() => {
  setCosBoundaryHooks(null);
  closeDb();
});

describe('S05-T03/T04 permanent child identity restriction', () => {
  it('recognises a child without loading CoS or creating a messaging-group binding', async () => {
    installCosMissionBoundary(identity, getDb());
    expect(missionBoundary(child, getDb())).toEqual({ restricted: true, identity });
    expect(cosBoundary(child)).toMatchObject({ restricted: true, binding: null, paused: true });
    expect(hasCosStateBoundary(identity.agentGroupId, identity.sessionId)).toBe(true);
    expect(permitCosExecution(child)).toBe(false);
    await expect(prepareCosLaunch(child)).rejects.toThrow('restricted_launch_denied');
  });
  it('does not treat coordinator permission hooks as child authority', async () => {
    installCosMissionBoundary(identity, getDb());
    const launch = vi.fn(async () => ({ containerName: 'must-not-launch', args: [] }));
    setCosBoundaryHooks({
      executionReady: () => true,
      validatePrivateDestination: async () => true,
      ingress: async () => true,
      launch,
    });
    expect(permitCosExecution(child)).toBe(false);
    await expect(prepareCosLaunch(child)).rejects.toThrow('restricted_launch_denied');
    expect(launch).not.toHaveBeenCalled();
  });
  it.each(['self_mod', 'create_agent', 'schedule_task', 'send_message', 'cos_rpc'])(
    'rejects forged %s outbound rows before delegated authority exists',
    async (action) => {
      installCosMissionBoundary(identity, getDb());
      expect(
        await permitCosOutbound(child, {
          kind: 'system',
          channel_type: null,
          platform_id: null,
          thread_id: null,
          content: JSON.stringify({ action }),
        }),
      ).toBe(false);
    },
  );
  it('prevents a worker from acquiring a channel or reusing its group under another session', async () => {
    installCosMissionBoundary(identity, getDb());
    for (const patch of [
      { id: 'another-session' },
      { agent_group_id: 'another-group' },
      { messaging_group_id: 'owner-channel' },
      { thread_id: 'visual-thread' },
      { agent_provider: 'claude' },
      { status: 'closed' },
    ]) {
      const changed = { ...child, ...patch } as Session;
      expect(missionBoundary(changed, getDb())).toEqual({ restricted: true, identity: null });
      expect(cosBoundary(changed)).toMatchObject({ restricted: true, binding: null });
      expect(permitCosExecution(changed)).toBe(false);
      expect(
        await permitCosOutbound(changed, {
          kind: 'chat',
          channel_type: 'mattermost',
          platform_id: 'mattermost:instance:owner-channel',
          thread_id: null,
          content: '{"text":"secret"}',
        }),
      ).toBe(false);
    }
  });
  it('reconciles the exact identity once and rejects reused attempts, groups, sessions or generations', () => {
    installCosMissionBoundary(identity, getDb());
    installCosMissionBoundary({ ...identity }, getDb());
    expect(getDb().prepare('SELECT count(*) AS n FROM cos_mission_boundaries').get()).toEqual({ n: 1 });
    for (const patch of [
      { generation: 2 },
      { scopeId: 'foreign' },
      { missionId: 'another' },
      { attemptId: 'new-attempt' },
      { agentGroupId: 'new-group' },
      { sessionId: 'new-session' },
    ])
      expect(() => installCosMissionBoundary({ ...identity, ...patch }, getDb())).toThrow('mission_identity_conflict');
  });
  it('does not accept an identity with caller authority or invalid generation', () => {
    for (const patch of [
      { generation: 0 },
      { generation: 1.5 },
      { provider: 'claude' },
      { ownerId: 'owner' },
      { sessionId: '../session' },
    ])
      expect(() => installCosMissionBoundary({ ...identity, ...patch } as CosMissionIdentity, getDb())).toThrow(
        'invalid_mission_identity',
      );
  });
  it('rejects coordinator and child identity collisions in either allocation order', () => {
    const coordinator = {
      scopeId: 'private-cos',
      agentGroupId: identity.agentGroupId,
      sessionId: 'coordinator-session',
      messagingGroupId: 'mg',
      instanceId: 'instance',
      channelId: 'channel',
      ownerId: 'owner',
      botId: 'bot',
      provider: 'codex' as const,
    };
    installCosBoundary(coordinator, getDb());
    expect(() => installCosMissionBoundary(identity, getDb())).toThrow('mission_identity_conflict');
    const fresh = { ...identity, agentGroupId: 'unused-child', sessionId: 'unused-session' };
    installCosMissionBoundary(fresh, getDb());
    expect(() =>
      installCosBoundary(
        {
          ...coordinator,
          scopeId: 'second',
          agentGroupId: fresh.agentGroupId,
          messagingGroupId: 'mg2',
          sessionId: fresh.sessionId,
          channelId: 'channel2',
        },
        getDb(),
      ),
    ).toThrow('mission_identity_conflict');
  });
  it('denies malformed stored markers without falling back to an ordinary agent', () => {
    installCosMissionBoundary(identity, getDb());
    getDb().prepare('UPDATE cos_mission_boundaries SET identity=?').run('not-json');
    expect(missionBoundary(child, getDb())).toEqual({ restricted: true, identity: null });
    expect(cosBoundary(child)).toMatchObject({ restricted: true, binding: null });
  });
  it('leaves unrelated native sessions and groups available', async () => {
    installCosMissionBoundary(identity, getDb());
    const ordinary = { ...child, id: 'ordinary-session', agent_group_id: 'ordinary-group' };
    expect(missionBoundary(ordinary, getDb())).toEqual({ restricted: false });
    expect(cosBoundary(ordinary)).toEqual({ restricted: false });
    expect(hasCosStateBoundary(ordinary.agent_group_id, ordinary.id)).toBe(false);
    expect(permitCosExecution(ordinary)).toBe(true);
    expect(await prepareCosLaunch(ordinary)).toBeNull();
  });
});
