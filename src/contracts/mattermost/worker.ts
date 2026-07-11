import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import type { ChannelAdapter, ChannelSetup } from '../../channels/adapter.js';
import {
  getChannelAdapter,
  initChannelAdapters,
  registerChannelAdapter,
  requireChannelAdapterInstances,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { createMattermostAdapter } from '../../channels/mattermost-adapter.js';
import { NodeMattermostTransport } from '../../channels/mattermost-client.js';
import {
  deactivateMattermostChannelStrict,
  handleMattermostBotRemoved,
  subscribeMattermostChannelStrict,
} from '../../channels/mattermost-subscription.js';
import { closeDb, getDb, initDb, runMigrations } from '../../db/index.js';
import { updateMessagingGroupMetadataByPlatform } from '../../db/messaging-groups.js';
import { routeInbound } from '../../router.js';
import { inboundDbPath } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { parseMattermostContractWorkerConfig } from './worker-config.js';
import {
  encodeMattermostContractWorkerEvent,
  parseMattermostContractWorkerCommand,
  type MattermostContractWorkerCommand,
} from './worker-protocol.js';

interface ContractSubscriptionRow {
  channel_id: string;
  status: string;
  messaging_group_id: string;
  agent_group_id: string;
  wiring_id: string;
  folder: string;
}

interface ContractChannelSnapshot extends ContractSubscriptionRow {
  session: (Pick<Session, 'id' | 'thread_id' | 'status' | 'container_status'> & { inboxCount: number }) | null;
}

function countInboundMessages(agentGroupId: string, sessionId: string): number {
  const databasePath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(databasePath)) return 0;
  const database = new Database(databasePath, { readonly: true });
  try {
    return (database.prepare('SELECT COUNT(*) AS count FROM messages_in').get() as { count: number }).count;
  } finally {
    database.close();
  }
}

function snapshotChannels(channelIds: readonly string[]): ContractChannelSnapshot[] {
  return channelIds.map((channelId) => {
    const subscription = getDb()
      .prepare(
        `SELECT ms.channel_id, ms.status, ms.messaging_group_id, ms.agent_group_id,
                ms.wiring_id, ag.folder
           FROM mattermost_subscriptions ms
           JOIN agent_groups ag ON ag.id = ms.agent_group_id
          WHERE ms.instance_key = 'contract' AND ms.channel_id = ?`,
      )
      .get(channelId) as ContractSubscriptionRow | undefined;
    if (!subscription) throw new Error('Mattermost contract subscription disappeared');
    const sessions = getDb()
      .prepare(
        `SELECT id, thread_id, status, container_status
           FROM sessions
          WHERE agent_group_id = ? OR messaging_group_id = ?
          ORDER BY id`,
      )
      .all(subscription.agent_group_id, subscription.messaging_group_id) as Array<
      Pick<Session, 'id' | 'thread_id' | 'status' | 'container_status'>
    >;
    if (sessions.length > 1) throw new Error('Mattermost contract found ambiguous channel sessions');
    const session = sessions[0];
    return {
      ...subscription,
      session: session
        ? { ...session, inboxCount: countInboundMessages(subscription.agent_group_id, session.id) }
        : null,
    };
  });
}

function safeErrorMessage(error: unknown, botToken: string): string {
  const message = error instanceof Error ? error.message : 'Unknown contract worker failure';
  if (message.includes(botToken)) return 'Mattermost contract worker command failed';
  return message.slice(0, 512);
}

export async function runMattermostContractWorker(): Promise<void> {
  const serializedConfig = process.env.NANOCLAW_MM_CONTRACT_WORKER_CONFIG;
  if (!serializedConfig) throw new Error('Mattermost contract worker configuration was invalid');
  const config = parseMattermostContractWorkerConfig(serializedConfig, process.cwd());

  runMigrations(initDb(config.databasePath));
  if (config.bootstrapSubscriptions) {
    for (const channel of config.channels) {
      subscribeMattermostChannelStrict({
        instanceKey: config.instanceKey,
        channelId: channel.channelId,
        channelName: channel.name,
        recoveryBaseline: channel.baseline,
      });
    }
  }

  registerChannelAdapter('mattermost', {
    factory: () =>
      createMattermostAdapter(
        {
          baseUrl: config.baseUrl,
          botToken: config.botToken,
          instanceKey: config.instanceKey,
          allowMassMentions: false,
        },
        new NodeMattermostTransport(),
      ),
  });
  const requiredInstances = new Set([config.instanceKey]);
  const emit = (event: unknown): void => {
    process.stdout.write(`${encodeMattermostContractWorkerEvent(event, [config.botToken])}\n`);
  };
  const setup = (adapter: ChannelAdapter): ChannelSetup => ({
    async onInbound(platformId, threadId, message) {
      await routeInbound({
        channelType: adapter.channelType,
        platformId,
        threadId,
        message: {
          id: message.id,
          kind: message.kind,
          content: JSON.stringify(message.content),
          timestamp: message.timestamp,
          isMention: message.isMention,
          isGroup: message.isGroup,
        },
      });
      emit({ kind: 'inbound', postId: message.id, platformId, threadId });
    },
    onInboundEvent: routeInbound,
    onMetadata(platformId, name, isGroup) {
      if (name !== undefined && isGroup !== undefined) {
        updateMessagingGroupMetadataByPlatform(adapter.channelType, platformId, name, isGroup);
      }
    },
    onAction() {},
    async onLifecycle(event) {
      if (event.kind !== 'bot_removed') return;
      await handleMattermostBotRemoved(event.platformId);
      emit({ kind: 'lifecycle', lifecycle: event.kind, platformId: event.platformId });
    },
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await teardownChannelAdapters();
    } finally {
      closeDb();
    }
  };
  const onTermination = (): void => {
    void shutdown().finally(() => process.exit(0));
  };
  process.once('SIGINT', onTermination);
  process.once('SIGTERM', onTermination);

  try {
    await initChannelAdapters(setup, {
      strictChannels: ['mattermost'],
      requiredChannels: ['mattermost'],
      requiredInstances: { mattermost: [...requiredInstances] },
    });
    requireChannelAdapterInstances('mattermost', requiredInstances);
    emit({
      kind: 'ready',
      instanceKey: config.instanceKey,
      pid: process.pid,
      channels: snapshotChannels(config.channels.map((channel) => channel.channelId)),
    });

    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      let command: MattermostContractWorkerCommand;
      try {
        command = parseMattermostContractWorkerCommand(line, config.instanceKey);
      } catch (error) {
        emit({ kind: 'command_error', message: safeErrorMessage(error, config.botToken) });
        continue;
      }
      try {
        if (command.kind === 'deliver') {
          const adapter = getChannelAdapter('mattermost');
          if (!adapter) throw new Error('Mattermost contract adapter was unavailable');
          const postId = await adapter.deliver(command.platformId, command.threadId, {
            kind: 'chat',
            content: { text: command.text },
            deliveryId: command.id,
          });
          if (!postId) throw new Error('Mattermost contract delivery returned no post identity');
          emit({ kind: 'command_result', commandId: command.id, result: { postId } });
          continue;
        }
        if (command.kind === 'snapshot') {
          emit({
            kind: 'command_result',
            commandId: command.id,
            result: { channels: snapshotChannels(config.channels.map((channel) => channel.channelId)) },
          });
          continue;
        }
        if (command.kind === 'deactivate') {
          const result = await deactivateMattermostChannelStrict({
            instanceKey: config.instanceKey,
            channelId: command.channelId,
            workspacePolicy: 'retain',
          });
          emit({ kind: 'command_result', commandId: command.id, result });
          continue;
        }
        emit({ kind: 'command_result', commandId: command.id, result: { stopped: true } });
        break;
      } catch (error) {
        emit({
          kind: 'command_error',
          commandId: command.id,
          message: safeErrorMessage(error, config.botToken),
        });
      }
    }
  } finally {
    process.removeListener('SIGINT', onTermination);
    process.removeListener('SIGTERM', onTermination);
    await shutdown();
  }
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runMattermostContractWorker().catch((error) => {
    const serializedConfig = process.env.NANOCLAW_MM_CONTRACT_WORKER_CONFIG;
    let botToken = '';
    if (serializedConfig) {
      try {
        const parsed = JSON.parse(serializedConfig) as { botToken?: unknown };
        if (typeof parsed.botToken === 'string') botToken = parsed.botToken;
      } catch (parseError) {
        if (!(parseError instanceof SyntaxError)) throw parseError;
      }
    }
    const message = safeErrorMessage(error, botToken);
    process.stderr.write(`Mattermost contract worker failed: ${message}\n`);
    process.exitCode = 1;
  });
}
