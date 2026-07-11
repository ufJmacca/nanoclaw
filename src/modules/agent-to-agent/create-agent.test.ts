import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createAgentMocks = vi.hoisted(() => ({
  testRoot: `/tmp/nanoclaw-create-agent-isolation-${process.pid}`,
  initGroupFilesystem: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: `${createAgentMocks.testRoot}/data`,
    GROUPS_DIR: `${createAgentMocks.testRoot}/groups`,
  };
});

vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: createAgentMocks.initGroupFilesystem,
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: createAgentMocks.wakeContainer,
}));

import { subscribeMattermostChannelStrict } from '../../channels/mattermost-subscription.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  getDb,
  getSessionsByAgentGroup,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { initSessionFolder, openInboundDb, resolveSession, sessionDir } from '../../session-manager.js';
import { routeAgentMessage } from './agent-route.js';
import { handleCreateAgent } from './create-agent.js';

beforeEach(() => {
  fs.rmSync(createAgentMocks.testRoot, { recursive: true, force: true });
  fs.mkdirSync(createAgentMocks.testRoot, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentMocks.initGroupFilesystem.mockReset();
  createAgentMocks.wakeContainer.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  closeDb();
  fs.rmSync(createAgentMocks.testRoot, { recursive: true, force: true });
});

describe('Mattermost create_agent isolation', () => {
  it('rejects before creating an orphan agent, workspace, or destination', async () => {
    const channel = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-a',
      channelName: 'Channel A',
    });
    const { session } = resolveSession(channel.agentGroup.id, channel.messagingGroup.id, null, 'shared');
    createAgentMocks.initGroupFilesystem.mockClear();

    await expect(
      handleCreateAgent(
        {
          requestId: 'request-create-child',
          name: 'Leaky Child',
          instructions: 'foreign context',
        },
        session,
      ),
    ).resolves.toBeUndefined();

    expect(createAgentMocks.initGroupFilesystem).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT id FROM agent_groups ORDER BY id').all()).toEqual([{ id: channel.agentGroup.id }]);
    expect(
      getDb()
        .prepare('SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ?')
        .all(channel.agentGroup.id),
    ).toEqual([{ target_type: 'channel', target_id: channel.messagingGroup.id }]);
  });

  it('rejects a Mattermost-to-agent route before creating a target session', async () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const { session } = resolveSession(channel.agentGroup.id, channel.messagingGroup.id, null, 'shared');
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-generic-target',
      name: 'Generic Target',
      folder: 'generic-target',
      agent_provider: null,
      created_at: createdAt,
    });
    getDb().exec('DROP TRIGGER mattermost_guard_outgoing_destination_insert');
    getDb()
      .prepare(
        `INSERT INTO agent_destinations (
           agent_group_id, local_name, target_type, target_id, created_at
         ) VALUES (?, 'generic-target', 'agent', 'ag-generic-target', ?)`,
      )
      .run(channel.agentGroup.id, createdAt);

    await expect(
      routeAgentMessage(
        {
          id: 'outbound-mattermost-agent-message',
          platform_id: 'ag-generic-target',
          content: JSON.stringify({ text: 'must not cross' }),
        },
        session,
      ),
    ).rejects.toThrow('Invalid Mattermost execution session');

    expect(getSessionsByAgentGroup('ag-generic-target')).toHaveLength(0);
    expect(createAgentMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('rejects a generic-agent route into Mattermost before creating target context', async () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const createdAt = new Date().toISOString();
    createAgentGroup({
      id: 'ag-generic-source',
      name: 'Generic Source',
      folder: 'generic-source',
      agent_provider: null,
      created_at: createdAt,
    });
    createMessagingGroup({
      id: 'mg-generic-source',
      channel_type: 'telegram',
      platform_id: 'telegram:-100123',
      name: 'Generic Source',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-generic-source',
      messaging_group_id: 'mg-generic-source',
      agent_group_id: 'ag-generic-source',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    const { session } = resolveSession('ag-generic-source', 'mg-generic-source', null, 'shared');
    getDb().exec('DROP TRIGGER mattermost_guard_incoming_destination_insert');
    getDb()
      .prepare(
        `INSERT INTO agent_destinations (
           agent_group_id, local_name, target_type, target_id, created_at
         ) VALUES ('ag-generic-source', 'mattermost-a', 'agent', ?, ?)`,
      )
      .run(channel.agentGroup.id, createdAt);

    await expect(
      routeAgentMessage(
        {
          id: 'inbound-mattermost-agent-message',
          platform_id: channel.agentGroup.id,
          content: JSON.stringify({ text: 'must not cross' }),
        },
        session,
      ),
    ).rejects.toThrow('Mattermost agent-to-agent routing is disabled');

    expect(getSessionsByAgentGroup(channel.agentGroup.id)).toHaveLength(0);
    expect(createAgentMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('keeps a Mattermost self-message inside its canonical session', async () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const { session } = resolveSession(channel.agentGroup.id, channel.messagingGroup.id, null, 'shared');

    await expect(
      routeAgentMessage(
        {
          id: 'mattermost-self-message',
          platform_id: channel.agentGroup.id,
          content: JSON.stringify({ text: 'private system note' }),
        },
        session,
      ),
    ).resolves.toBeUndefined();

    const sessions = getSessionsByAgentGroup(channel.agentGroup.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: session.id,
      agent_group_id: session.agent_group_id,
      messaging_group_id: session.messaging_group_id,
      thread_id: null,
    });
    expect(createAgentMocks.wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('rejects Mattermost self-routing when a duplicate active session makes ownership ambiguous', async () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const { session } = resolveSession(channel.agentGroup.id, channel.messagingGroup.id, null, 'shared');
    const duplicate = {
      ...session,
      id: 'session-duplicate-self-route',
      created_at: new Date(Date.now() + 1).toISOString(),
    };
    createSession(duplicate);
    initSessionFolder(duplicate.agent_group_id, duplicate.id);

    await expect(
      routeAgentMessage(
        {
          id: 'mattermost-ambiguous-self-message',
          platform_id: channel.agentGroup.id,
          content: JSON.stringify({ text: 'must not enter either session' }),
        },
        session,
      ),
    ).rejects.toThrow('Invalid Mattermost execution session');

    for (const candidate of [session, duplicate]) {
      const db = openInboundDb(candidate.agent_group_id, candidate.id);
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages_in WHERE channel_type = 'agent'").get()).toEqual({
        count: 0,
      });
      db.close();
    }
    expect(createAgentMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('does not follow a symlinked Mattermost self-route outbox into foreign files', async () => {
    const channel = subscribeMattermostChannelStrict({ instanceKey: 'primary', channelId: 'channel-a' });
    const { session } = resolveSession(channel.agentGroup.id, channel.messagingGroup.id, null, 'shared');
    const foreignDir = path.join(createAgentMocks.testRoot, 'telegram-foreign-outbox');
    const marker = 'TELEGRAM_FOREIGN_ATTACHMENT_MARKER';
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, 'secret.txt'), marker);
    const outboxRoot = path.join(sessionDir(session.agent_group_id, session.id), 'outbox');
    fs.symlinkSync(foreignDir, path.join(outboxRoot, 'mattermost-self-file'), 'dir');

    await routeAgentMessage(
      {
        id: 'mattermost-self-file',
        platform_id: channel.agentGroup.id,
        content: JSON.stringify({ text: 'private note', files: ['secret.txt'] }),
      },
      session,
    );

    const inboxRoot = path.join(sessionDir(session.agent_group_id, session.id), 'inbox');
    const copiedContent = fs.existsSync(inboxRoot)
      ? fs
          .readdirSync(inboxRoot, { recursive: true, encoding: 'utf8' })
          .map((entry) => path.join(inboxRoot, entry))
          .filter((entry) => fs.lstatSync(entry).isFile())
          .map((entry) => fs.readFileSync(entry, 'utf8'))
          .join('\n')
      : '';
    expect(copiedContent).not.toContain(marker);
  });

  it('copies generic agent-to-agent attachment bytes into the target session inbox', async () => {
    const createdAt = new Date().toISOString();
    for (const group of [
      { id: 'ag-generic-a', name: 'Generic A', folder: 'generic-a' },
      { id: 'ag-generic-b', name: 'Generic B', folder: 'generic-b' },
    ]) {
      createAgentGroup({ ...group, agent_provider: null, created_at: createdAt });
    }
    createMessagingGroup({
      id: 'mg-generic-a',
      channel_type: 'telegram',
      platform_id: 'telegram:-100456',
      name: 'Generic A',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-generic-a',
      messaging_group_id: 'mg-generic-a',
      agent_group_id: 'ag-generic-a',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    getDb()
      .prepare(
        `INSERT INTO agent_destinations (
           agent_group_id, local_name, target_type, target_id, created_at
         ) VALUES ('ag-generic-a', 'generic-b', 'agent', 'ag-generic-b', ?)`,
      )
      .run(createdAt);
    const { session: sourceSession } = resolveSession('ag-generic-a', 'mg-generic-a', null, 'shared');
    const sourceMessageId = 'generic-agent-file-message';
    const sourceOutbox = path.join(sessionDir('ag-generic-a', sourceSession.id), 'outbox', sourceMessageId);
    fs.mkdirSync(sourceOutbox, { recursive: true });
    fs.writeFileSync(path.join(sourceOutbox, 'result.txt'), 'GENERIC_A2A_ATTACHMENT_BYTES');

    await routeAgentMessage(
      {
        id: sourceMessageId,
        platform_id: 'ag-generic-b',
        content: JSON.stringify({ text: 'allowed generic file route', files: ['result.txt'] }),
      },
      sourceSession,
    );

    const [targetSession] = getSessionsByAgentGroup('ag-generic-b');
    const targetDb = openInboundDb(targetSession.agent_group_id, targetSession.id);
    const row = targetDb.prepare("SELECT id, content FROM messages_in WHERE channel_type = 'agent'").get() as {
      id: string;
      content: string;
    };
    targetDb.close();
    const content = JSON.parse(row.content) as {
      attachments: Array<{ filename: string; localPath: string; name: string; type: string }>;
    };
    expect(content.attachments).toEqual([
      {
        filename: 'result.txt',
        localPath: `inbox/${row.id}/result.txt`,
        name: 'result.txt',
        type: 'file',
      },
    ]);
    expect(
      fs.readFileSync(
        path.join(sessionDir(targetSession.agent_group_id, targetSession.id), 'inbox', row.id, 'result.txt'),
      ),
    ).toEqual(Buffer.from('GENERIC_A2A_ATTACHMENT_BYTES'));
    expect(createAgentMocks.wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('preserves generic agent-to-agent routing outside Mattermost', async () => {
    const createdAt = new Date().toISOString();
    for (const group of [
      { id: 'ag-generic-a', name: 'Generic A', folder: 'generic-a' },
      { id: 'ag-generic-b', name: 'Generic B', folder: 'generic-b' },
    ]) {
      createAgentGroup({ ...group, agent_provider: null, created_at: createdAt });
    }
    createMessagingGroup({
      id: 'mg-generic-a',
      channel_type: 'telegram',
      platform_id: 'telegram:-100456',
      name: 'Generic A',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    createMessagingGroupAgent({
      id: 'mga-generic-a',
      messaging_group_id: 'mg-generic-a',
      agent_group_id: 'ag-generic-a',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    getDb()
      .prepare(
        `INSERT INTO agent_destinations (
           agent_group_id, local_name, target_type, target_id, created_at
         ) VALUES ('ag-generic-a', 'generic-b', 'agent', 'ag-generic-b', ?)`,
      )
      .run(createdAt);
    const { session } = resolveSession('ag-generic-a', 'mg-generic-a', null, 'shared');

    await routeAgentMessage(
      {
        id: 'generic-agent-message',
        platform_id: 'ag-generic-b',
        content: JSON.stringify({ text: 'allowed generic route' }),
      },
      session,
    );

    expect(getSessionsByAgentGroup('ag-generic-b')).toHaveLength(1);
    expect(createAgentMocks.wakeContainer).toHaveBeenCalledTimes(1);
  });
});
