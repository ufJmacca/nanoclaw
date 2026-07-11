import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT, initGroupFilesystem, killContainer, wakeContainer } = vi.hoisted(() => ({
  TEST_ROOT: '/tmp/nanoclaw-test-mattermost-subscription',
  initGroupFilesystem: vi.fn(),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../group-init.js', () => ({ initGroupFilesystem }));
vi.mock('../container-runner.js', () => ({
  wakeContainer,
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer,
}));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    GROUPS_DIR: `${TEST_ROOT}/groups`,
    DATA_DIR: `${TEST_ROOT}/data`,
  };
});

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  getDb,
  getSessionsByAgentGroup,
  initDb,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { routeInbound, setChannelRequestGate, setMattermostChannelRequestGate, setSenderResolver } from '../router.js';
import { openInboundDb, resolveSession, sessionDir, writeSessionMessage } from '../session-manager.js';
import type { Session } from '../types.js';
import {
  deactivateMattermostChannelStrict,
  isMattermostOwnedAgentGroup,
  listMattermostOwnedFilesystemIdentities,
  resubscribeMattermostChannelStrict,
  subscribeMattermostChannelStrict,
  validateMattermostSessionForExecution,
  validateMattermostSubscriptionForRouting,
} from './mattermost-subscription.js';
import * as mattermostSubscriptionModule from './mattermost-subscription.js';

const execFileAsync = promisify(execFile);

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { force: true, recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
  fs.rmSync(TEST_ROOT, { force: true, recursive: true });
});

describe('strict Mattermost subscription schema', () => {
  it('installs one-to-one subscription identity constraints', () => {
    const columns = getDb().prepare("PRAGMA table_info('mattermost_subscriptions')").all() as Array<{
      name: string;
      pk: number;
    }>;
    const columnNames = columns.map((column) => column.name);

    expect(columnNames).toEqual([
      'instance_key',
      'channel_id',
      'messaging_group_id',
      'agent_group_id',
      'wiring_id',
      'status',
      'created_at',
      'archived_at',
    ]);
    expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
      'instance_key',
      'channel_id',
    ]);

    const uniqueIndexes = getDb()
      .prepare("PRAGMA index_list('mattermost_subscriptions')")
      .all()
      .filter((index) => (index as { unique: number }).unique === 1) as Array<{ name: string }>;
    const uniqueColumnSets = uniqueIndexes.map((index) =>
      (getDb().prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>)
        .map((column) => column.name)
        .join(','),
    );

    expect(uniqueColumnSets).toEqual(
      expect.arrayContaining(['instance_key,channel_id', 'messaging_group_id', 'agent_group_id', 'wiring_id']),
    );
  });

  it('rejects a hand-written subscription row whose agent already has a second channel', () => {
    const createdAt = new Date().toISOString();
    const digest = createHash('sha256').update('primary\0channel-a').digest('hex').slice(0, 24);
    const agentGroupId = `ag-mattermost-${digest}`;
    const messagingGroupId = `mg-mattermost-${digest}`;
    const wiringId = `mga-mattermost-${digest}`;
    createAgentGroup({
      id: agentGroupId,
      name: 'Mattermost A',
      folder: `mattermost-${digest}`,
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: messagingGroupId,
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:channel-a',
      name: 'Mattermost A',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: wiringId,
      messaging_group_id: messagingGroupId,
      agent_group_id: agentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-handwritten-telegram',
      channel_type: 'telegram',
      platform_id: 'telegram:-100999',
      name: 'Handwritten Telegram',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-handwritten-telegram',
      messaging_group_id: 'mg-handwritten-telegram',
      agent_group_id: agentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });

    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO mattermost_subscriptions (
             instance_key, channel_id, messaging_group_id, agent_group_id, wiring_id, status, created_at
           ) VALUES ('primary', 'channel-a', ?, ?, ?, 'active', ?)`,
        )
        .run(messagingGroupId, agentGroupId, wiringId, createdAt),
    ).toThrow('Mattermost subscription topology must be exclusive');
  });

  it('fails the lifecycle migration closed on a legacy channel with multiple session identities', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const first = resolveSession(
      channelA.agentGroup.id,
      channelA.messagingGroup.id,
      null,
      channelA.wiring.session_mode,
    ).session;
    const db = getDb();
    db.exec(`
      DROP TRIGGER mattermost_guard_active_session_insert;
      DROP TRIGGER mattermost_guard_active_session_update;
      DROP TRIGGER mattermost_guard_subscription_lifecycle_update;
      DROP TRIGGER mattermost_guard_subscription_archive_timestamp_insert;
      DROP TRIGGER mattermost_guard_subscription_archive_timestamp_update;
      DROP TRIGGER mattermost_guard_permanent_destination_delete;
      DROP TRIGGER mattermost_guard_session_cardinality_insert;
      DROP TRIGGER mattermost_guard_session_delete;
      DROP TRIGGER mattermost_guard_session_ownership_update;
      DROP TRIGGER mattermost_guard_unsubscribe_session_state;
      DROP TABLE pending_mattermost_channel_approvals;
      DELETE FROM schema_version WHERE name = 'mattermost-lifecycle';
    `);
    db.prepare("UPDATE sessions SET status = 'closed', container_status = 'stopped' WHERE id = ?").run(first.id);
    createSession({
      ...first,
      id: 'session-legacy-second-identity',
      status: 'closed',
      container_status: 'stopped',
      created_at: new Date(Date.now() + 1).toISOString(),
    });

    expect(() => runMigrations(db)).toThrow(
      'Cannot migrate Mattermost lifecycle: a channel owns multiple session identities',
    );
    expect(db.prepare("SELECT 1 FROM schema_version WHERE name = 'mattermost-lifecycle'").get()).toBeUndefined();
  });
});

describe('Mattermost subscription lifecycle', () => {
  it('requires an explicit workspace retention or archive policy', async () => {
    subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });

    await expect(
      deactivateMattermostChannelStrict({
        instanceKey: 'primary',
        channelId: 'channel-a',
        workspacePolicy: undefined,
      } as never),
    ).rejects.toThrow('Invalid Mattermost deactivation request');
    expect(getDb().prepare('SELECT status FROM mattermost_subscriptions').get()).toEqual({ status: 'active' });
  });

  it('enforces ordered lifecycle transitions and archive timestamp coherence in SQLite', () => {
    subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });

    expect(() =>
      getDb()
        .prepare(
          `UPDATE mattermost_subscriptions
              SET status = 'archived', archived_at = ?
            WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
        )
        .run(new Date().toISOString()),
    ).toThrow('Invalid Mattermost subscription lifecycle transition');
    expect(getDb().prepare('SELECT status FROM mattermost_subscriptions').get()).toEqual({ status: 'active' });

    getDb().prepare("UPDATE mattermost_subscriptions SET status = 'unsubscribed'").run();
    expect(() => getDb().prepare("UPDATE mattermost_subscriptions SET status = 'archived'").run()).toThrow(
      'Mattermost archived status requires an archive timestamp',
    );
    getDb()
      .prepare("UPDATE mattermost_subscriptions SET status = 'archived', archived_at = ?")
      .run(new Date().toISOString());
    expect(() =>
      getDb().prepare("UPDATE mattermost_subscriptions SET status = 'active', archived_at = NULL").run(),
    ).toThrow('Invalid Mattermost subscription lifecycle transition');
    expect(getDb().prepare('SELECT status FROM mattermost_subscriptions').get()).toEqual({ status: 'archived' });
  });

  it('requires the owned session to be closed before a raw unsubscribe transition', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const sessionA = resolveSession(
      channelA.agentGroup.id,
      channelA.messagingGroup.id,
      null,
      channelA.wiring.session_mode,
    ).session;
    getDb().prepare("UPDATE sessions SET container_status = 'running' WHERE id = ?").run(sessionA.id);

    expect(() => getDb().prepare("UPDATE mattermost_subscriptions SET status = 'unsubscribed'").run()).toThrow(
      'Mattermost sessions must be closed before unsubscribe',
    );
    expect(getDb().prepare('SELECT status FROM mattermost_subscriptions').get()).toEqual({ status: 'active' });
    expect(getDb().prepare('SELECT status, container_status FROM sessions').get()).toEqual({
      status: 'active',
      container_status: 'running',
    });
  });

  it('marks only channel A inactive and closes its session before killing its execution', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
    const sessionA = resolveSession(
      channelA.agentGroup.id,
      channelA.messagingGroup.id,
      null,
      channelA.wiring.session_mode,
    ).session;
    const sessionB = resolveSession(
      channelB.agentGroup.id,
      channelB.messagingGroup.id,
      null,
      channelB.wiring.session_mode,
    ).session;
    getDb().prepare("UPDATE sessions SET container_status = 'running' WHERE id = ?").run(sessionA.id);
    getDb().prepare("UPDATE sessions SET container_status = 'idle' WHERE id = ?").run(sessionB.id);

    killContainer.mockImplementation((sessionId: string) => {
      expect(sessionId).toBe(sessionA.id);
      expect(
        getDb()
          .prepare(
            `SELECT ms.status, s.status AS session_status, s.container_status
               FROM mattermost_subscriptions ms
               JOIN sessions s ON s.agent_group_id = ms.agent_group_id
              WHERE ms.instance_key = 'primary' AND ms.channel_id = 'channel-a'`,
          )
          .get(),
      ).toEqual({ status: 'unsubscribed', session_status: 'closed', container_status: 'stopped' });
    });

    const deactivate = (
      mattermostSubscriptionModule as typeof mattermostSubscriptionModule & {
        deactivateMattermostChannelStrict?: (input: {
          instanceKey: string;
          channelId: string;
          workspacePolicy: 'retain' | 'archive';
        }) => Promise<unknown>;
      }
    ).deactivateMattermostChannelStrict;
    expect(deactivate).toBeTypeOf('function');
    await deactivate?.({ instanceKey: 'primary', channelId: 'channel-a', workspacePolicy: 'retain' });

    expect(killContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith(sessionA.id, 'Mattermost channel unsubscribed');
    expect(getDb().prepare('SELECT status, container_status FROM sessions WHERE id = ?').get(sessionB.id)).toEqual({
      status: 'active',
      container_status: 'idle',
    });
    expect(
      getDb()
        .prepare(
          `SELECT channel_id, status FROM mattermost_subscriptions
            WHERE instance_key = 'primary' ORDER BY channel_id`,
        )
        .all(),
    ).toEqual([
      { channel_id: 'channel-a', status: 'unsubscribed' },
      { channel_id: 'channel-b', status: 'active' },
    ]);
  });

  it('commits unsubscribe before yielding to asynchronous container cleanup', async () => {
    killContainer.mockReset();
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const sessionA = resolveSession(
      channelA.agentGroup.id,
      channelA.messagingGroup.id,
      null,
      channelA.wiring.session_mode,
    ).session;
    getDb().prepare("UPDATE sessions SET container_status = 'running' WHERE id = ?").run(sessionA.id);

    const deactivation = deactivateMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      workspacePolicy: 'retain',
    });

    expect(
      getDb()
        .prepare(
          `SELECT ms.status, s.status AS session_status, s.container_status
             FROM mattermost_subscriptions ms
             JOIN sessions s ON s.agent_group_id = ms.agent_group_id
            WHERE ms.instance_key = 'primary' AND ms.channel_id = 'channel-a'`,
        )
        .get(),
    ).toEqual({ status: 'unsubscribed', session_status: 'closed', container_status: 'stopped' });
    await deactivation;
  });

  it('drops new A traffic after unsubscribe while B continues routing', async () => {
    killContainer.mockReset();
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
    const inbound = (channel: typeof channelA, id: string, text: string) => ({
      channelType: 'mattermost',
      platformId: channel.messagingGroup.platform_id,
      threadId: null,
      message: {
        id,
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: `mattermost:user-${id}`, text }),
        timestamp: new Date().toISOString(),
        isGroup: true,
      },
    });
    await routeInbound(inbound(channelA, 'a-before', 'A_BEFORE'));
    await routeInbound(inbound(channelB, 'b-before', 'B_BEFORE'));
    const [sessionA] = getSessionsByAgentGroup(channelA.agentGroup.id);
    const [sessionB] = getSessionsByAgentGroup(channelB.agentGroup.id);
    await deactivateMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      workspacePolicy: 'retain',
    });

    wakeContainer.mockClear();
    await expect(routeInbound(inbound(channelA, 'a-after', 'A_AFTER'))).resolves.toBeUndefined();
    await routeInbound(inbound(channelB, 'b-after', 'B_AFTER'));

    const dbA = openInboundDb(channelA.agentGroup.id, sessionA.id);
    expect(dbA.prepare('SELECT content FROM messages_in ORDER BY seq').all()).toEqual([
      { content: JSON.stringify({ senderId: 'mattermost:user-a-before', text: 'A_BEFORE' }) },
    ]);
    dbA.close();
    const dbB = openInboundDb(channelB.agentGroup.id, sessionB.id);
    expect(dbB.prepare('SELECT content FROM messages_in ORDER BY seq').all()).toEqual([
      { content: JSON.stringify({ senderId: 'mattermost:user-b-before', text: 'B_BEFORE' }) },
      { content: JSON.stringify({ senderId: 'mattermost:user-b-after', text: 'B_AFTER' }) },
    ]);
    dbB.close();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact crash-replayed Mattermost post once without a second wake', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const event = {
      channelType: 'mattermost',
      platformId: channelA.messagingGroup.platform_id,
      threadId: 'root-a',
      message: {
        id: 'post-crash-replay',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'mattermost:user-a', text: 'EXACT_REPLAY' }),
        timestamp: '2026-07-11T00:00:00.000Z',
        isGroup: true,
      },
    };

    wakeContainer.mockClear();
    await routeInbound(event);
    await expect(routeInbound(event)).resolves.toBeUndefined();

    const [sessionA] = getSessionsByAgentGroup(channelA.agentGroup.id);
    const inbound = openInboundDb(channelA.agentGroup.id, sessionA.id);
    expect(inbound.prepare('SELECT id, content FROM messages_in').all()).toEqual([
      {
        id: `post-crash-replay:${channelA.agentGroup.id}`,
        content: event.message.content,
      },
    ]);
    inbound.close();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('rejects a crash replay whose deterministic Mattermost message identity changed', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const event = {
      channelType: 'mattermost',
      platformId: channelA.messagingGroup.platform_id,
      threadId: 'root-a',
      message: {
        id: 'post-collision',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'mattermost:user-a', text: 'ORIGINAL' }),
        timestamp: '2026-07-11T00:00:00.000Z',
        isGroup: true,
      },
    };

    await routeInbound(event);
    await expect(
      routeInbound({
        ...event,
        message: { ...event.message, content: JSON.stringify({ senderId: 'mattermost:user-a', text: 'MUTATED' }) },
      }),
    ).rejects.toThrow('Mattermost replay message identity collision');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('prevents a stale route from creating a new active session after unsubscribe', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const oldSession = resolveSession(
      channelA.agentGroup.id,
      channelA.messagingGroup.id,
      null,
      channelA.wiring.session_mode,
    ).session;

    await deactivateMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      workspacePolicy: 'retain',
    });

    expect(() =>
      resolveSession(channelA.agentGroup.id, channelA.messagingGroup.id, null, channelA.wiring.session_mode),
    ).toThrow('Mattermost channel already owns a session identity');
    expect(getSessionsByAgentGroup(channelA.agentGroup.id)).toEqual([
      expect.objectContaining({ id: oldSession.id, status: 'closed', container_status: 'stopped' }),
    ]);
  });

  it('retains or archives the owned workspace in place according to the explicit policy', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
    const workspaceMarker = path.join(GROUPS_DIR, channelA.agentGroup.folder, 'retained-marker.txt');
    const stateMarker = path.join(DATA_DIR, 'v2-sessions', channelA.agentGroup.id, 'retained-state.txt');
    fs.writeFileSync(workspaceMarker, 'workspace-a');
    fs.writeFileSync(stateMarker, 'state-a');

    await deactivateMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      workspacePolicy: 'retain',
    });
    expect(
      getDb()
        .prepare(
          `SELECT status, archived_at FROM mattermost_subscriptions
            WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
        )
        .get(),
    ).toEqual({ status: 'unsubscribed', archived_at: null });
    expect(fs.readFileSync(workspaceMarker, 'utf8')).toBe('workspace-a');
    expect(fs.readFileSync(stateMarker, 'utf8')).toBe('state-a');

    const archived = await deactivateMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      workspacePolicy: 'archive',
    });
    expect(archived.status).toBe('archived');
    expect(
      getDb()
        .prepare(
          `SELECT status, archived_at IS NOT NULL AS timestamped
             FROM mattermost_subscriptions
            WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
        )
        .get(),
    ).toEqual({ status: 'archived', timestamped: 1 });
    expect(fs.readFileSync(workspaceMarker, 'utf8')).toBe('workspace-a');
    expect(fs.readFileSync(stateMarker, 'utf8')).toBe('state-a');
    expect(() => subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' })).toThrow(
      'Invalid Mattermost subscription topology: inactive_subscription',
    );
    expect(
      getDb()
        .prepare(
          "SELECT status FROM mattermost_subscriptions WHERE instance_key = 'primary' AND channel_id = 'channel-b'",
        )
        .get(),
    ).toEqual({ status: 'active' });
  });

  it('resubscribes the retained identity into its one exclusive session without other-channel context', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
    const oldA = resolveSession(
      channelA.agentGroup.id,
      channelA.messagingGroup.id,
      null,
      channelA.wiring.session_mode,
    ).session;
    const sessionB = resolveSession(
      channelB.agentGroup.id,
      channelB.messagingGroup.id,
      null,
      channelB.wiring.session_mode,
    ).session;
    writeSessionMessage(channelA.agentGroup.id, oldA.id, {
      id: 'old-a',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: 'OLD_A_CONTEXT' }),
    });
    writeSessionMessage(channelB.agentGroup.id, sessionB.id, {
      id: 'old-b',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: 'B_CONTEXT' }),
    });
    await deactivateMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      workspacePolicy: 'retain',
    });

    const resubscribe = (
      mattermostSubscriptionModule as typeof mattermostSubscriptionModule & {
        resubscribeMattermostChannelStrict?: (input: { instanceKey: string; channelId: string }) => typeof channelA;
      }
    ).resubscribeMattermostChannelStrict;
    expect(resubscribe).toBeTypeOf('function');
    const resumed = resubscribe?.({ instanceKey: 'primary', channelId: 'channel-a' });
    expect(resumed).toMatchObject({
      messagingGroup: { id: channelA.messagingGroup.id },
      agentGroup: { id: channelA.agentGroup.id, folder: channelA.agentGroup.folder },
      wiring: { id: channelA.wiring.id },
    });

    wakeContainer.mockClear();
    await routeInbound({
      channelType: 'mattermost',
      platformId: channelA.messagingGroup.platform_id,
      threadId: 'new-root-a',
      message: {
        id: 'new-a',
        kind: 'chat',
        content: JSON.stringify({ senderId: 'mattermost:user-a', text: 'NEW_A_CONTEXT' }),
        timestamp: new Date().toISOString(),
        isGroup: true,
      },
    });

    const sessionsA = getSessionsByAgentGroup(channelA.agentGroup.id);
    expect(sessionsA).toEqual([
      expect.objectContaining({ id: oldA.id, status: 'active', container_status: 'stopped', thread_id: null }),
    ]);
    const resumedDb = openInboundDb(channelA.agentGroup.id, oldA.id);
    expect(resumedDb.prepare('SELECT content FROM messages_in ORDER BY seq').all()).toEqual([
      { content: JSON.stringify({ text: 'OLD_A_CONTEXT' }) },
      { content: JSON.stringify({ senderId: 'mattermost:user-a', text: 'NEW_A_CONTEXT' }) },
    ]);
    expect(JSON.stringify(resumedDb.prepare('SELECT content FROM messages_in').all())).not.toContain('B_CONTEXT');
    resumedDb.close();
    expect(getSessionsByAgentGroup(channelB.agentGroup.id)).toEqual([
      expect.objectContaining({ id: sessionB.id, status: 'active' }),
    ]);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('prevents a second session identity for a resubscribed Mattermost channel', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const oldA = resolveSession(
      channelA.agentGroup.id,
      channelA.messagingGroup.id,
      null,
      channelA.wiring.session_mode,
    ).session;
    await deactivateMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      workspacePolicy: 'retain',
    });
    resubscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });

    expect(() =>
      createSession({
        ...oldA,
        id: 'sess-forbidden-second-identity',
        status: 'active',
        container_status: 'stopped',
        created_at: new Date().toISOString(),
      }),
    ).toThrow('Mattermost channel already owns a session identity');
    expect(getSessionsByAgentGroup(channelA.agentGroup.id)).toEqual([
      expect.objectContaining({ id: oldA.id, status: 'active' }),
    ]);
  });

  it('keeps Mattermost session ownership identity immutable after deactivation', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const oldA = resolveSession(
      channelA.agentGroup.id,
      channelA.messagingGroup.id,
      null,
      channelA.wiring.session_mode,
    ).session;
    createAgentGroup({
      id: 'ag-generic-target',
      name: 'Generic target',
      folder: 'generic-target',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createMessagingGroup({
      id: 'mg-generic-target',
      channel_type: 'telegram',
      platform_id: 'telegram:generic-target',
      name: 'Generic target',
      is_group: 1,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: new Date().toISOString(),
    });
    await deactivateMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      workspacePolicy: 'retain',
    });

    expect(() =>
      getDb()
        .prepare(
          `UPDATE sessions
              SET agent_group_id = 'ag-generic-target',
                  messaging_group_id = 'mg-generic-target',
                  thread_id = 'foreign-thread'
            WHERE id = ?`,
        )
        .run(oldA.id),
    ).toThrow('Mattermost session ownership identity is immutable');
    expect(
      getDb().prepare('SELECT agent_group_id, messaging_group_id, thread_id FROM sessions WHERE id = ?').get(oldA.id),
    ).toEqual({
      agent_group_id: channelA.agentGroup.id,
      messaging_group_id: channelA.messagingGroup.id,
      thread_id: null,
    });
  });

  it('prevents renaming or deleting the one reserved Mattermost session identity', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const sessionA = resolveSession(
      channelA.agentGroup.id,
      channelA.messagingGroup.id,
      null,
      channelA.wiring.session_mode,
    ).session;
    await deactivateMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      workspacePolicy: 'retain',
    });

    expect(() => getDb().prepare("UPDATE sessions SET id = 'sess-renamed' WHERE id = ?").run(sessionA.id)).toThrow(
      'Mattermost session ownership identity is immutable',
    );
    expect(() => getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionA.id)).toThrow(
      'Mattermost session identity cannot be deleted',
    );
    expect(getDb().prepare('SELECT id FROM sessions').all()).toEqual([{ id: sessionA.id }]);
  });

  it('keeps the canonical channel destination permanently reserved while unsubscribed', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    await deactivateMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      workspacePolicy: 'retain',
    });

    expect(() =>
      getDb().prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?').run(channelA.agentGroup.id),
    ).toThrow('Active Mattermost canonical destination cannot be deleted');
    expect(
      getDb()
        .prepare('SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ?')
        .all(channelA.agentGroup.id),
    ).toEqual([{ target_type: 'channel', target_id: channelA.messagingGroup.id }]);
  });

  it('deactivates only the removed bot channel and cancels a pending subscription for that channel', async () => {
    killContainer.mockReset();
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
    const sessionA = resolveSession(
      channelA.agentGroup.id,
      channelA.messagingGroup.id,
      null,
      channelA.wiring.session_mode,
    ).session;
    const sessionB = resolveSession(
      channelB.agentGroup.id,
      channelB.messagingGroup.id,
      null,
      channelB.wiring.session_mode,
    ).session;
    getDb().prepare("UPDATE sessions SET container_status = 'running' WHERE id = ?").run(sessionA.id);
    getDb().prepare("UPDATE sessions SET container_status = 'idle' WHERE id = ?").run(sessionB.id);
    createMessagingGroup({
      id: 'mg-pending-removal',
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:channel-pending',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: new Date().toISOString(),
    });
    getDb()
      .prepare(
        `INSERT INTO pending_mattermost_channel_approvals (
           approval_id, instance_key, channel_id, messaging_group_id,
           requester_user_id, approver_user_id, original_message, status,
           created_at, decided_at, decided_by, replayed_at, title, options_json
         ) VALUES (
           'pending-removal', 'primary', 'channel-pending', 'mg-pending-removal',
           'mattermost:requester', 'telegram:owner', '{}', 'pending',
           ?, NULL, NULL, NULL, 'Pending', '[]'
         )`,
      )
      .run(new Date().toISOString());

    const handleBotRemoved = (
      mattermostSubscriptionModule as typeof mattermostSubscriptionModule & {
        handleMattermostBotRemoved?: (platformId: string) => Promise<void>;
      }
    ).handleMattermostBotRemoved;
    expect(handleBotRemoved).toBeTypeOf('function');
    await handleBotRemoved?.('mattermost:primary:channel-a');
    await handleBotRemoved?.('mattermost:primary:channel-pending');

    expect(killContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith(sessionA.id, 'Mattermost channel unsubscribed');
    expect(
      getDb().prepare('SELECT channel_id, status FROM mattermost_subscriptions ORDER BY channel_id').all(),
    ).toEqual([
      { channel_id: 'channel-a', status: 'unsubscribed' },
      { channel_id: 'channel-b', status: 'active' },
    ]);
    expect(getDb().prepare('SELECT status, container_status FROM sessions WHERE id = ?').get(sessionB.id)).toEqual({
      status: 'active',
      container_status: 'idle',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM pending_mattermost_channel_approvals').get()).toEqual({
      count: 0,
    });
  });
});

describe('subscribeMattermostChannelStrict', () => {
  it('creates a namespaced messaging group for channel A', () => {
    const result = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      channelName: 'Channel A',
    });

    expect(result.messagingGroup).toMatchObject({
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:channel-a',
      name: 'Channel A',
      is_group: 1,
      unknown_sender_policy: 'strict',
    });
    expect(
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM messaging_groups WHERE channel_type = ? AND platform_id = ?')
        .get('mattermost', 'mattermost:primary:channel-a'),
    ).toEqual({ count: 1 });
  });

  it('creates a fresh agent identity for each Mattermost channel without reusing Telegram', () => {
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-telegram',
      name: 'Telegram Agent',
      folder: 'telegram-agent',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-telegram',
      channel_type: 'telegram',
      platform_id: 'telegram:-100123',
      name: 'Telegram',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-telegram',
      messaging_group_id: 'mg-telegram',
      agent_group_id: 'ag-telegram',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });

    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });

    expect(channelA.agentGroup).toBeDefined();
    expect(channelB.agentGroup).toBeDefined();
    expect(channelA.agentGroup?.id).not.toBe('ag-telegram');
    expect(channelB.agentGroup?.id).not.toBe('ag-telegram');
    expect(channelA.agentGroup?.id).not.toBe(channelB.agentGroup?.id);
    expect(channelA.agentGroup?.folder).not.toBe(channelB.agentGroup?.folder);
  });

  it('creates exactly one shared channel-to-agent wiring and canonical subscription row', () => {
    const result = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      channelName: 'Channel A',
    });

    const wirings = getDb()
      .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id = ?')
      .all(result.messagingGroup.id) as Array<{ id: string; agent_group_id: string; session_mode: string }>;
    expect(wirings).toHaveLength(1);
    expect(wirings[0]).toMatchObject({
      id: result.wiring?.id,
      agent_group_id: result.agentGroup?.id,
      session_mode: 'shared',
    });
    expect(
      getDb()
        .prepare('SELECT * FROM mattermost_subscriptions WHERE instance_key = ? AND channel_id = ?')
        .get('primary', 'channel-a'),
    ).toMatchObject({
      messaging_group_id: result.messagingGroup.id,
      agent_group_id: result.agentGroup?.id,
      wiring_id: result.wiring?.id,
      status: 'active',
    });
  });

  it('initializes one unique workspace identity for each subscribed channel', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });

    expect(initGroupFilesystem).toHaveBeenCalledTimes(2);
    expect(initGroupFilesystem).toHaveBeenNthCalledWith(1, channelA.agentGroup);
    expect(initGroupFilesystem).toHaveBeenNthCalledWith(2, channelB.agentGroup);
    expect(channelA.agentGroup?.folder).toMatch(/^mattermost-[a-f0-9]{24}$/);
    expect(channelA.agentGroup?.folder).not.toBe(channelB.agentGroup?.folder);
  });

  it('returns the same validated mapping when the subscription is repeated', () => {
    const first = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      channelName: 'Original Name',
    });
    const repeated = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      channelName: 'Renamed Channel',
    });

    expect(repeated).toEqual(first);
    expect(initGroupFilesystem).toHaveBeenCalledTimes(1);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messaging_groups').get()).toEqual({ count: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get()).toEqual({ count: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messaging_group_agents').get()).toEqual({ count: 1 });
  });

  it('rolls back every database row when workspace initialization fails', () => {
    initGroupFilesystem.mockImplementationOnce(() => {
      throw new Error('synthetic workspace failure');
    });

    expect(() => subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' })).toThrow(
      'synthetic workspace failure',
    );

    for (const table of [
      'mattermost_subscriptions',
      'messaging_group_agents',
      'agent_destinations',
      'messaging_groups',
      'agent_groups',
    ]) {
      expect(getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it('removes only newly-created workspace paths when initialization partially fails', () => {
    let groupPath = '';
    let statePath = '';
    initGroupFilesystem.mockImplementationOnce((group) => {
      groupPath = path.join(GROUPS_DIR, group.folder);
      statePath = path.join(DATA_DIR, 'v2-sessions', group.id);
      fs.mkdirSync(groupPath, { recursive: true });
      fs.mkdirSync(statePath, { recursive: true });
      fs.writeFileSync(path.join(groupPath, 'partial-marker'), 'partial');
      throw new Error('synthetic partial filesystem failure');
    });

    expect(() => subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' })).toThrow(
      'synthetic partial filesystem failure',
    );

    expect(fs.existsSync(groupPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('fails closed without deleting a pre-existing workspace identity', () => {
    const digest = createHash('sha256').update('primary\0channel-a').digest('hex').slice(0, 24);
    const preexistingPath = path.join(GROUPS_DIR, `mattermost-${digest}`);
    const markerPath = path.join(preexistingPath, 'foreign-context-marker');
    fs.mkdirSync(preexistingPath, { recursive: true });
    fs.writeFileSync(markerPath, 'must-not-inherit-or-delete');

    expect(() => subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' })).toThrow(
      'Mattermost workspace identity already exists',
    );

    expect(fs.readFileSync(markerPath, 'utf8')).toBe('must-not-inherit-or-delete');
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(initGroupFilesystem).not.toHaveBeenCalled();
  });

  it('preserves a workspace created by a concurrent winner before this invocation owns initialization', () => {
    const digest = createHash('sha256').update('primary\0channel-a').digest('hex').slice(0, 24);
    const winnerPath = path.join(GROUPS_DIR, `mattermost-${digest}`);
    const markerPath = path.join(winnerPath, 'winner-context-marker');
    fs.mkdirSync(winnerPath, { recursive: true });
    fs.writeFileSync(markerPath, 'winner-owned');

    const realExistsSync = fs.existsSync.bind(fs);
    let initialSnapshotHidden = false;
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      if (
        !initialSnapshotHidden &&
        typeof candidate === 'string' &&
        path.resolve(candidate) === path.resolve(winnerPath)
      ) {
        initialSnapshotHidden = true;
        return false;
      }
      return realExistsSync(candidate);
    });

    try {
      expect(() => subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' })).toThrow(
        'Mattermost workspace identity already exists',
      );
    } finally {
      existsSpy.mockRestore();
    }

    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('winner-owned');
    expect(initGroupFilesystem).not.toHaveBeenCalled();
  });

  it('rejects ambiguous subscription identity before any mutation', () => {
    expect(() => subscribeMattermostChannelStrict({ instanceKey: 'primary:shadow', channelId: 'channel-a' })).toThrow(
      'Invalid Mattermost subscription identity',
    );

    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messaging_groups').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get()).toEqual({ count: 0 });
    expect(initGroupFilesystem).not.toHaveBeenCalled();
  });

  it('rejects a hand-written second-channel mapping before sender or agent invocation', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createMessagingGroup({
      id: 'mg-malformed-channel-b',
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:channel-b',
      name: 'Malformed B',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: createdAt,
    });
    getDb().exec(`
      DROP TRIGGER mattermost_guard_reserved_agent_wiring_insert;
      DROP TRIGGER mattermost_guard_outgoing_destination_insert;
    `);
    createMessagingGroupAgent({
      id: 'mga-malformed-channel-b',
      messaging_group_id: 'mg-malformed-channel-b',
      agent_group_id: channelA.agentGroup.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    const senderResolver = vi.fn().mockReturnValue('mattermost:user-b');
    setSenderResolver(senderResolver);

    await routeInbound({
      channelType: 'mattermost',
      platformId: 'mattermost:primary:channel-b',
      threadId: 'root-b',
      message: {
        id: 'malformed-b-message',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Mallory', senderId: 'mattermost:user-b', text: 'must fail closed' }),
        timestamp: createdAt,
        isGroup: true,
      },
    });

    expect(senderResolver).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(getSessionsByAgentGroup(channelA.agentGroup.id)).toHaveLength(0);
  });

  it('uses only the validated canonical wiring if topology changes before fan-out', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-late-injected',
      name: 'Late Injected Agent',
      folder: 'late-injected',
      agent_provider: null,
      created_at: createdAt,
    });
    // Exercise the router's independent check/use defense using legacy
    // malformed state that predates the database trigger backstop.
    getDb().exec('DROP TRIGGER mattermost_guard_reserved_group_wiring_insert');
    setSenderResolver(() => {
      createMessagingGroupAgent({
        id: 'mga-late-injected',
        messaging_group_id: channelA.messagingGroup.id,
        agent_group_id: 'ag-late-injected',
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'known',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: createdAt,
      });
      return 'mattermost:user-a';
    });

    await routeInbound({
      channelType: 'mattermost',
      platformId: 'mattermost:primary:channel-a',
      threadId: 'root-a',
      message: {
        id: 'topology-race-message',
        kind: 'chat',
        content: JSON.stringify({ senderId: 'mattermost:user-a', text: 'route canonically' }),
        timestamp: createdAt,
        isGroup: true,
      },
    });

    expect(getSessionsByAgentGroup(channelA.agentGroup.id)).toHaveLength(1);
    expect(getSessionsByAgentGroup('ag-late-injected')).toHaveLength(0);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('rejects a legacy Telegram wiring into a Mattermost-owned agent before sender resolution', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createMessagingGroup({
      id: 'mg-legacy-telegram',
      channel_type: 'telegram',
      platform_id: 'telegram:-100777',
      name: 'Legacy Telegram',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    // Simulate malformed state written before the Phase 5 database guards
    // existed. Runtime routing must still fail closed after an upgrade.
    getDb().exec(`
      DROP TRIGGER mattermost_guard_reserved_agent_wiring_insert;
      DROP TRIGGER mattermost_guard_outgoing_destination_insert;
    `);
    createMessagingGroupAgent({
      id: 'mga-legacy-telegram-to-mattermost',
      messaging_group_id: 'mg-legacy-telegram',
      agent_group_id: channelA.agentGroup.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    const senderResolver = vi.fn().mockReturnValue('telegram:user-t');
    setSenderResolver(senderResolver);

    await routeInbound({
      channelType: 'telegram',
      platformId: 'telegram:-100777',
      threadId: null,
      message: {
        id: 'legacy-cross-platform-message',
        kind: 'chat',
        content: JSON.stringify({ senderId: 'telegram:user-t', text: 'must not share the Mattermost agent' }),
        timestamp: createdAt,
        isGroup: true,
      },
    });

    expect(senderResolver).not.toHaveBeenCalled();
    expect(getSessionsByAgentGroup(channelA.agentGroup.id)).toHaveLength(0);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('rejects Telegram routing into an agent also wired to an unsubscribed Mattermost channel', async () => {
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-orphan-cross-platform',
      name: 'Orphan Cross Platform',
      folder: 'orphan-cross-platform',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-orphan-cross-platform-mattermost',
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:orphan-cross-platform',
      name: 'Orphan Mattermost',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-orphan-cross-platform-mattermost',
      messaging_group_id: 'mg-orphan-cross-platform-mattermost',
      agent_group_id: 'ag-orphan-cross-platform',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-orphan-cross-platform-telegram',
      channel_type: 'telegram',
      platform_id: 'telegram:-100779',
      name: 'Cross Platform Telegram',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-orphan-cross-platform-telegram',
      messaging_group_id: 'mg-orphan-cross-platform-telegram',
      agent_group_id: 'ag-orphan-cross-platform',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    const senderResolver = vi.fn().mockReturnValue('telegram:user-t');
    setSenderResolver(senderResolver);

    await routeInbound({
      channelType: 'telegram',
      platformId: 'telegram:-100779',
      threadId: null,
      message: {
        id: 'orphan-cross-platform-message',
        kind: 'chat',
        content: JSON.stringify({ senderId: 'telegram:user-t', text: 'must fail closed' }),
        timestamp: createdAt,
        isGroup: true,
      },
    });

    expect(senderResolver).not.toHaveBeenCalled();
    expect(getSessionsByAgentGroup('ag-orphan-cross-platform')).toHaveLength(0);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('prevents a second channel wiring to a Mattermost-owned agent at the database boundary', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createMessagingGroup({
      id: 'mg-forbidden-telegram',
      channel_type: 'telegram',
      platform_id: 'telegram:-100778',
      name: 'Forbidden Telegram',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });

    expect(() =>
      createMessagingGroupAgent({
        id: 'mga-forbidden-telegram-to-mattermost',
        messaging_group_id: 'mg-forbidden-telegram',
        agent_group_id: channelA.agentGroup.id,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: createdAt,
      }),
    ).toThrow('Mattermost agent group is reserved for its canonical channel');

    expect(
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM messaging_group_agents WHERE agent_group_id = ?')
        .get(channelA.agentGroup.id),
    ).toEqual({ count: 1 });
  });

  it('prevents a second agent wiring into a strict Mattermost messaging group at the database boundary', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-forbidden-mattermost-fanout',
      name: 'Forbidden Mattermost Fan-out',
      folder: 'forbidden-mattermost-fanout',
      agent_provider: null,
      created_at: createdAt,
    });

    expect(() =>
      createMessagingGroupAgent({
        id: 'mga-forbidden-mattermost-fanout',
        messaging_group_id: channelA.messagingGroup.id,
        agent_group_id: 'ag-forbidden-mattermost-fanout',
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'known',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: createdAt,
      }),
    ).toThrow('Mattermost messaging group is reserved for its canonical agent');

    expect(
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM messaging_group_agents WHERE messaging_group_id = ?')
        .get(channelA.messagingGroup.id),
    ).toEqual({ count: 1 });
  });

  it('prevents mutation of an active Mattermost canonical wiring at the database boundary', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createMessagingGroup({
      id: 'mg-mutation-target',
      channel_type: 'telegram',
      platform_id: 'telegram:-100779',
      name: 'Mutation Target',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });

    expect(() =>
      getDb()
        .prepare('UPDATE messaging_group_agents SET messaging_group_id = ? WHERE id = ?')
        .run('mg-mutation-target', channelA.wiring.id),
    ).toThrow('Active Mattermost canonical wiring cannot be changed');

    expect(
      getDb().prepare('SELECT messaging_group_id FROM messaging_group_agents WHERE id = ?').get(channelA.wiring.id),
    ).toEqual({ messaging_group_id: channelA.messagingGroup.id });
  });

  it('prevents an existing generic wiring from being repointed to a Mattermost-owned agent', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-generic-repoint-source',
      name: 'Generic Repoint Source',
      folder: 'generic-repoint-source',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-generic-repoint-source',
      channel_type: 'telegram',
      platform_id: 'telegram:-100781',
      name: 'Generic Repoint Source',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-generic-repoint-source',
      messaging_group_id: 'mg-generic-repoint-source',
      agent_group_id: 'ag-generic-repoint-source',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });

    expect(() =>
      getDb()
        .prepare('UPDATE messaging_group_agents SET agent_group_id = ? WHERE id = ?')
        .run(channelA.agentGroup.id, 'mga-generic-repoint-source'),
    ).toThrow('Mattermost agent group is reserved for its canonical channel');

    expect(
      getDb()
        .prepare('SELECT agent_group_id FROM messaging_group_agents WHERE id = ?')
        .get('mga-generic-repoint-source'),
    ).toEqual({ agent_group_id: 'ag-generic-repoint-source' });
  });

  it('prevents an existing generic wiring from being repointed into a strict Mattermost channel', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-generic-group-repoint',
      name: 'Generic Group Repoint',
      folder: 'generic-group-repoint',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-generic-group-repoint',
      channel_type: 'telegram',
      platform_id: 'telegram:-100782',
      name: 'Generic Group Repoint',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-generic-group-repoint',
      messaging_group_id: 'mg-generic-group-repoint',
      agent_group_id: 'ag-generic-group-repoint',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });

    expect(() =>
      getDb()
        .prepare('UPDATE messaging_group_agents SET messaging_group_id = ? WHERE id = ?')
        .run(channelA.messagingGroup.id, 'mga-generic-group-repoint'),
    ).toThrow('Mattermost messaging group is reserved for its canonical agent');

    expect(
      getDb()
        .prepare('SELECT messaging_group_id FROM messaging_group_agents WHERE id = ?')
        .get('mga-generic-group-repoint'),
    ).toEqual({ messaging_group_id: 'mg-generic-group-repoint' });
  });

  it('keeps a Mattermost subscription ownership identity immutable at the database boundary', () => {
    subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-forbidden-subscription-repoint',
      name: 'Forbidden Subscription Repoint',
      folder: 'forbidden-subscription-repoint',
      agent_provider: null,
      created_at: createdAt,
    });

    expect(() =>
      getDb()
        .prepare(
          `UPDATE mattermost_subscriptions
              SET agent_group_id = 'ag-forbidden-subscription-repoint'
            WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
        )
        .run(),
    ).toThrow('Mattermost subscription ownership identity is immutable');

    expect(
      getDb()
        .prepare('SELECT agent_group_id FROM mattermost_subscriptions WHERE instance_key = ? AND channel_id = ?')
        .get('primary', 'channel-a'),
    ).toMatchObject({ agent_group_id: expect.stringMatching(/^ag-mattermost-/) });
  });

  it('keeps the Mattermost-owned agent workspace identity immutable', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });

    expect(() =>
      getDb()
        .prepare("UPDATE agent_groups SET folder = 'shared-telegram-workspace' WHERE id = ?")
        .run(channelA.agentGroup.id),
    ).toThrow('Mattermost agent workspace identity is immutable');

    expect(getDb().prepare('SELECT folder FROM agent_groups WHERE id = ?').get(channelA.agentGroup.id)).toEqual({
      folder: channelA.agentGroup.folder,
    });
  });

  it('keeps the Mattermost messaging-channel identity immutable', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });

    expect(() =>
      getDb()
        .prepare("UPDATE messaging_groups SET platform_id = 'telegram:-100785' WHERE id = ?")
        .run(channelA.messagingGroup.id),
    ).toThrow('Mattermost messaging channel identity is immutable');

    expect(
      getDb()
        .prepare('SELECT channel_type, platform_id FROM messaging_groups WHERE id = ?')
        .get(channelA.messagingGroup.id),
    ).toEqual({ channel_type: 'mattermost', platform_id: 'mattermost:primary:channel-a' });
  });

  it('prevents deleting an active Mattermost ownership reservation', () => {
    subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });

    expect(() =>
      getDb()
        .prepare(
          `DELETE FROM mattermost_subscriptions
            WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
        )
        .run(),
    ).toThrow('Mattermost ownership reservation cannot be deleted');

    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 1 });
  });

  it('retains an archived Mattermost ownership reservation so its workspace is never reassigned', () => {
    subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    getDb()
      .prepare(
        `UPDATE mattermost_subscriptions
            SET status = 'unsubscribed'
          WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
      )
      .run();
    getDb()
      .prepare(
        `UPDATE mattermost_subscriptions
            SET status = 'archived', archived_at = ?
          WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
      )
      .run(new Date().toISOString());

    expect(() =>
      getDb()
        .prepare(
          `DELETE FROM mattermost_subscriptions
            WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
        )
        .run(),
    ).toThrow('Mattermost ownership reservation cannot be deleted');

    expect(getDb().prepare('SELECT status FROM mattermost_subscriptions').get()).toEqual({ status: 'archived' });
  });

  it('revalidates canonical topology before an inactive subscription can become active', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    getDb()
      .prepare(
        `UPDATE mattermost_subscriptions
            SET status = 'unsubscribed'
          WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
      )
      .run();
    getDb().prepare("UPDATE messaging_group_agents SET sender_scope = 'all' WHERE id = ?").run(channelA.wiring.id);

    expect(() =>
      getDb()
        .prepare(
          `UPDATE mattermost_subscriptions
              SET status = 'active'
            WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
        )
        .run(),
    ).toThrow('Mattermost subscription topology must be exclusive');

    expect(getDb().prepare('SELECT status FROM mattermost_subscriptions').get()).toEqual({ status: 'unsubscribed' });
  });

  it('keeps canonical wiring ownership immutable while a Mattermost subscription is inactive', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-inactive-repoint-target',
      name: 'Inactive Repoint Target',
      folder: 'inactive-repoint-target',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-inactive-repoint-target',
      channel_type: 'telegram',
      platform_id: 'telegram:-100783',
      name: 'Inactive Repoint Target',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    getDb()
      .prepare(
        `UPDATE mattermost_subscriptions
            SET status = 'unsubscribed'
          WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
      )
      .run();

    expect(() =>
      getDb()
        .prepare(
          `UPDATE messaging_group_agents
              SET messaging_group_id = 'mg-inactive-repoint-target',
                  agent_group_id = 'ag-inactive-repoint-target'
            WHERE id = ?`,
        )
        .run(channelA.wiring.id),
    ).toThrow('Mattermost canonical wiring ownership is immutable');

    expect(
      getDb()
        .prepare('SELECT messaging_group_id, agent_group_id FROM messaging_group_agents WHERE id = ?')
        .get(channelA.wiring.id),
    ).toEqual({
      messaging_group_id: channelA.messagingGroup.id,
      agent_group_id: channelA.agentGroup.id,
    });
  });

  it('prevents an outgoing agent destination from a Mattermost-owned agent at the database boundary', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-forbidden-target',
      name: 'Forbidden Target',
      folder: 'forbidden-target',
      agent_provider: null,
      created_at: createdAt,
    });

    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO agent_destinations (
             agent_group_id, local_name, target_type, target_id, created_at
           ) VALUES (?, 'forbidden-target', 'agent', 'ag-forbidden-target', ?)`,
        )
        .run(channelA.agentGroup.id, createdAt),
    ).toThrow('Mattermost agent destinations are restricted to the canonical channel');

    expect(
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM agent_destinations WHERE agent_group_id = ?')
        .get(channelA.agentGroup.id),
    ).toEqual({ count: 1 });
  });

  it('prevents a duplicate destination to the canonical Mattermost channel', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });

    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO agent_destinations (
             agent_group_id, local_name, target_type, target_id, created_at
           ) VALUES (?, 'duplicate-canonical', 'channel', ?, ?)`,
        )
        .run(channelA.agentGroup.id, channelA.messagingGroup.id, new Date().toISOString()),
    ).toThrow('Mattermost agent destinations are restricted to the canonical channel');

    expect(
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM agent_destinations WHERE agent_group_id = ?')
        .get(channelA.agentGroup.id),
    ).toEqual({ count: 1 });
  });

  it('prevents mutation of an active Mattermost canonical destination at the database boundary', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-destination-mutation-target',
      name: 'Destination Mutation Target',
      folder: 'destination-mutation-target',
      agent_provider: null,
      created_at: createdAt,
    });

    expect(() =>
      getDb()
        .prepare(
          `UPDATE agent_destinations
              SET target_type = 'agent', target_id = 'ag-destination-mutation-target'
            WHERE agent_group_id = ?`,
        )
        .run(channelA.agentGroup.id),
    ).toThrow('Active Mattermost canonical destination cannot be changed');

    expect(
      getDb()
        .prepare('SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ?')
        .get(channelA.agentGroup.id),
    ).toEqual({ target_type: 'channel', target_id: channelA.messagingGroup.id });
  });

  it('prevents deleting an active Mattermost canonical destination', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });

    expect(() =>
      getDb().prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?').run(channelA.agentGroup.id),
    ).toThrow('Active Mattermost canonical destination cannot be deleted');

    expect(
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM agent_destinations WHERE agent_group_id = ?')
        .get(channelA.agentGroup.id),
    ).toEqual({ count: 1 });
  });

  it('keeps canonical destination ownership immutable while a Mattermost subscription is inactive', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-inactive-destination-target',
      name: 'Inactive Destination Target',
      folder: 'inactive-destination-target',
      agent_provider: null,
      created_at: createdAt,
    });
    getDb()
      .prepare(
        `UPDATE mattermost_subscriptions
            SET status = 'unsubscribed'
          WHERE instance_key = 'primary' AND channel_id = 'channel-a'`,
      )
      .run();

    expect(() =>
      getDb()
        .prepare(
          `UPDATE agent_destinations
              SET target_type = 'agent', target_id = 'ag-inactive-destination-target'
            WHERE agent_group_id = ?`,
        )
        .run(channelA.agentGroup.id),
    ).toThrow('Mattermost canonical destination ownership is immutable');

    expect(
      getDb()
        .prepare('SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ?')
        .get(channelA.agentGroup.id),
    ).toEqual({ target_type: 'channel', target_id: channelA.messagingGroup.id });
  });

  it('prevents an incoming agent destination into a Mattermost-owned agent at the database boundary', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-forbidden-source',
      name: 'Forbidden Source',
      folder: 'forbidden-source',
      agent_provider: null,
      created_at: createdAt,
    });

    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO agent_destinations (
             agent_group_id, local_name, target_type, target_id, created_at
           ) VALUES ('ag-forbidden-source', 'forbidden-mattermost', 'agent', ?, ?)`,
        )
        .run(channelA.agentGroup.id, createdAt),
    ).toThrow('Mattermost agent groups cannot be agent destinations');

    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM agent_destinations WHERE target_type = 'agent' AND target_id = ?")
        .get(channelA.agentGroup.id),
    ).toEqual({ count: 0 });
  });

  it('prevents an existing destination from being repointed into a Mattermost-owned agent', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-repoint-source',
      name: 'Repoint Source',
      folder: 'repoint-source',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-repoint-origin',
      channel_type: 'telegram',
      platform_id: 'telegram:-100780',
      name: 'Repoint Origin',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    getDb()
      .prepare(
        `INSERT INTO agent_destinations (
           agent_group_id, local_name, target_type, target_id, created_at
         ) VALUES ('ag-repoint-source', 'repoint-me', 'channel', 'mg-repoint-origin', ?)`,
      )
      .run(createdAt);

    expect(() =>
      getDb()
        .prepare(
          `UPDATE agent_destinations
              SET target_type = 'agent', target_id = ?
            WHERE agent_group_id = 'ag-repoint-source' AND local_name = 'repoint-me'`,
        )
        .run(channelA.agentGroup.id),
    ).toThrow('Mattermost agent groups cannot be agent destinations');

    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM agent_destinations WHERE target_type = 'agent' AND target_id = ?")
        .get(channelA.agentGroup.id),
    ).toEqual({ count: 0 });
  });

  it('prevents an existing generic destination from being reassigned to a Mattermost-owned agent', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-destination-owner-repoint',
      name: 'Destination Owner Repoint',
      folder: 'destination-owner-repoint',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-destination-owner-repoint',
      channel_type: 'telegram',
      platform_id: 'telegram:-100784',
      name: 'Destination Owner Repoint',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    getDb()
      .prepare(
        `INSERT INTO agent_destinations (
           agent_group_id, local_name, target_type, target_id, created_at
         ) VALUES ('ag-destination-owner-repoint', 'owner-repoint', 'channel',
                   'mg-destination-owner-repoint', ?)`,
      )
      .run(createdAt);

    expect(() =>
      getDb()
        .prepare(
          `UPDATE agent_destinations
              SET agent_group_id = ?
            WHERE agent_group_id = 'ag-destination-owner-repoint' AND local_name = 'owner-repoint'`,
        )
        .run(channelA.agentGroup.id),
    ).toThrow('Mattermost agent destinations are restricted to the canonical channel');

    expect(
      getDb().prepare('SELECT agent_group_id FROM agent_destinations WHERE local_name = ?').get('owner-repoint'),
    ).toEqual({ agent_group_id: 'ag-destination-owner-repoint' });
  });

  it('serializes concurrent duplicate subscriptions into one valid mapping', async () => {
    closeDb();
    const dbPath = path.join(TEST_ROOT, 'concurrent.db');
    const db = initDb(dbPath);
    runMigrations(db);
    closeDb();

    const tsxLoader = import.meta.resolve('tsx');
    const worker = path.resolve(process.cwd(), 'src/channels/__fixtures__/mattermost-subscription-worker.ts');
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        execFileAsync(process.execPath, ['--import', tsxLoader, worker, dbPath, 'primary', 'channel-a'], {
          cwd: TEST_ROOT,
          env: { ...process.env, LOG_LEVEL: 'fatal' },
        }),
      ),
    );
    const mappings = attempts.map(({ stdout }) => JSON.parse(stdout.trim()) as Record<string, string>);

    expect(new Set(mappings.map((mapping) => JSON.stringify(mapping))).size).toBe(1);
    initDb(dbPath);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messaging_groups').get()).toEqual({ count: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get()).toEqual({ count: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messaging_group_agents').get()).toEqual({ count: 1 });
  });

  it('adopts only a clean unwired placeholder previously observed by the router', () => {
    createMessagingGroup({
      id: 'mg-observed-placeholder',
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:channel-a',
      name: 'Observed Channel A',
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: new Date().toISOString(),
    });

    const result = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      channelName: 'Channel A',
    });

    expect(result.messagingGroup.id).toBe('mg-observed-placeholder');
    expect(result.messagingGroup.unknown_sender_policy).toBe('strict');
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messaging_groups').get()).toEqual({ count: 1 });
    expect(getDb().prepare('SELECT messaging_group_id FROM mattermost_subscriptions').get()).toEqual({
      messaging_group_id: 'mg-observed-placeholder',
    });
  });

  it('rejects an unwired placeholder that already owns session context', () => {
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-legacy-context',
      name: 'Legacy Context',
      folder: 'legacy-context',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-observed-placeholder',
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:channel-a',
      name: 'Observed Channel A',
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: createdAt,
    });
    getDb()
      .prepare(
        `INSERT INTO sessions (
           id, agent_group_id, messaging_group_id, thread_id, agent_provider,
           status, container_status, last_active, created_at
         ) VALUES ('sess-legacy-context', 'ag-legacy-context', 'mg-observed-placeholder', NULL, NULL,
                   'active', 'running', ?, ?)`,
      )
      .run(createdAt, createdAt);

    expect(() => subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' })).toThrow(
      'Invalid pre-existing Mattermost channel mapping',
    );

    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
    expect(initGroupFilesystem).not.toHaveBeenCalled();
  });

  it('rejects an unwired placeholder referenced by an existing agent destination', () => {
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-legacy-destination',
      name: 'Legacy Destination',
      folder: 'legacy-destination',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-observed-placeholder',
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:channel-a',
      name: 'Observed Channel A',
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: createdAt,
    });
    getDb()
      .prepare(
        `INSERT INTO agent_destinations (
           agent_group_id, local_name, target_type, target_id, created_at
         ) VALUES ('ag-legacy-destination', 'old-channel-a', 'channel', 'mg-observed-placeholder', ?)`,
      )
      .run(createdAt);

    expect(() => subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' })).toThrow(
      'Invalid pre-existing Mattermost channel mapping',
    );

    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_destinations').get()).toEqual({ count: 1 });
    expect(initGroupFilesystem).not.toHaveBeenCalled();
  });

  it('keeps unknown Mattermost channels out of the generic approval flow', async () => {
    const genericApproval = vi.fn().mockResolvedValue(undefined);
    setChannelRequestGate(genericApproval);

    await routeInbound({
      channelType: 'mattermost',
      platformId: 'mattermost:primary:unknown-channel',
      threadId: null,
      message: {
        id: 'unknown-mattermost-message',
        kind: 'chat',
        content: JSON.stringify({ senderId: 'mattermost:user-a', text: '@bot hello' }),
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: true,
      },
    });

    expect(genericApproval).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('routes an unknown Mattermost mention only to the dedicated subscription approval gate', async () => {
    const genericApproval = vi.fn().mockResolvedValue(undefined);
    const mattermostApproval = vi.fn().mockResolvedValue(undefined);
    setChannelRequestGate(genericApproval);
    setMattermostChannelRequestGate(mattermostApproval);

    const event = {
      channelType: 'mattermost',
      platformId: 'mattermost:primary:approval-channel',
      threadId: null,
      message: {
        id: 'unknown-mattermost-approval-message',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'mattermost:user-a', text: '@bot subscribe' }),
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: true,
      },
    };
    await routeInbound(event);

    expect(mattermostApproval).toHaveBeenCalledTimes(1);
    expect(mattermostApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_type: 'mattermost',
        platform_id: 'mattermost:primary:approval-channel',
      }),
      event,
    );
    expect(genericApproval).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messaging_group_agents').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('rejects a hand-written subscription that assigns a non-canonical agent identity', () => {
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-telegram-reused',
      name: 'Reused Telegram Agent',
      folder: 'telegram-reused',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-handwritten-mattermost',
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:channel-a',
      name: 'Channel A',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-handwritten-mattermost',
      messaging_group_id: 'mg-handwritten-mattermost',
      agent_group_id: 'ag-telegram-reused',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    getDb()
      .prepare(
        `INSERT INTO mattermost_subscriptions (
           instance_key, channel_id, messaging_group_id, agent_group_id, wiring_id, status, created_at
         ) VALUES ('primary', 'channel-a', 'mg-handwritten-mattermost', 'ag-telegram-reused',
                   'mga-handwritten-mattermost', 'active', ?)`,
      )
      .run(createdAt);
    const messagingGroup = getDb()
      .prepare('SELECT * FROM messaging_groups WHERE id = ?')
      .get('mg-handwritten-mattermost') as Parameters<typeof validateMattermostSubscriptionForRouting>[0];

    expect(validateMattermostSubscriptionForRouting(messagingGroup)).toEqual({
      valid: false,
      reason: 'non_canonical_agent_identity',
    });
  });

  it('rejects a hand-written subscription with an ambiguous instance identity', () => {
    const createdAt = new Date().toISOString();
    const digest = createHash('sha256').update('primary:shadow\0channel-a').digest('hex').slice(0, 24);
    const agentGroupId = `ag-mattermost-${digest}`;
    const messagingGroupId = `mg-mattermost-${digest}`;
    const wiringId = `mga-mattermost-${digest}`;
    createAgentGroup({
      id: agentGroupId,
      name: 'Ambiguous Mattermost Agent',
      folder: `mattermost-${digest}`,
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: messagingGroupId,
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:shadow:channel-a',
      name: 'Ambiguous Mattermost Channel',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: wiringId,
      messaging_group_id: messagingGroupId,
      agent_group_id: agentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    getDb()
      .prepare(
        `INSERT INTO mattermost_subscriptions (
           instance_key, channel_id, messaging_group_id, agent_group_id, wiring_id, status, created_at
         ) VALUES ('primary:shadow', 'channel-a', ?, ?, ?, 'active', ?)`,
      )
      .run(messagingGroupId, agentGroupId, wiringId, createdAt);
    const messagingGroup = getDb()
      .prepare('SELECT * FROM messaging_groups WHERE id = ?')
      .get(messagingGroupId) as Parameters<typeof validateMattermostSubscriptionForRouting>[0];

    expect(validateMattermostSubscriptionForRouting(messagingGroup)).toEqual({
      valid: false,
      reason: 'unsafe_subscription_identity',
    });
  });

  it('fails closed when the canonical wiring is weakened after subscription', () => {
    const result = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    getDb().exec('DROP TRIGGER mattermost_guard_canonical_wiring_update');
    getDb().prepare("UPDATE messaging_group_agents SET sender_scope = 'all' WHERE id = ?").run(result.wiring.id);
    const messagingGroup = getDb()
      .prepare('SELECT * FROM messaging_groups WHERE id = ?')
      .get(result.messagingGroup.id) as Parameters<typeof validateMattermostSubscriptionForRouting>[0];

    expect(validateMattermostSubscriptionForRouting(messagingGroup)).toEqual({
      valid: false,
      reason: 'unsafe_wiring_policy',
    });
  });

  it('fails closed when the canonical messaging-group policy is weakened', () => {
    const result = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    getDb()
      .prepare("UPDATE messaging_groups SET unknown_sender_policy = 'public' WHERE id = ?")
      .run(result.messagingGroup.id);
    const messagingGroup = getDb()
      .prepare('SELECT * FROM messaging_groups WHERE id = ?')
      .get(result.messagingGroup.id) as Parameters<typeof validateMattermostSubscriptionForRouting>[0];

    expect(validateMattermostSubscriptionForRouting(messagingGroup)).toEqual({
      valid: false,
      reason: 'unsafe_messaging_group_policy',
    });
  });

  it('fails closed when a strict Mattermost agent gains an outgoing agent destination', () => {
    const result = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-foreign-target',
      name: 'Foreign Target',
      folder: 'foreign-target',
      agent_provider: null,
      created_at: createdAt,
    });
    getDb().exec('DROP TRIGGER mattermost_guard_outgoing_destination_insert');
    getDb()
      .prepare(
        `INSERT INTO agent_destinations (
           agent_group_id, local_name, target_type, target_id, created_at
         ) VALUES (?, 'foreign-agent', 'agent', 'ag-foreign-target', ?)`,
      )
      .run(result.agentGroup.id, createdAt);

    const messagingGroup = getDb()
      .prepare('SELECT * FROM messaging_groups WHERE id = ?')
      .get(result.messagingGroup.id) as Parameters<typeof validateMattermostSubscriptionForRouting>[0];
    expect(validateMattermostSubscriptionForRouting(messagingGroup)).toEqual({
      valid: false,
      reason: 'unsafe_destination_topology',
    });
  });

  it('fails closed when another agent gains a destination into a strict Mattermost agent', () => {
    const result = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-foreign-source',
      name: 'Foreign Source',
      folder: 'foreign-source',
      agent_provider: null,
      created_at: createdAt,
    });
    getDb().exec('DROP TRIGGER mattermost_guard_incoming_destination_insert');
    getDb()
      .prepare(
        `INSERT INTO agent_destinations (
           agent_group_id, local_name, target_type, target_id, created_at
         ) VALUES ('ag-foreign-source', 'mattermost-a', 'agent', ?, ?)`,
      )
      .run(result.agentGroup.id, createdAt);

    const messagingGroup = getDb()
      .prepare('SELECT * FROM messaging_groups WHERE id = ?')
      .get(result.messagingGroup.id) as Parameters<typeof validateMattermostSubscriptionForRouting>[0];
    expect(validateMattermostSubscriptionForRouting(messagingGroup)).toEqual({
      valid: false,
      reason: 'unsafe_destination_topology',
    });
  });

  it('rejects a Mattermost-owned agent session bound to another channel', () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
    const session: Session = {
      id: 'session-cross-channel',
      agent_group_id: channelA.agentGroup.id,
      messaging_group_id: channelB.messagingGroup.id,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: false,
      reason: 'session_identity_mismatch',
    });
  });

  it('fails closed for a persisted session on an unsubscribed Mattermost messaging group', () => {
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-orphan-mattermost',
      name: 'Orphan Mattermost',
      folder: 'orphan-mattermost',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-orphan-mattermost',
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:orphan',
      name: 'Orphan Mattermost',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-orphan-mattermost',
      messaging_group_id: 'mg-orphan-mattermost',
      agent_group_id: 'ag-orphan-mattermost',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    const { session } = resolveSession('ag-orphan-mattermost', 'mg-orphan-mattermost', null, 'shared');

    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: false,
      reason: 'missing_subscription',
    });
  });

  it('fails closed when an agent-shared session belongs to an agent wired to unsubscribed Mattermost', () => {
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-orphan-mattermost-shared',
      name: 'Orphan Mattermost Shared',
      folder: 'orphan-mattermost-shared',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-orphan-mattermost-shared',
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:orphan-shared',
      name: 'Orphan Mattermost Shared',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-orphan-mattermost-shared',
      messaging_group_id: 'mg-orphan-mattermost-shared',
      agent_group_id: 'ag-orphan-mattermost-shared',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    const session: Session = {
      id: 'session-orphan-agent-shared',
      agent_group_id: 'ag-orphan-mattermost-shared',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: createdAt,
    };
    createSession(session);

    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: false,
      reason: 'missing_subscription',
    });
  });

  it('retains Mattermost ownership when a reserved subscription topology is corrupted', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    getDb().exec('DROP TRIGGER mattermost_guard_messaging_channel_identity_update');
    getDb()
      .prepare("UPDATE messaging_groups SET channel_type = 'telegram' WHERE id = ?")
      .run(channel.messagingGroup.id);

    expect(isMattermostOwnedAgentGroup(channel.agentGroup.id)).toBe(true);
  });

  it('enumerates canonical Mattermost workspace and state ownership for mount isolation', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });

    expect(listMattermostOwnedFilesystemIdentities()).toContainEqual({
      agentGroupId: channel.agentGroup.id,
      folder: channel.agentGroup.folder,
    });
  });

  it('rejects a per-thread session for a shared Mattermost channel', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const session: Session = {
      id: 'session-threaded',
      agent_group_id: channel.agentGroup.id,
      messaging_group_id: channel.messagingGroup.id,
      thread_id: 'root-post-id',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };

    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: false,
      reason: 'threaded_session',
    });
  });

  it('rejects a closed session for an active Mattermost subscription', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const session: Session = {
      id: 'session-closed',
      agent_group_id: channel.agentGroup.id,
      messaging_group_id: channel.messagingGroup.id,
      thread_id: null,
      agent_provider: null,
      status: 'closed',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };

    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: false,
      reason: 'inactive_session',
    });
  });

  it('rejects a canonical-looking Mattermost session without a matching database record', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const session: Session = {
      id: 'session-not-persisted',
      agent_group_id: channel.agentGroup.id,
      messaging_group_id: channel.messagingGroup.id,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };

    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: false,
      reason: 'session_record_mismatch',
    });
  });

  it('rejects a persisted Mattermost session id that can escape its channel state directory', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const session: Session = {
      id: '../foreign-agent/foreign-session',
      agent_group_id: channel.agentGroup.id,
      messaging_group_id: channel.messagingGroup.id,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    createSession(session);

    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: false,
      reason: 'unsafe_session_identity',
    });
  });

  it('accepts the persisted canonical shared Mattermost session', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const { session } = resolveSession(channel.agentGroup.id, channel.messagingGroup.id, 'ignored-root', 'shared');

    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: true,
      value: channel,
    });
  });

  it('rejects duplicate active shared sessions for one Mattermost channel', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const { session } = resolveSession(channel.agentGroup.id, channel.messagingGroup.id, null, 'shared');
    // Simulate a duplicate persisted by a pre-Phase-7 writer. The new DB
    // trigger rejects this state; runtime validation must still fail closed
    // for legacy/corrupt databases upgraded in place.
    getDb().exec('DROP TRIGGER mattermost_guard_session_cardinality_insert');
    createSession({
      ...session,
      id: 'session-duplicate-canonical',
      created_at: new Date(Date.now() + 1).toISOString(),
    });

    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: false,
      reason: 'duplicate_active_session',
    });
  });

  it('rejects a canonical Mattermost session whose state directory was replaced by a symlink', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const { session } = resolveSession(channel.agentGroup.id, channel.messagingGroup.id, null, 'shared');
    const ownedSessionDir = sessionDir(channel.agentGroup.id, session.id);
    const foreignDir = path.join(TEST_ROOT, 'foreign-session-state');
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.rmSync(ownedSessionDir, { recursive: true });
    fs.symlinkSync(foreignDir, ownedSessionDir, 'dir');

    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: false,
      reason: 'unsafe_session_path',
    });
  });

  it('rejects a canonical Mattermost workspace directory replaced by a foreign symlink', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const { session } = resolveSession(channel.agentGroup.id, channel.messagingGroup.id, null, 'shared');
    const groupDir = path.join(GROUPS_DIR, channel.agentGroup.folder);
    const foreignDir = path.join(TEST_ROOT, 'foreign-group-workspace');
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.rmSync(groupDir, { recursive: true });
    fs.symlinkSync(foreignDir, groupDir, 'dir');

    expect(validateMattermostSessionForExecution(session)).toEqual({
      strict: true,
      valid: false,
      reason: 'unsafe_session_path',
    });
  });

  it('rejects a Mattermost execution identity whose provider differs from the persisted session', () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const { session } = resolveSession(channel.agentGroup.id, channel.messagingGroup.id, null, 'shared');

    expect(validateMattermostSessionForExecution({ ...session, agent_provider: 'codex' })).toEqual({
      strict: true,
      valid: false,
      reason: 'session_record_mismatch',
    });
  });

  it('leaves a persisted Telegram session on the generic execution path', () => {
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-telegram-execution',
      name: 'Telegram Execution',
      folder: 'telegram-execution',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-telegram-execution',
      channel_type: 'telegram',
      platform_id: 'telegram:-100123',
      name: 'Telegram Execution',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-telegram-execution',
      messaging_group_id: 'mg-telegram-execution',
      agent_group_id: 'ag-telegram-execution',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    const { session } = resolveSession('ag-telegram-execution', 'mg-telegram-execution', null, 'shared');

    expect(validateMattermostSessionForExecution(session)).toEqual({ strict: false });
  });
});
