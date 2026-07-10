import fs from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-thread-policy' };
});

vi.mock('./channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(),
}));

import { getChannelAdapter } from './channels/channel-registry.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { resolveEffectiveSessionMode, routeInbound } from './router.js';
import { inboundDbPath } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-thread-policy';

function now(): string {
  return new Date().toISOString();
}

function seedMattermostChannel(channel: 'a' | 'b' = 'a'): void {
  createAgentGroup({
    id: `ag-mattermost-${channel}`,
    name: `Mattermost ${channel.toUpperCase()}`,
    folder: `mattermost-${channel}`,
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: `mg-mattermost-${channel}`,
    channel_type: 'mattermost',
    platform_id: `mattermost:primary:channel-${channel}`,
    name: `Channel ${channel.toUpperCase()}`,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: `mga-mattermost-${channel}`,
    messaging_group_id: `mg-mattermost-${channel}`,
    agent_group_id: `ag-mattermost-${channel}`,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

function seedTelegramChannel(): void {
  createAgentGroup({
    id: 'ag-telegram',
    name: 'Telegram',
    folder: 'telegram',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-telegram',
    channel_type: 'telegram',
    platform_id: 'telegram:-100123',
    name: 'Telegram Group',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
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
    created_at: now(),
  });
}

function mattermostEvent(id: string, threadId: string | null, channel: 'a' | 'b' = 'a') {
  return {
    channelType: 'mattermost',
    platformId: `mattermost:primary:channel-${channel}`,
    threadId,
    message: {
      id,
      kind: 'chat' as const,
      content: JSON.stringify({ sender: 'Ada', senderId: 'mattermost:user-a', text: id }),
      timestamp: now(),
      isGroup: true,
    },
  };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  vi.mocked(getChannelAdapter).mockReturnValue({
    supportsThreads: true,
    threadSessionPolicy: 'honor-wiring',
  } as never);
  seedMattermostChannel();
});

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('Mattermost thread/session policy', () => {
  it('resolves context mode independently from UI thread support', () => {
    expect(resolveEffectiveSessionMode('shared', true, 'honor-wiring')).toBe('shared');
    expect(resolveEffectiveSessionMode('shared', true, 'force-per-thread')).toBe('per-thread');
    expect(resolveEffectiveSessionMode('agent-shared', true, 'force-per-thread')).toBe('agent-shared');
    expect(resolveEffectiveSessionMode('shared', false, 'force-per-thread')).toBe('shared');
  });

  it('routes a channel root and its thread replies into one shared session', async () => {
    await routeInbound(mattermostEvent('root-message', null));
    await routeInbound(mattermostEvent('thread-reply', 'root-post-id'));

    const sessions = getSessionsByAgentGroup('ag-mattermost-a');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].thread_id).toBeNull();
  });

  it('keeps root_id as per-message delivery metadata in the shared session', async () => {
    await routeInbound(mattermostEvent('thread-reply', 'root-post-id'));

    const [session] = getSessionsByAgentGroup('ag-mattermost-a');
    const db = new Database(inboundDbPath('ag-mattermost-a', session.id));
    const row = db.prepare('SELECT thread_id FROM messages_in LIMIT 1').get() as {
      thread_id: string | null;
    };
    db.close();

    expect(row.thread_id).toBe('root-post-id');
  });

  it('keeps a second Mattermost channel in a distinct session', async () => {
    seedMattermostChannel('b');

    await routeInbound(mattermostEvent('channel-a-message', null, 'a'));
    await routeInbound(mattermostEvent('channel-b-message', null, 'b'));

    const [sessionA] = getSessionsByAgentGroup('ag-mattermost-a');
    const [sessionB] = getSessionsByAgentGroup('ag-mattermost-b');
    expect(sessionA.id).not.toBe(sessionB.id);
    expect(sessionA.messaging_group_id).toBe('mg-mattermost-a');
    expect(sessionB.messaging_group_id).toBe('mg-mattermost-b');
  });

  it('keeps the legacy force-per-thread default for threaded adapters without a policy', async () => {
    vi.mocked(getChannelAdapter).mockReturnValue({ supportsThreads: true } as never);

    await routeInbound(mattermostEvent('legacy-root', null));
    await routeInbound(mattermostEvent('legacy-thread', 'root-post-id'));

    const sessions = getSessionsByAgentGroup('ag-mattermost-a');
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.thread_id)).toEqual(expect.arrayContaining([null, 'root-post-id']));
  });

  it('keeps Telegram channel-scoped session and delivery behavior unchanged', async () => {
    seedTelegramChannel();
    vi.mocked(getChannelAdapter).mockReturnValue({ supportsThreads: false } as never);

    await routeInbound({
      channelType: 'telegram',
      platformId: 'telegram:-100123',
      threadId: 'ignored-telegram-thread',
      message: {
        id: 'telegram-message',
        kind: 'chat',
        content: JSON.stringify({ sender: 'Tess', senderId: 'telegram:user-t', text: 'Telegram message' }),
        timestamp: now(),
        isGroup: true,
      },
    });

    const [session] = getSessionsByAgentGroup('ag-telegram');
    expect(session.thread_id).toBeNull();
    const db = new Database(inboundDbPath('ag-telegram', session.id));
    const row = db.prepare('SELECT thread_id FROM messages_in LIMIT 1').get() as { thread_id: string | null };
    db.close();
    expect(row.thread_id).toBeNull();
  });
});
