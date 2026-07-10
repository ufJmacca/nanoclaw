import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from './types.js';

const isolationMocks = vi.hoisted(() => ({
  testRoot: `/tmp/nanoclaw-mattermost-isolation-${process.pid}`,
  wakeContainer: vi.fn(),
  getChannelAdapter: vi.fn(),
  activeSessions: new Map<string, Session>(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: `${isolationMocks.testRoot}/data`,
    GROUPS_DIR: `${isolationMocks.testRoot}/groups`,
  };
});

vi.mock('./container-runner.js', () => ({
  wakeContainer: isolationMocks.wakeContainer,
  isContainerRunning: vi.fn((sessionId: string) => isolationMocks.activeSessions.has(sessionId)),
  getActiveContainerCount: vi.fn(() => isolationMocks.activeSessions.size),
  killContainer: vi.fn(),
}));

vi.mock('./channels/channel-registry.js', () => ({
  getChannelAdapter: isolationMocks.getChannelAdapter,
}));

vi.mock('../container/agent-runner/src/destinations.js', () => ({
  findByRouting: vi.fn(() => undefined),
}));

import { subscribeMattermostChannelStrict } from './channels/mattermost-subscription.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
  getSessionsByAgentGroup,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { initGroupFilesystem } from './group-init.js';
import { writeDestinations } from './modules/agent-to-agent/write-destinations.js';
import { handleScheduleTask } from './modules/scheduling/actions.js';
import { routeInbound } from './router.js';
import { inboundDbPath, openInboundDb, outboundDbPath, sessionDir, writeSessionMessage } from './session-manager.js';

function now(): string {
  return new Date().toISOString();
}

function seedTelegram(): { agentGroupId: string; messagingGroupId: string; folder: string } {
  const createdAt = now();
  const fixture = {
    agentGroupId: 'ag-telegram-isolation',
    messagingGroupId: 'mg-telegram-isolation',
    folder: 'telegram-isolation',
  };
  const agentGroup = {
    id: fixture.agentGroupId,
    name: 'Telegram Isolation',
    folder: fixture.folder,
    agent_provider: null,
    created_at: createdAt,
  };
  createAgentGroup(agentGroup);
  createMessagingGroup({
    id: fixture.messagingGroupId,
    channel_type: 'telegram',
    platform_id: 'telegram:-100999',
    name: 'Telegram Isolation',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: createdAt,
  });
  createMessagingGroupAgent({
    id: 'mga-telegram-isolation',
    messaging_group_id: fixture.messagingGroupId,
    agent_group_id: fixture.agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: createdAt,
  });
  initGroupFilesystem(agentGroup);
  return fixture;
}

function inboundEvent(
  channelType: 'mattermost' | 'telegram',
  platformId: string,
  id: string,
  threadId: string | null = null,
) {
  return {
    channelType,
    platformId,
    threadId,
    message: {
      id,
      kind: 'chat' as const,
      content: JSON.stringify({ sender: id, senderId: `${channelType}:user`, text: id }),
      timestamp: now(),
      isGroup: true,
    },
  };
}

function readTreeText(root: string): string {
  if (!fs.existsSync(root)) return '';
  const chunks: string[] = [];
  const visit = (entryPath: string): void => {
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(entryPath)) visit(path.join(entryPath, entry));
      return;
    }
    if (stat.isFile()) chunks.push(fs.readFileSync(entryPath).toString('utf8'));
  };
  visit(root);
  return chunks.join('\n');
}

beforeEach(() => {
  fs.rmSync(isolationMocks.testRoot, { recursive: true, force: true });
  fs.mkdirSync(isolationMocks.testRoot, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  isolationMocks.activeSessions.clear();
  isolationMocks.wakeContainer.mockReset().mockImplementation(async (session: Session) => {
    isolationMocks.activeSessions.set(session.id, { ...session });
    return true;
  });
  isolationMocks.getChannelAdapter.mockImplementation((channelType: string) =>
    channelType === 'mattermost'
      ? { supportsThreads: true, threadSessionPolicy: 'honor-wiring' }
      : { supportsThreads: false },
  );
});

afterEach(() => {
  closeDb();
  isolationMocks.activeSessions.clear();
  fs.rmSync(isolationMocks.testRoot, { recursive: true, force: true });
});

describe('Mattermost A/B/Telegram structural isolation', () => {
  it('creates disjoint channel, session, workspace, and fake-launch identities', async () => {
    const channelA = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      channelName: 'Channel A',
    });
    const channelB = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-b',
      channelName: 'Channel B',
    });
    const telegram = seedTelegram();

    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-a', 'message-a', 'root-a'));
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-b', 'message-b'));
    await routeInbound(inboundEvent('telegram', 'telegram:-100999', 'message-t'));

    const [sessionA] = getSessionsByAgentGroup(channelA.agentGroup.id);
    const [sessionB] = getSessionsByAgentGroup(channelB.agentGroup.id);
    const [sessionT] = getSessionsByAgentGroup(telegram.agentGroupId);
    const sessions = [sessionA, sessionB, sessionT];

    expect(new Set([channelA.messagingGroup.id, channelB.messagingGroup.id, telegram.messagingGroupId]).size).toBe(3);
    expect(new Set([channelA.agentGroup.id, channelB.agentGroup.id, telegram.agentGroupId]).size).toBe(3);
    expect(new Set([channelA.agentGroup.folder, channelB.agentGroup.folder, telegram.folder]).size).toBe(3);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(3);
    expect(new Set(sessions.map((session) => sessionDir(session.agent_group_id, session.id))).size).toBe(3);
    expect(
      new Set(
        [channelA.agentGroup, channelB.agentGroup, { id: telegram.agentGroupId, folder: telegram.folder }].map(
          (group) => path.join(GROUPS_DIR, group.folder),
        ),
      ).size,
    ).toBe(3);
    expect(
      new Set(
        [channelA.agentGroup.id, channelB.agentGroup.id, telegram.agentGroupId].map((id) =>
          path.join(DATA_DIR, 'v2-sessions', id, '.claude-shared'),
        ),
      ).size,
    ).toBe(3);

    expect(isolationMocks.activeSessions.size).toBe(3);
    expect(new Set([...isolationMocks.activeSessions.values()].map((session) => session.messaging_group_id))).toEqual(
      new Set([channelA.messagingGroup.id, channelB.messagingGroup.id, telegram.messagingGroupId]),
    );

    for (const [session, platformId] of [
      [sessionA, 'mattermost:primary:channel-a'],
      [sessionB, 'mattermost:primary:channel-b'],
      [sessionT, 'telegram:-100999'],
    ] as const) {
      const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
      const rows = db.prepare('SELECT DISTINCT platform_id FROM messages_in').all() as Array<{ platform_id: string }>;
      db.close();
      expect(rows).toEqual([{ platform_id: platformId }]);
    }
  });

  it('rejects a host inbound write redirected through another channel database symlink', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-a', 'message-a'));
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-b', 'message-b'));
    const [sessionA] = getSessionsByAgentGroup(channelA.agentGroup.id);
    const [sessionB] = getSessionsByAgentGroup(channelB.agentGroup.id);
    const inboundA = inboundDbPath(sessionA.agent_group_id, sessionA.id);
    const inboundB = inboundDbPath(sessionB.agent_group_id, sessionB.id);
    const beforeB = new Database(inboundB, { readonly: true });
    const beforeCount = (beforeB.prepare('SELECT COUNT(*) AS count FROM messages_in').get() as { count: number }).count;
    beforeB.close();
    fs.rmSync(inboundA);
    fs.symlinkSync(inboundB, inboundA);

    expect(() =>
      writeSessionMessage(sessionA.agent_group_id, sessionA.id, {
        id: 'must-not-enter-b',
        kind: 'chat',
        timestamp: now(),
        platformId: 'mattermost:primary:channel-a',
        channelType: 'mattermost',
        threadId: null,
        content: JSON.stringify({ text: 'must remain in A' }),
      }),
    ).toThrow('Unsafe session database artifact');

    const afterB = new Database(inboundB, { readonly: true });
    expect(afterB.prepare('SELECT COUNT(*) AS count FROM messages_in').get()).toEqual({ count: beforeCount });
    expect(afterB.prepare('SELECT id FROM messages_in WHERE id = ?').get('must-not-enter-b')).toBeUndefined();
    afterB.close();
  });

  it('rejects a host inbound write redirected through another channel database hardlink', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-a', 'message-a'));
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-b', 'message-b'));
    const [sessionA] = getSessionsByAgentGroup(channelA.agentGroup.id);
    const [sessionB] = getSessionsByAgentGroup(channelB.agentGroup.id);
    const inboundA = inboundDbPath(sessionA.agent_group_id, sessionA.id);
    const inboundB = inboundDbPath(sessionB.agent_group_id, sessionB.id);
    const beforeB = new Database(inboundB, { readonly: true });
    const beforeCount = (beforeB.prepare('SELECT COUNT(*) AS count FROM messages_in').get() as { count: number }).count;
    beforeB.close();
    fs.rmSync(inboundA);
    fs.linkSync(inboundB, inboundA);

    expect(() =>
      writeSessionMessage(sessionA.agent_group_id, sessionA.id, {
        id: 'must-not-hardlink-enter-b',
        kind: 'chat',
        timestamp: now(),
        platformId: 'mattermost:primary:channel-a',
        channelType: 'mattermost',
        threadId: null,
        content: JSON.stringify({ text: 'must remain in A' }),
      }),
    ).toThrow('Unsafe session database artifact');

    const afterB = new Database(inboundB, { readonly: true });
    expect(afterB.prepare('SELECT COUNT(*) AS count FROM messages_in').get()).toEqual({ count: beforeCount });
    expect(afterB.prepare('SELECT id FROM messages_in WHERE id = ?').get('must-not-hardlink-enter-b')).toBeUndefined();
    afterB.close();
  });

  it('rejects a redirected SQLite sidecar before opening a channel database', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-a', 'message-a'));
    const [sessionA] = getSessionsByAgentGroup(channelA.agentGroup.id);
    const foreignSidecar = path.join(isolationMocks.testRoot, 'foreign-journal');
    fs.writeFileSync(foreignSidecar, 'FOREIGN_SIDECAR_MARKER');
    fs.symlinkSync(foreignSidecar, `${inboundDbPath(sessionA.agent_group_id, sessionA.id)}-journal`);

    expect(() => openInboundDb(sessionA.agent_group_id, sessionA.id)).toThrow('Unsafe session database artifact');
    expect(fs.readFileSync(foreignSidecar, 'utf8')).toBe('FOREIGN_SIDECAR_MARKER');
  });

  it('rejects a hardlinked SQLite sidecar before opening a channel database', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-a', 'message-a'));
    const [sessionA] = getSessionsByAgentGroup(channelA.agentGroup.id);
    const foreignSidecar = path.join(isolationMocks.testRoot, 'foreign-hardlinked-journal');
    fs.writeFileSync(foreignSidecar, 'FOREIGN_HARDLINKED_SIDECAR_MARKER');
    fs.linkSync(foreignSidecar, `${inboundDbPath(sessionA.agent_group_id, sessionA.id)}-journal`);

    expect(() => openInboundDb(sessionA.agent_group_id, sessionA.id)).toThrow('Unsafe session database artifact');
    expect(fs.readFileSync(foreignSidecar, 'utf8')).toBe('FOREIGN_HARDLINKED_SIDECAR_MARKER');
  });

  it('rejects a forged cross-channel Mattermost schedule route', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-a', 'message-a', 'root-a'));
    const [sessionA] = getSessionsByAgentGroup(channelA.agentGroup.id);
    const inDb = openInboundDb(sessionA.agent_group_id, sessionA.id);

    try {
      await expect(
        handleScheduleTask(
          {
            taskId: 'task-forged-b',
            prompt: 'must stay in A',
            script: null,
            processAfter: '2030-01-01T09:00:00.000Z',
            recurrence: null,
            channelType: 'mattermost',
            platformId: 'mattermost:primary:channel-b',
            threadId: 'root-b',
          },
          sessionA,
          inDb,
        ),
      ).rejects.toThrow('Invalid Mattermost scheduled task route');
      expect(inDb.prepare("SELECT COUNT(*) AS count FROM messages_in WHERE kind = 'task'").get()).toEqual({
        count: 0,
      });
    } finally {
      inDb.close();
    }

    expect(
      getDb().prepare('SELECT COUNT(*) AS count FROM sessions WHERE agent_group_id = ?').get(channelA.agentGroup.id),
    ).toEqual({ count: 1 });
  });

  it('rejects an unobserved Mattermost root on an otherwise canonical schedule route', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-a', 'message-a'));
    const [sessionA] = getSessionsByAgentGroup(channelA.agentGroup.id);
    const inDb = openInboundDb(sessionA.agent_group_id, sessionA.id);

    try {
      await expect(
        handleScheduleTask(
          {
            taskId: 'task-forged-root',
            prompt: 'must remain in an observed A thread',
            script: null,
            processAfter: '2030-01-01T09:00:00.000Z',
            recurrence: null,
            channelType: 'mattermost',
            platformId: 'mattermost:primary:channel-a',
            threadId: 'root-never-observed-in-a',
          },
          sessionA,
          inDb,
        ),
      ).rejects.toThrow('Invalid Mattermost scheduled task root');
      expect(inDb.prepare("SELECT COUNT(*) AS count FROM messages_in WHERE kind = 'task'").get()).toEqual({
        count: 0,
      });
    } finally {
      inDb.close();
    }
  });

  it('keeps schedules and projected destinations in their owning session', async () => {
    const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
    const telegram = seedTelegram();
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-a', 'message-a', 'root-a'));
    await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-b', 'message-b'));
    await routeInbound(inboundEvent('telegram', 'telegram:-100999', 'message-t'));

    const fixtures = [
      {
        agentGroupId: channelA.agentGroup.id,
        messagingGroupId: channelA.messagingGroup.id,
        session: getSessionsByAgentGroup(channelA.agentGroup.id)[0],
        taskId: 'task-a',
        channelType: 'mattermost',
        platformId: 'mattermost:primary:channel-a',
        threadId: 'root-a',
      },
      {
        agentGroupId: channelB.agentGroup.id,
        messagingGroupId: channelB.messagingGroup.id,
        session: getSessionsByAgentGroup(channelB.agentGroup.id)[0],
        taskId: 'task-b',
        channelType: 'mattermost',
        platformId: 'mattermost:primary:channel-b',
        threadId: null,
      },
      {
        agentGroupId: telegram.agentGroupId,
        messagingGroupId: telegram.messagingGroupId,
        session: getSessionsByAgentGroup(telegram.agentGroupId)[0],
        taskId: 'task-t',
        channelType: 'telegram',
        platformId: 'telegram:-100999',
        threadId: null,
      },
    ];

    for (const fixture of fixtures) {
      const inDb = openInboundDb(fixture.agentGroupId, fixture.session.id);
      try {
        await handleScheduleTask(
          {
            taskId: fixture.taskId,
            prompt: `prompt-${fixture.taskId}`,
            script: null,
            processAfter: '2030-01-01T09:00:00.000Z',
            recurrence: null,
            channelType: fixture.channelType,
            platformId: fixture.platformId,
            threadId: fixture.threadId,
          },
          fixture.session,
          inDb,
        );
      } finally {
        inDb.close();
      }
      writeDestinations(fixture.agentGroupId, fixture.session.id);
    }

    for (const fixture of fixtures) {
      const db = new Database(inboundDbPath(fixture.agentGroupId, fixture.session.id), { readonly: true });
      const tasks = db
        .prepare("SELECT id, channel_type, platform_id, thread_id FROM messages_in WHERE kind = 'task'")
        .all();
      const destinations = db.prepare('SELECT type, channel_type, platform_id, agent_group_id FROM destinations').all();
      db.close();
      expect(tasks).toEqual([
        {
          id: fixture.taskId,
          channel_type: fixture.channelType,
          platform_id: fixture.platformId,
          thread_id: fixture.threadId,
        },
      ]);
      expect(destinations).toEqual([
        {
          type: 'channel',
          channel_type: fixture.channelType,
          platform_id: fixture.platformId,
          agent_group_id: null,
        },
      ]);
      expect(
        getDb()
          .prepare('SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ?')
          .all(fixture.agentGroupId),
      ).toEqual([{ target_type: 'channel', target_id: fixture.messagingGroupId }]);
    }
  });

  it('keeps synthetic context markers and the host token out of foreign model inputs and files', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = `TOKEN_${randomUUID()}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    try {
      const { formatMessages } = (await vi.importActual('../container/agent-runner/src/formatter.js')) as {
        formatMessages: (messages: Array<Record<string, unknown>>) => string;
      };
      const channelA = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
      const channelB = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-b' });
      const telegram = seedTelegram();
      await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-a', 'message-a'));
      await routeInbound(inboundEvent('mattermost', 'mattermost:primary:channel-b', 'message-b'));
      await routeInbound(inboundEvent('telegram', 'telegram:-100999', 'message-t'));

      const fixtures = [
        {
          marker: `MARKER_A_${randomUUID()}`,
          agentGroupId: channelA.agentGroup.id,
          folder: channelA.agentGroup.folder,
          session: getSessionsByAgentGroup(channelA.agentGroup.id)[0],
          channelType: 'mattermost',
          platformId: 'mattermost:primary:channel-a',
        },
        {
          marker: `MARKER_B_${randomUUID()}`,
          agentGroupId: channelB.agentGroup.id,
          folder: channelB.agentGroup.folder,
          session: getSessionsByAgentGroup(channelB.agentGroup.id)[0],
          channelType: 'mattermost',
          platformId: 'mattermost:primary:channel-b',
        },
        {
          marker: `MARKER_T_${randomUUID()}`,
          agentGroupId: telegram.agentGroupId,
          folder: telegram.folder,
          session: getSessionsByAgentGroup(telegram.agentGroupId)[0],
          channelType: 'telegram',
          platformId: 'telegram:-100999',
        },
      ];

      for (const fixture of fixtures) {
        writeSessionMessage(fixture.agentGroupId, fixture.session.id, {
          id: `marker-message-${fixture.agentGroupId}`,
          kind: 'chat',
          timestamp: now(),
          platformId: fixture.platformId,
          channelType: fixture.channelType,
          threadId: null,
          content: JSON.stringify({ sender: 'marker-fixture', text: fixture.marker }),
        });
        const groupDir = path.join(GROUPS_DIR, fixture.folder);
        const claudeDir = path.join(DATA_DIR, 'v2-sessions', fixture.agentGroupId, '.claude-shared');
        fs.writeFileSync(path.join(groupDir, 'context-marker.txt'), fixture.marker);
        fs.writeFileSync(path.join(claudeDir, 'memory-marker.txt'), fixture.marker);
        const outbound = new Database(outboundDbPath(fixture.agentGroupId, fixture.session.id));
        outbound
          .prepare("INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES ('continuation:marker', ?, ?)")
          .run(fixture.marker, now());
        outbound.close();
      }

      const allMarkers = fixtures.map((fixture) => fixture.marker);
      for (const fixture of fixtures) {
        const inbound = new Database(inboundDbPath(fixture.agentGroupId, fixture.session.id), { readonly: true });
        const messages = inbound.prepare('SELECT * FROM messages_in ORDER BY seq').all() as Array<
          Record<string, unknown>
        >;
        inbound.close();
        const prompt = formatMessages(messages);
        const outbound = new Database(outboundDbPath(fixture.agentGroupId, fixture.session.id), { readonly: true });
        const continuation = outbound
          .prepare("SELECT value FROM session_state WHERE key = 'continuation:marker'")
          .get() as { value: string };
        outbound.close();
        const mountedDataText = [
          path.join(GROUPS_DIR, fixture.folder),
          sessionDir(fixture.agentGroupId, fixture.session.id),
          path.join(DATA_DIR, 'v2-sessions', fixture.agentGroupId, '.claude-shared'),
        ]
          .map(readTreeText)
          .join('\n');

        expect(prompt).toContain(fixture.marker);
        expect(continuation.value).toBe(fixture.marker);
        expect(mountedDataText).toContain(fixture.marker);
        for (const foreignMarker of allMarkers.filter((marker) => marker !== fixture.marker)) {
          expect(prompt).not.toContain(foreignMarker);
          expect(continuation.value).not.toContain(foreignMarker);
          expect(mountedDataText).not.toContain(foreignMarker);
        }
        expect(prompt).not.toContain(credential);
        expect(continuation.value).not.toContain(credential);
        expect(mountedDataText).not.toContain(credential);
      }

      const centralState = JSON.stringify({
        subscriptions: getDb().prepare('SELECT * FROM mattermost_subscriptions').all(),
        sessions: getDb().prepare('SELECT * FROM sessions').all(),
        groups: getDb().prepare('SELECT * FROM agent_groups').all(),
        channels: getDb().prepare('SELECT * FROM messaging_groups').all(),
        destinations: getDb().prepare('SELECT * FROM agent_destinations').all(),
      });
      expect(centralState).not.toContain(credential);
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
  });
});
