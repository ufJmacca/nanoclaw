import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  COMPATIBILITY_AGENT_PROVIDER,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  DEFAULT_GLOBAL_MEMORY_TEMPLATE_FINGERPRINT,
  DEFAULT_MAIN_MEMORY_TEMPLATE_FINGERPRINT,
  seedGroupMemoryFiles,
} from './agent/memory.js';
import { createProviderRegistry } from './agent/provider-registry.js';
import { createSessionStore } from './agent/session-store.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getSession,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { restoreRemoteControl, stopRemoteControl } from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let replyThreadIdByChat: Record<string, string | undefined> = {};
let queuedReplyThreadIdByChat: Record<string, string | null> = {};
let pendingAttachmentIdsByChat: Record<string, Record<string, string>> = {};
let deliveredAttachmentIdsByChat: Record<string, Record<string, string>> = {};
let messageLoopRunning = false;

const ROUTER_STATE_LAST_TIMESTAMP = 'last_timestamp';
const ROUTER_STATE_LAST_AGENT_TIMESTAMP = 'last_agent_timestamp';
const ROUTER_STATE_DELIVERED_ATTACHMENTS = 'delivered_attachment_ids_by_chat';

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function createRuntimeSessionStore() {
  return createSessionStore({
    getSession,
    setSession,
    deleteSession,
  });
}

let sessionStore = createRuntimeSessionStore();
const providerRegistry = createProviderRegistry();

function getGroupProviderId(group: RegisteredGroup): string {
  return group.providerId || COMPATIBILITY_AGENT_PROVIDER;
}

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState(ROUTER_STATE_LAST_TIMESTAMP) || '';
  const agentTs = getRouterState(ROUTER_STATE_LAST_AGENT_TIMESTAMP);
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  const deliveredAttachments = getRouterState(
    ROUTER_STATE_DELIVERED_ATTACHMENTS,
  );
  try {
    deliveredAttachmentIdsByChat = deliveredAttachments
      ? JSON.parse(deliveredAttachments)
      : {};
  } catch {
    logger.warn('Corrupted delivered attachment state in DB, resetting');
    deliveredAttachmentIdsByChat = {};
  }
  pendingAttachmentIdsByChat = {};
  registeredGroups = getAllRegisteredGroups();
  sessionStore = createRuntimeSessionStore();
  for (const group of Object.values(registeredGroups)) {
    const providerId = getGroupProviderId(group);
    sessionStore.hydrate(
      group.folder,
      providerId,
      getSession(group.folder, providerId),
    );
  }
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  for (const chatJid of Object.keys(deliveredAttachmentIdsByChat)) {
    pruneDeliveredAttachments(chatJid);
  }
  setRouterState(ROUTER_STATE_LAST_TIMESTAMP, lastTimestamp);
  setRouterState(
    ROUTER_STATE_LAST_AGENT_TIMESTAMP,
    JSON.stringify(lastAgentTimestamp),
  );
  setRouterState(
    ROUTER_STATE_DELIVERED_ATTACHMENTS,
    JSON.stringify(deliveredAttachmentIdsByChat),
  );
}

function compareMessageIds(aId: string, bId: string): number {
  const aNumericPrefix = /^(\d+)/.exec(aId)?.[1];
  const bNumericPrefix = /^(\d+)/.exec(bId)?.[1];
  if (aNumericPrefix && bNumericPrefix && aNumericPrefix !== bNumericPrefix) {
    return Number(aNumericPrefix) - Number(bNumericPrefix);
  }

  return aId.localeCompare(bId, undefined, { numeric: true });
}

function compareMessageChronology(a: NewMessage, b: NewMessage): number {
  const timestampOrder = a.timestamp.localeCompare(b.timestamp);
  if (timestampOrder !== 0) {
    return timestampOrder;
  }

  return compareMessageIds(a.id, b.id);
}

function getLatestThreadId(messages: NewMessage[]): string | undefined {
  return messages.reduce<NewMessage | undefined>((latest, message) => {
    if (!latest) {
      return message;
    }

    return compareMessageChronology(message, latest) >= 0 ? message : latest;
  }, undefined)?.thread_id;
}

function updateReplyThreadContext(
  chatJid: string,
  messages: NewMessage[],
): string | undefined {
  const threadId = getLatestThreadId(messages);
  if (threadId) {
    replyThreadIdByChat[chatJid] = threadId;
  } else {
    delete replyThreadIdByChat[chatJid];
  }
  return threadId;
}

function shouldWakeGroupForMessages(
  chatJid: string,
  group: RegisteredGroup,
  messages: NewMessage[],
): boolean {
  if (group.isMain === true || group.requiresTrigger === false) {
    return true;
  }

  const triggerPattern = getTriggerPattern(group.trigger);
  const allowlistCfg = loadSenderAllowlist();
  return messages.some(
    (message) =>
      triggerPattern.test(message.content.trim()) &&
      (message.is_from_me ||
        isTriggerAllowed(chatJid, message.sender, allowlistCfg)),
  );
}

function queueReplyThreadContext(
  chatJid: string,
  threadId: string | undefined,
): void {
  queuedReplyThreadIdByChat[chatJid] = threadId ?? null;
}

function consumeQueuedReplyThreadContext(chatJid: string): string | undefined {
  if (
    Object.prototype.hasOwnProperty.call(queuedReplyThreadIdByChat, chatJid)
  ) {
    const threadId = queuedReplyThreadIdByChat[chatJid];
    delete queuedReplyThreadIdByChat[chatJid];
    return threadId ?? undefined;
  }

  return replyThreadIdByChat[chatJid];
}

function clearQueuedReplyThreadContext(chatJid: string): void {
  delete queuedReplyThreadIdByChat[chatJid];
}

function pruneTrackedAttachments(
  chatJid: string,
  trackedAttachmentIdsByChat: Record<string, Record<string, string>>,
): void {
  const tracked = trackedAttachmentIdsByChat[chatJid];
  if (!tracked) {
    return;
  }

  const cursor = lastAgentTimestamp[chatJid] || '';
  for (const [messageId, timestamp] of Object.entries(tracked)) {
    if (timestamp <= cursor) {
      delete tracked[messageId];
    }
  }

  if (Object.keys(tracked).length === 0) {
    delete trackedAttachmentIdsByChat[chatJid];
  }
}

function pruneDeliveredAttachments(chatJid: string): void {
  pruneTrackedAttachments(chatJid, deliveredAttachmentIdsByChat);
}

function rememberPendingAttachment(chatJid: string, msg: NewMessage): void {
  if (!msg.id.endsWith(':attachment')) {
    return;
  }

  pendingAttachmentIdsByChat[chatJid] = {
    ...(pendingAttachmentIdsByChat[chatJid] || {}),
    [msg.id]: msg.timestamp,
  };
}

function clearPendingAttachments(chatJid: string): void {
  delete pendingAttachmentIdsByChat[chatJid];
}

function promotePendingAttachments(chatJid: string): void {
  const pending = pendingAttachmentIdsByChat[chatJid];
  if (!pending) {
    return;
  }

  deliveredAttachmentIdsByChat[chatJid] = {
    ...(deliveredAttachmentIdsByChat[chatJid] || {}),
    ...pending,
  };
  delete pendingAttachmentIdsByChat[chatJid];
  saveState();
}

function filterDeliveredAttachments(
  chatJid: string,
  messages: NewMessage[],
): NewMessage[] {
  pruneTrackedAttachments(chatJid, pendingAttachmentIdsByChat);
  pruneDeliveredAttachments(chatJid);
  const pending = pendingAttachmentIdsByChat[chatJid];
  const delivered = deliveredAttachmentIdsByChat[chatJid];
  if (!pending && !delivered) {
    return messages;
  }

  return messages.filter(
    (message) => !pending?.[message.id] && !delivered?.[message.id],
  );
}

function sendMessageToActiveContainer(
  chatJid: string,
  text: string,
  threadId: string | undefined,
): boolean {
  const wasIdle = queue.isIdleWaiting(chatJid);
  if (!queue.sendMessage(chatJid, text)) {
    return false;
  }

  if (wasIdle) {
    queueReplyThreadContext(chatJid, threadId);
  }

  return true;
}

function rewriteAssistantNameInMemoryFile(filePath: string): void {
  if (ASSISTANT_NAME === 'Andy') {
    return;
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
  content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
  fs.writeFileSync(filePath, content);
}

function ensureGroupMemoryFilesReady(
  groupDir: string,
  group: RegisteredGroup,
  logMessage: string,
): void {
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const seededMemory = seedGroupMemoryFiles({
    targetDir: groupDir,
    templateDir: path.join(GROUPS_DIR, group.isMain ? 'main' : 'global'),
    canonicalTemplateFingerprint: group.isMain
      ? DEFAULT_MAIN_MEMORY_TEMPLATE_FINGERPRINT
      : undefined,
  });

  for (const file of [seededMemory.canonical, seededMemory.compatibility]) {
    if (!file.created) {
      continue;
    }

    rewriteAssistantNameInMemoryFile(file.path);
    logger.info(
      { folder: group.folder, file: file.path, seededFrom: file.seededFrom },
      logMessage,
    );
  }

  if (seededMemory.migration?.status === 'migrated') {
    logger.info(
      {
        folder: group.folder,
        canonicalPath: seededMemory.migration.canonicalPath,
        compatibilityPath: seededMemory.migration.compatibilityPath,
      },
      'Promoted legacy CLAUDE.md into canonical AGENT.md during group recovery',
    );
  }
}

function ensureSharedMemoryTemplatesReady(): void {
  const globalDir = path.join(GROUPS_DIR, 'global');
  const seededMemory = seedGroupMemoryFiles({
    targetDir: globalDir,
    templateDir: globalDir,
    canonicalTemplateFingerprint: DEFAULT_GLOBAL_MEMORY_TEMPLATE_FINGERPRINT,
  });

  for (const file of [seededMemory.canonical, seededMemory.compatibility]) {
    if (!file.created) {
      continue;
    }

    logger.info(
      { file: file.path, seededFrom: file.seededFrom },
      'Created shared memory file during startup preparation',
    );
  }

  if (seededMemory.migration?.status === 'migrated') {
    logger.info(
      {
        canonicalPath: seededMemory.migration.canonicalPath,
        compatibilityPath: seededMemory.migration.compatibilityPath,
      },
      'Promoted legacy global CLAUDE.md into canonical AGENT.md',
    );
  }
}

function restoreRegisteredGroupsOnStartup(
  groups: Record<string, RegisteredGroup>,
): void {
  ensureSharedMemoryTemplatesReady();

  for (const [jid, group] of Object.entries(groups)) {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(group.folder);
    } catch (err) {
      logger.warn(
        { jid, folder: group.folder, err },
        'Skipping startup recovery for group with invalid folder',
      );
      continue;
    }

    ensureGroupMemoryFilesReady(
      groupDir,
      group,
      'Created memory file during startup recovery',
    );
    ensureOneCLIAgent(jid, group);
  }
}

/** @internal - exported for testing */
export function _restoreRegisteredGroupsOnStartupForTest(
  groups: Record<string, RegisteredGroup>,
): void {
  restoreRegisteredGroupsOnStartup(groups);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Seed the provider-neutral AGENT.md first, then render CLAUDE.md as a
  // compatibility file for the current Claude runtime. Never overwrite
  // existing user-authored memory files.
  ensureGroupMemoryFilesReady(
    groupDir,
    group,
    'Created memory file during group registration',
  );

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/** @internal - exported for testing */
export function _registerGroupForTest(
  jid: string,
  group: RegisteredGroup,
): void {
  registerGroup(jid, group);
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = filterDeliveredAttachments(
    chatJid,
    getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    ),
  );

  if (missedMessages.length === 0) return true;

  if (!shouldWakeGroupForMessages(chatJid, group, missedMessages)) {
    return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const replyThreadId = updateReplyThreadContext(chatJid, missedMessages);
  clearQueuedReplyThreadContext(chatJid);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let activeReplyThreadId = replyThreadId;
  let awaitingNextTurnThreadId = false;

  const captureReplyThreadForTurn = () => {
    if (!awaitingNextTurnThreadId) {
      return;
    }

    activeReplyThreadId = consumeQueuedReplyThreadContext(chatJid);
    awaitingNextTurnThreadId = false;
  };

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      captureReplyThreadForTurn();
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        await channel.sendMessage(chatJid, text, activeReplyThreadId);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success' && result.result === null) {
      captureReplyThreadForTurn();
      activeReplyThreadId = undefined;
      awaitingNextTurnThreadId = true;
      promotePendingAttachments(chatJid);
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
      clearPendingAttachments(chatJid);
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    clearQueuedReplyThreadContext(chatJid);
    clearPendingAttachments(chatJid);
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  clearQueuedReplyThreadContext(chatJid);
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const providerId = getGroupProviderId(group);
  const sessionId = sessionStore.get(group.folder, providerId);

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessionStore.set(group.folder, providerId, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessionStore.set(group.folder, providerId, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        sessionStore.delete(group.folder, providerId);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/** @internal - exported for testing */
export function _loadStateForTest(): void {
  loadState();
}

/** @internal - exported for testing */
export async function _runAgentForTest(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
): Promise<'success' | 'error'> {
  return runAgent(group, prompt, chatJid);
}

/** @internal - exported for testing */
export function _getLatestThreadIdForTest(
  messages: NewMessage[],
): string | undefined {
  return getLatestThreadId(messages);
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (!shouldWakeGroupForMessages(chatJid, group, groupMessages)) {
            continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = filterDeliveredAttachments(
            chatJid,
            getMessagesSince(
              chatJid,
              getOrRecoverCursor(chatJid),
              ASSISTANT_NAME,
              MAX_MESSAGES_PER_PROMPT,
            ),
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          updateReplyThreadContext(chatJid, messagesToSend);
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (
            sendMessageToActiveContainer(
              chatJid,
              formatted,
              getLatestThreadId(messagesToSend),
            )
          ) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = filterDeliveredAttachments(
      chatJid,
      getMessagesSince(
        chatJid,
        getOrRecoverCursor(chatJid),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      ),
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRegisteredGroupsOnStartup(registeredGroups);

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const providerId = getGroupProviderId(group);
    const provider = providerRegistry.getProvider(providerId);

    if (command === '/remote-control') {
      if (
        !provider.capabilities.remoteControl ||
        !provider.startRemoteControl
      ) {
        await channel.sendMessage(
          chatJid,
          `${provider.displayName} does not support remote control in NanoClaw v1.`,
          msg.thread_id,
        );
        return;
      }

      const result = await provider.startRemoteControl({
        groupFolder: group.folder,
        projectRoot: process.cwd(),
        env: process.env,
        sender: msg.sender,
        chatJid,
      });
      if (result.status === 'started' && result.url) {
        await channel.sendMessage(chatJid, result.url, msg.thread_id);
      } else if (result.status === 'unsupported') {
        await channel.sendMessage(
          chatJid,
          result.message ||
            `${provider.displayName} does not support remote control in NanoClaw v1.`,
          msg.thread_id,
        );
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.message || 'unknown error'}`,
          msg.thread_id,
        );
      }
    } else {
      const result = stopRemoteControl(chatJid, providerId);
      if (result.ok) {
        await channel.sendMessage(
          chatJid,
          'Remote Control session ended.',
          msg.thread_id,
        );
      } else {
        await channel.sendMessage(chatJid, result.error, msg.thread_id);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }

      if (msg.thread_id) {
        replyThreadIdByChat[chatJid] = msg.thread_id;
      } else {
        delete replyThreadIdByChat[chatJid];
      }

      storeMessage(msg);

      if (msg.id.endsWith(':attachment')) {
        const group = registeredGroups[chatJid];
        if (!group) {
          return;
        }

        if (shouldWakeGroupForMessages(chatJid, group, [msg])) {
          updateReplyThreadContext(chatJid, [msg]);
          const formatted = formatMessages([msg], TIMEZONE);
          if (sendMessageToActiveContainer(chatJid, formatted, msg.thread_id)) {
            rememberPendingAttachment(chatJid, msg);
            return;
          }
        }

        queue.enqueueMessageCheck(chatJid);
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    sessionStore,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText, threadId) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text, threadId);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, threadId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, threadId);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
