/**
 * Delivery race tests.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages. A running session
 * sits in both result sets, so the two timer chains can race on the same
 * outbound row — read-undelivered → call channel API → markDelivered. The
 * INSERT OR IGNORE in markDelivered makes the DB write idempotent, but
 * the channel API has already fired twice → user sees the message twice.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const deliveryMocks = vi.hoisted(() => ({
  validateMattermostSessionForExecution: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery' };
});

vi.mock('./channels/mattermost-subscription.js', () => ({
  validateMattermostSessionForExecution: deliveryMocks.validateMattermostSessionForExecution,
}));

const TEST_DIR = '/tmp/nanoclaw-test-delivery';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { insertMessage } from './db/session-db.js';
import { inboundDbPath, resolveSession, outboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify({ text: 'hello' }));
  db.close();
}

function seedMattermostAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-mattermost-a',
    name: 'Mattermost A',
    folder: 'mattermost-a',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-mattermost-a',
    channel_type: 'mattermost',
    platform_id: 'mattermost:primary:channel-a',
    name: 'Mattermost A',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
}

function insertMattermostOutbound(agentGroupId: string, sessionId: string, msgId: string, threadId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, datetime('now'), 'chat', 'mattermost:primary:channel-a', 'mattermost', ?, ?)`,
  ).run(msgId, threadId, JSON.stringify({ text: 'hello' }));
  db.close();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  deliveryMocks.validateMattermostSessionForExecution.mockReset().mockReturnValue({ strict: false });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('forwards the stable outbox message id as the delivery id', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-stable-delivery-id');
    const deliver = vi.fn().mockResolvedValue('platform-message-id');
    setDeliveryAdapter({ deliver });

    await deliverSessionMessages(session);

    expect(deliver).toHaveBeenCalledWith(
      'telegram',
      'telegram:123',
      null,
      'chat',
      JSON.stringify({ text: 'hello' }),
      undefined,
      'out-stable-delivery-id',
    );
  });

  it('rejects an invalid Mattermost session before draining its outbound queue', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-invalid-session');
    const deliver = vi.fn().mockResolvedValue('platform-message-id');
    setDeliveryAdapter({ deliver });
    deliveryMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: false,
      reason: 'session_identity_mismatch',
    });

    await deliverSessionMessages(session);

    expect(deliveryMocks.validateMattermostSessionForExecution).toHaveBeenCalledWith(session);
    expect(deliver).not.toHaveBeenCalled();
    const db = new Database(inboundDbPath(session.agent_group_id, session.id));
    expect(db.prepare('SELECT COUNT(*) AS count FROM delivered').get()).toEqual({ count: 0 });
    db.close();
  });

  it('rejects a Mattermost outbound root that was observed only outside its canonical channel', async () => {
    seedMattermostAgentAndChannel();
    const { session } = resolveSession('ag-mattermost-a', 'mg-mattermost-a', null, 'shared');
    const inDb = new Database(inboundDbPath(session.agent_group_id, session.id));
    insertMessage(inDb, {
      id: 'inbound-foreign-root',
      kind: 'chat',
      timestamp: now(),
      platformId: 'mattermost:primary:channel-b',
      channelType: 'mattermost',
      threadId: 'root-b',
      content: JSON.stringify({ text: 'foreign' }),
      processAfter: null,
      recurrence: null,
    });
    inDb.close();
    insertMattermostOutbound(session.agent_group_id, session.id, 'out-foreign-root', 'root-b');
    deliveryMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: true,
      value: {
        messagingGroup: {
          id: 'mg-mattermost-a',
          channel_type: 'mattermost',
          platform_id: 'mattermost:primary:channel-a',
        },
      },
    });
    const deliver = vi.fn().mockResolvedValue('platform-message-id');
    setDeliveryAdapter({ deliver });

    await deliverSessionMessages(session);

    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers a Mattermost reply to a root observed in its canonical channel session', async () => {
    seedMattermostAgentAndChannel();
    const { session } = resolveSession('ag-mattermost-a', 'mg-mattermost-a', null, 'shared');
    const inDb = new Database(inboundDbPath(session.agent_group_id, session.id));
    insertMessage(inDb, {
      id: 'inbound-canonical-root',
      kind: 'chat',
      timestamp: now(),
      platformId: 'mattermost:primary:channel-a',
      channelType: 'mattermost',
      threadId: 'root-a',
      content: JSON.stringify({ text: 'canonical' }),
      processAfter: null,
      recurrence: null,
    });
    inDb.close();
    insertMattermostOutbound(session.agent_group_id, session.id, 'out-canonical-root', 'root-a');
    deliveryMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: true,
      value: {
        messagingGroup: {
          id: 'mg-mattermost-a',
          channel_type: 'mattermost',
          platform_id: 'mattermost:primary:channel-a',
        },
      },
    });
    const deliver = vi.fn().mockResolvedValue('platform-message-id');
    setDeliveryAdapter({ deliver });

    await deliverSessionMessages(session);

    expect(deliver).toHaveBeenCalledWith(
      'mattermost',
      'mattermost:primary:channel-a',
      'root-a',
      'chat',
      JSON.stringify({ text: 'hello' }),
      undefined,
      'out-canonical-root',
    );
  });

  it('stops a queued Mattermost drain when the subscription is deactivated after one delivery', async () => {
    seedMattermostAgentAndChannel();
    const { session } = resolveSession('ag-mattermost-a', 'mg-mattermost-a', null, 'shared');
    const inDb = new Database(inboundDbPath(session.agent_group_id, session.id));
    insertMessage(inDb, {
      id: 'inbound-root',
      kind: 'chat',
      timestamp: now(),
      platformId: 'mattermost:primary:channel-a',
      channelType: 'mattermost',
      threadId: 'root-a',
      content: JSON.stringify({ text: 'canonical' }),
      processAfter: null,
      recurrence: null,
    });
    inDb.close();
    insertMattermostOutbound(session.agent_group_id, session.id, 'out-before-deactivate', 'root-a');
    insertMattermostOutbound(session.agent_group_id, session.id, 'out-after-deactivate', 'root-a');
    const validBoundary = {
      strict: true as const,
      valid: true as const,
      value: {
        messagingGroup: {
          id: 'mg-mattermost-a',
          channel_type: 'mattermost',
          platform_id: 'mattermost:primary:channel-a',
        },
      },
    };
    deliveryMocks.validateMattermostSessionForExecution
      .mockReturnValueOnce(validBoundary)
      .mockReturnValueOnce(validBoundary)
      .mockReturnValue({ strict: true, valid: false, reason: 'inactive_subscription' });
    const deliver = vi.fn().mockResolvedValue('platform-message-id');
    setDeliveryAdapter({ deliver });

    await deliverSessionMessages(session);

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0][6]).toBe('out-before-deactivate');
  });

  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        // Hold long enough that the second concurrent caller can race the
        // read-undelivered → markDelivered window.
        await new Promise((r) => setTimeout(r, 100));
        return 'plat-msg-1';
      },
    });

    // Two concurrent calls — simulating active (1s) and sweep (60s) polls
    // hitting the same running session at the same moment.
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);

    expect(calls).toHaveLength(1);
  });

  it('still delivers on a subsequent call after the first finishes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    // Insert a second outbound message and deliver again — the lock from
    // the first call must have been released.
    insertOutbound('ag-1', session.id, 'out-second');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('does not re-deliver when retried after a successful send (cleanup-after-send safety)', async () => {
    // If something post-send throws (e.g. outbox cleanup), the message has
    // still landed on the user's screen — the catch path must not trigger
    // a re-send. We simulate by having the adapter succeed on the first
    // call and recording how many times it's invoked across two attempts.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-once');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    // Re-invoke — should be idempotent because the message is now in the
    // delivered table; the channel adapter must not be called again.
    await deliverSessionMessages(session);

    expect(callCount).toBe(1);
  });
});
