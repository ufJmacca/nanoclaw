import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { createSession, updateSession } from './db/sessions.js';
import { installCosMissionBoundary, type CosMissionIdentity } from './cos-mission-boundary.js';
import { stopCosMissionAttempt } from './cos-mission-stop.js';
import { permitCosExecution, prepareCosLaunch, permitCosOutbound } from './cos-boundary.js';
import { installCosMissionExecutionHooks } from './cos-mission-execution.js';
import type { Session } from './types.js';
const identity: CosMissionIdentity = {
  scopeId: 'private',
  missionId: 'mission',
  attemptId: 'attempt',
  generation: 1,
  agentGroupId: 'worker',
  sessionId: 'session',
  provider: 'codex',
};
const session: Session = {
  id: 'session',
  agent_group_id: 'worker',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: 'codex',
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-10-02T00:00:00Z',
};
let remove = () => {};
beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({
    id: 'worker',
    name: 'worker',
    folder: 'worker',
    agent_provider: 'codex',
    created_at: session.created_at,
  });
  createSession(session);
  installCosMissionBoundary(identity, getDb());
});
afterEach(() => {
  remove();
  closeDb();
});
it('S05-T01/T04 grants only the dedicated restricted execution hook and still rejects all generic outbound tools', async () => {
  expect(permitCosExecution(session)).toBe(false);
  const launch = vi.fn(async () => ({ containerName: 'fixture-child', args: ['restricted-fixture'] }));
  remove = installCosMissionExecutionHooks({ ready: () => true, launch });
  expect(permitCosExecution(session)).toBe(true);
  expect(await prepareCosLaunch(session)).toEqual({ containerName: 'fixture-child', args: ['restricted-fixture'] });
  expect(launch).toHaveBeenCalledWith(identity, session);
  for (const action of ['send_message', 'create_agent', 'schedule_task', 'self_mod', 'cos_rpc'])
    expect(
      await permitCosOutbound(session, {
        kind: 'system',
        channel_type: null,
        platform_id: null,
        thread_id: null,
        content: JSON.stringify({ action }),
      }),
    ).toBe(false);
  remove();
  expect(permitCosExecution(session)).toBe(false);
});
it.each(['stop', 'closed', 'rewired', 'replaced', 'denied'])(
  'S05-T07 rechecks %s while preparing a child launch',
  async (change) => {
    let ready = true;
    remove = installCosMissionExecutionHooks({
      ready: () => ready,
      launch: async () => {
        if (change === 'stop') stopCosMissionAttempt(identity, 'authority_lost', getDb());
        if (change === 'closed') updateSession(session.id, { status: 'closed' });
        if (change === 'rewired')
          getDb().prepare("UPDATE sessions SET agent_provider='claude' WHERE id=?").run(session.id);
        if (change === 'replaced') {
          remove();
          remove = installCosMissionExecutionHooks({
            ready: () => true,
            launch: async () => ({ containerName: 'different', args: [] }),
          });
        }
        if (change === 'denied') ready = false;
        return { containerName: 'must-not-start', args: [] };
      },
    });
    await expect(prepareCosLaunch(session)).rejects.toThrow('restricted_launch_denied');
  },
);
it('S05-T03 a stale passed session cannot override the actual native identity or a malformed permanent marker', async () => {
  remove = installCosMissionExecutionHooks({
    ready: () => true,
    launch: async () => ({ containerName: 'never', args: [] }),
  });
  getDb().prepare("UPDATE cos_mission_boundaries SET identity='broken' WHERE attempt_id=?").run(identity.attemptId);
  expect(permitCosExecution(session)).toBe(false);
  await expect(prepareCosLaunch(session)).rejects.toThrow('restricted_launch_denied');
});
const rpcMessage = () => ({
  kind: 'system',
  channel_type: null,
  platform_id: null,
  thread_id: null,
  content: JSON.stringify({
    action: 'cos_mission_rpc',
    delivery_id: '11111111-1111-4111-8111-111111111111',
    request: {
      protocol: 'cos-mission-rpc/v1',
      request_id: '22222222-2222-4222-8222-222222222222',
      method: 'cos_mission_context_get',
      params: {},
    },
  }),
});
it('S05-T03/T04 admits only valid specialist RPC through a dedicated current grant', async () => {
  const rpc = vi.fn(async () => true);
  expect(await permitCosOutbound(session, rpcMessage())).toBe(false);
  remove = installCosMissionExecutionHooks({
    ready: () => true,
    launch: async () => ({ containerName: 'child', args: [] }),
    rpc,
  });
  expect(await permitCosOutbound(session, rpcMessage())).toBe(true);
  expect(rpc).toHaveBeenCalledWith(identity, session);
  for (const patch of [
    { kind: 'chat' },
    { channel_type: 'mattermost' },
    { platform_id: 'private' },
    { thread_id: 'thread' },
    { content: 'broken' },
    { content: JSON.stringify({ ...JSON.parse(rpcMessage().content), action: 'cos_rpc' }) },
    { content: ' '.repeat(25000) + rpcMessage().content },
  ])
    expect(await permitCosOutbound(session, { ...rpcMessage(), ...patch })).toBe(false);
  expect(rpc).toHaveBeenCalledTimes(1);
});
it.each(['stop', 'closed', 'replaced', 'denied', 'unavailable'])(
  'S05-T07/T10 rechecks %s before allowing specialist RPC',
  async (change) => {
    let ready = true;
    const launch = async () => ({ containerName: 'child', args: [] });
    remove = installCosMissionExecutionHooks({
      ready: () => ready,
      launch,
      rpc: async () => {
        if (change === 'stop') stopCosMissionAttempt(identity, 'authority_lost', getDb());
        if (change === 'closed') updateSession(session.id, { status: 'closed' });
        if (change === 'replaced') {
          remove();
          remove = installCosMissionExecutionHooks({ ready: () => true, launch, rpc: async () => true });
        }
        if (change === 'denied') ready = false;
        if (change === 'unavailable') throw new Error('database unavailable');
        return true;
      },
    });
    expect(await permitCosOutbound(session, rpcMessage())).toBe(false);
  },
);
