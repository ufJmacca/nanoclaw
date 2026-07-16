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
import path from 'node:path';
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
import { inboundDbPath, resolveSession, outboundDbPath, sessionDir } from './session-manager.js';
import * as deliveryModule from './delivery.js';
import {
  DeliveryAdapterUnavailableError,
  deliverSessionMessages,
  setDeliveryAdapter,
  startDeliveryIntake,
} from './delivery.js';
import { UnconfirmedAttachmentDeliveryError } from './channels/adapter.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

function insertMattermostOutbound(
  agentGroupId: string,
  sessionId: string,
  msgId: string,
  threadId: string | null,
): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, datetime('now'), 'chat', 'mattermost:primary:channel-a', 'mattermost', ?, ?)`,
  ).run(msgId, threadId, JSON.stringify({ text: 'hello' }));
  db.close();
}

beforeEach(() => {
  startDeliveryIntake();
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

  it('leaves Mattermost outbound work due while its channel adapter is unavailable', async () => {
    seedMattermostAgentAndChannel();
    const { session } = resolveSession('ag-mattermost-a', 'mg-mattermost-a', null, 'shared');
    insertMattermostOutbound(session.agent_group_id, session.id, 'out-adapter-unavailable', null);
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
    const deliver = vi.fn().mockResolvedValue(undefined);
    setDeliveryAdapter({
      isAvailable: (channelType) => channelType !== 'mattermost',
      deliver,
    });

    for (let poll = 0; poll < 4; poll++) {
      await deliverSessionMessages(session);
    }

    expect(deliver).not.toHaveBeenCalled();
    const inDb = new Database(inboundDbPath(session.agent_group_id, session.id));
    expect(inDb.prepare('SELECT COUNT(*) AS count FROM delivered').get()).toEqual({ count: 0 });
    inDb.close();
    const outDb = new Database(outboundDbPath(session.agent_group_id, session.id), { readonly: true });
    expect(
      outDb
        .prepare(
          `SELECT COUNT(*) AS count
             FROM messages_out
            WHERE id = ? AND (deliver_after IS NULL OR deliver_after <= datetime('now'))`,
        )
        .get('out-adapter-unavailable'),
    ).toEqual({ count: 1 });
    outDb.close();
  });

  it('keeps retry budget intact when a Mattermost adapter disappears during delivery', async () => {
    seedMattermostAgentAndChannel();
    const { session } = resolveSession('ag-mattermost-a', 'mg-mattermost-a', null, 'shared');
    insertMattermostOutbound(session.agent_group_id, session.id, 'out-adapter-race', null);
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
    const deliver = vi.fn().mockRejectedValue(new DeliveryAdapterUnavailableError('mattermost'));
    setDeliveryAdapter({
      isAvailable: () => true,
      deliver,
    });

    for (let poll = 0; poll < 4; poll++) {
      await deliverSessionMessages(session);
    }

    expect(deliver).toHaveBeenCalledTimes(4);
    const inDb = new Database(inboundDbPath(session.agent_group_id, session.id));
    expect(inDb.prepare('SELECT COUNT(*) AS count FROM delivered').get()).toEqual({ count: 0 });
    inDb.close();
  });

  it('retains Mattermost outbox files until attachment association is confirmed, then clears them once', async () => {
    seedMattermostAgentAndChannel();
    const { session } = resolveSession('ag-mattermost-a', 'mg-mattermost-a', null, 'shared');
    const messageId = 'out-file-association';
    insertMattermostOutbound(session.agent_group_id, session.id, messageId, null);
    const outDb = new Database(outboundDbPath(session.agent_group_id, session.id));
    outDb
      .prepare('UPDATE messages_out SET content = ? WHERE id = ?')
      .run(JSON.stringify({ text: 'file caption', files: ['report.txt'] }), messageId);
    outDb.close();
    const attachmentPath = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', messageId, 'report.txt');
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, 'exact outbound bytes');
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
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error('Mattermost delivery response did not confirm file associations'))
      .mockResolvedValue('confirmed-post-id');
    setDeliveryAdapter({ deliver });

    await deliverSessionMessages(session);

    expect(fs.readFileSync(attachmentPath, 'utf8')).toBe('exact outbound bytes');
    expect(deliver).toHaveBeenCalledWith(
      'mattermost',
      'mattermost:primary:channel-a',
      null,
      'chat',
      JSON.stringify({ text: 'file caption', files: ['report.txt'] }),
      [{ filename: 'report.txt', data: Buffer.from('exact outbound bytes') }],
      messageId,
    );
    let inbound = new Database(inboundDbPath(session.agent_group_id, session.id));
    expect(inbound.prepare('SELECT COUNT(*) AS count FROM delivered').get()).toEqual({ count: 0 });
    inbound.close();

    await deliverSessionMessages(session);
    expect(fs.existsSync(path.dirname(attachmentPath))).toBe(false);
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(2);
    inbound = new Database(inboundDbPath(session.agent_group_id, session.id));
    expect(inbound.prepare('SELECT COUNT(*) AS count FROM delivered').get()).toEqual({ count: 1 });
    inbound.close();
  });

  it('never terminally marks or clears an unconfirmed Mattermost attachment delivery', async () => {
    seedMattermostAgentAndChannel();
    const { session } = resolveSession('ag-mattermost-a', 'mg-mattermost-a', null, 'shared');
    const messageId = 'out-file-unconfirmed';
    insertMattermostOutbound(session.agent_group_id, session.id, messageId, null);
    const outDb = new Database(outboundDbPath(session.agent_group_id, session.id));
    outDb
      .prepare('UPDATE messages_out SET content = ? WHERE id = ?')
      .run(JSON.stringify({ text: 'file caption', files: ['report.txt'] }), messageId);
    outDb.close();
    const attachmentPath = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', messageId, 'report.txt');
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, 'exact outbound bytes');
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
    const deliver = vi
      .fn()
      .mockRejectedValue(new UnconfirmedAttachmentDeliveryError('association not confirmed', 'association_mismatch'));
    setDeliveryAdapter({ deliver });

    for (let poll = 0; poll < 5; poll++) await deliverSessionMessages(session);

    expect(deliver).toHaveBeenCalledTimes(5);
    expect(fs.readFileSync(attachmentPath, 'utf8')).toBe('exact outbound bytes');
    const inbound = new Database(inboundDbPath(session.agent_group_id, session.id));
    expect(inbound.prepare('SELECT COUNT(*) AS count FROM delivered').get()).toEqual({ count: 0 });
    inbound.close();
  });

  it('does not send a caption-only Mattermost post when a declared outbox file is unavailable', async () => {
    seedMattermostAgentAndChannel();
    const { session } = resolveSession('ag-mattermost-a', 'mg-mattermost-a', null, 'shared');
    const messageId = 'out-file-missing';
    insertMattermostOutbound(session.agent_group_id, session.id, messageId, null);
    const outDb = new Database(outboundDbPath(session.agent_group_id, session.id));
    outDb
      .prepare('UPDATE messages_out SET content = ? WHERE id = ?')
      .run(JSON.stringify({ text: 'must not send alone', files: ['missing.txt'] }), messageId);
    outDb.close();
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
    const deliver = vi.fn().mockResolvedValue('must-not-send');
    setDeliveryAdapter({ deliver });

    for (let poll = 0; poll < 4; poll++) await deliverSessionMessages(session);

    expect(deliver).not.toHaveBeenCalled();
    const inbound = new Database(inboundDbPath(session.agent_group_id, session.id));
    expect(inbound.prepare('SELECT COUNT(*) AS count FROM delivered').get()).toEqual({ count: 0 });
    inbound.close();
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

  it('awaits an already-started delivery drain after poll intake stops', async () => {
    const stopAndDrainDeliveryPolls = (
      deliveryModule as typeof deliveryModule & { stopAndDrainDeliveryPolls?: () => Promise<void> }
    ).stopAndDrainDeliveryPolls;
    expect(stopAndDrainDeliveryPolls).toBeTypeOf('function');
    if (!stopAndDrainDeliveryPolls) return;

    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-shutdown-drain');
    const enteredDelivery = deferred<void>();
    const releaseDelivery = deferred<void>();
    setDeliveryAdapter({
      async deliver() {
        enteredDelivery.resolve(undefined);
        await releaseDelivery.promise;
        return 'platform-shutdown-message';
      },
    });

    const delivering = deliverSessionMessages(session);
    await enteredDelivery.promise;
    let drainSettled = false;
    const draining = stopAndDrainDeliveryPolls().then(() => {
      drainSettled = true;
    });
    await Promise.resolve();

    expect(drainSettled).toBe(false);
    releaseDelivery.resolve(undefined);
    await Promise.all([delivering, draining]);

    const inDb = new Database(inboundDbPath(session.agent_group_id, session.id));
    expect(inDb.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get('out-shutdown-drain')).toEqual({
      status: 'delivered',
    });
    inDb.close();
  });

  it('does not admit a new delivery drain after shutdown intake closes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-after-delivery-shutdown');
    const deliver = vi.fn().mockResolvedValue('must-not-send');
    setDeliveryAdapter({ deliver });

    await deliveryModule.stopAndDrainDeliveryPolls();
    await deliverSessionMessages(session);

    expect(deliver).not.toHaveBeenCalled();
    const inDb = new Database(inboundDbPath(session.agent_group_id, session.id));
    expect(inDb.prepare('SELECT COUNT(*) AS count FROM delivered').get()).toEqual({ count: 0 });
    inDb.close();
  });
});
