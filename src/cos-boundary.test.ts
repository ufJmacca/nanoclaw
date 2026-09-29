import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initTestDb, closeDb, getDb } from './db/connection.js';
import {
  cosBoundary,
  installCosBoundary,
  permitCosExecution,
  permitCosOutbound,
  setCosBoundaryHooks,
  type CosBinding,
} from './cos-boundary.js';
import type { Session } from './types.js';
const binding: CosBinding = {
  scopeId: 'fixture',
  agentGroupId: 'cos',
  messagingGroupId: 'mg',
  sessionId: 'session',
  ownerId: 'owner',
  botId: 'bot',
  instanceId: 'fixture',
  channelId: 'private',
  provider: 'codex',
};
const session = {
  id: 'session',
  agent_group_id: 'cos',
  messaging_group_id: 'mg',
  thread_id: null,
  agent_provider: 'codex',
  status: 'active',
} as Session;
beforeEach(() => installCosBoundary(binding, initTestDb()));
afterEach(() => {
  setCosBoundaryHooks(null);
  closeDb();
});
describe('S01-T08 permanent host restriction', () => {
  it('rechecks the pause latch after asynchronous membership validation', async () => {
    getDb().exec('UPDATE cos_identity_boundaries SET paused=0');
    setCosBoundaryHooks({
      executionReady: () => true,
      ingress: async () => true,
      validatePrivateDestination: async () => {
        getDb().exec('UPDATE cos_identity_boundaries SET paused=1');
        return true;
      },
    });
    expect(
      await permitCosOutbound(session, {
        kind: 'chat',
        channel_type: 'mattermost',
        platform_id: 'mattermost:fixture:private',
        thread_id: null,
        content: JSON.stringify({ text: 'private' }),
      }),
    ).toBe(false);
  });
  it('recognises a bound identity while the feature is absent', () => {
    expect(cosBoundary(session)).toMatchObject({ restricted: true, paused: true });
    expect(permitCosExecution(session)).toBe(false);
  });
  it.each(['self_mod', 'create_agent', 'schedule_task', 'cos_admin', 'cos_rpc'])(
    'blocks forged %s queue rows without the feature',
    async (action) => {
      expect(
        await permitCosOutbound(session, {
          kind: 'system',
          content: JSON.stringify({ action }),
          channel_type: null,
          platform_id: null,
          thread_id: null,
        }),
      ).toBe(false);
    },
  );
  it('recognises partially spoofed restricted session identities', () => {
    expect(cosBoundary({ ...session, id: 'foreign' })).toMatchObject({ restricted: true, binding: null });
    expect(cosBoundary({ ...session, agent_group_id: 'foreign' })).toMatchObject({ restricted: true, binding: null });
  });
  it('leaves ordinary sessions available without CoS', async () => {
    const other = { ...session, id: 'other', agent_group_id: 'ordinary', messaging_group_id: 'other' };
    expect(permitCosExecution(other)).toBe(true);
    expect(
      await permitCosOutbound(other, {
        kind: 'chat',
        content: '{}',
        channel_type: 'telegram',
        platform_id: 'telegram:fixture',
        thread_id: null,
      }),
    ).toBe(true);
  });
});
