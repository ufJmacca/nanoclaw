import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT, initGroupFilesystem, wakeContainer } = vi.hoisted(() => ({
  TEST_ROOT: '/tmp/nanoclaw-test-mattermost-subscription',
  initGroupFilesystem: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../group-init.js', () => ({ initGroupFilesystem }));
vi.mock('../container-runner.js', () => ({
  wakeContainer,
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
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
  getDb,
  getSessionsByAgentGroup,
  initDb,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { routeInbound, setChannelRequestGate, setSenderResolver } from '../router.js';
import {
  subscribeMattermostChannelStrict,
  validateMattermostSubscriptionForRouting,
} from './mattermost-subscription.js';

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
});
