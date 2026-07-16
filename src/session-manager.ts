/**
 * Session lifecycle: folders, DBs, messages, container status.
 *
 * Two-DB split — inbound.db (host writes) + outbound.db (container writes).
 * Three cross-mount invariants are load-bearing:
 *   1. journal_mode=DELETE — WAL's mmapped -shm doesn't refresh host→guest;
 *      the container would silently miss every new message.
 *   2. Host opens-writes-CLOSES per op — close invalidates the container's
 *      page cache; a long-lived connection freezes its view at first read.
 *   3. One writer per file — DELETE-mode journal-unlink isn't atomic across
 *      the mount; concurrent writers corrupt the DB.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import fs from 'fs';
import path from 'path';

import { deriveAttachmentName, extForMime } from './attachment-naming.js';
import { isSafeAttachmentName } from './attachment-safety.js';
import type { InboundAttachmentLoadResult, OutboundFile } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import {
  createSession,
  findSessionByAgentGroup,
  findSessionForAgent,
  getSession,
  updateSession,
} from './db/sessions.js';
import {
  ensureSchema,
  openInboundDb as openInboundDbRaw,
  openOutboundDb as openOutboundDbRaw,
  upsertSessionRouting,
  insertMessage,
  migrateMessagesInTable,
} from './db/session-db.js';
import { log } from './log.js';
import type { Session } from './types.js';

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

const DIRECTORY_OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const EXPECTED_UNSAFE_PATH_ERRORS = new Set(['EACCES', 'EEXIST', 'EINVAL', 'ELOOP', 'ENOENT', 'ENOTDIR', 'EPERM']);

interface DirectoryHandle {
  fd: number;
  descriptorRoot: string;
}

interface SessionMessageReplayIdentity {
  kind: string;
  timestamp: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string;
  trigger: number;
}

function mattermostReplayContentWithoutDisplaySender(content: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    ('sender' in record && typeof record.sender !== 'string') ||
    typeof record.senderId !== 'string' ||
    typeof record.text !== 'string'
  ) {
    return null;
  }
  const stable = { ...record };
  delete stable.sender;
  return stable;
}

function isExactSessionMessageReplay(
  existing: SessionMessageReplayIdentity,
  expected: SessionMessageReplayIdentity,
): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (key !== 'content' && existing[key as keyof SessionMessageReplayIdentity] !== value) return false;
  }
  if (existing.content === expected.content) return true;
  if (expected.channel_type !== 'mattermost') return false;
  const existingStableContent = mattermostReplayContentWithoutDisplaySender(existing.content);
  const expectedStableContent = mattermostReplayContentWithoutDisplaySender(expected.content);
  return (
    existingStableContent !== null &&
    expectedStableContent !== null &&
    isDeepStrictEqual(existingStableContent, expectedStableContent)
  );
}

class SecureDescriptorUnavailableError extends Error {
  constructor() {
    super('Secure descriptor-relative filesystem access is unavailable');
  }
}

function isExpectedUnsafePathError(err: unknown): boolean {
  return EXPECTED_UNSAFE_PATH_ERRORS.has((err as NodeJS.ErrnoException).code ?? '');
}

function descriptorPath(handle: DirectoryHandle, child?: string): string {
  return child === undefined
    ? path.join(handle.descriptorRoot, String(handle.fd))
    : path.join(handle.descriptorRoot, String(handle.fd), child);
}

function openDirectoryAt(parent: DirectoryHandle, child: string, create: boolean): DirectoryHandle | undefined {
  if (!isSafeAttachmentName(child)) return undefined;
  const childPath = descriptorPath(parent, child);
  if (create) {
    try {
      fs.mkdirSync(childPath, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (isExpectedUnsafePathError(err)) return undefined;
        throw err;
      }
    }
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(childPath, DIRECTORY_OPEN_FLAGS);
    if (!fs.fstatSync(fd).isDirectory()) {
      fs.closeSync(fd);
      fd = undefined;
      return undefined;
    }
    return { fd, descriptorRoot: parent.descriptorRoot };
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    if (isExpectedUnsafePathError(err)) return undefined;
    throw err;
  }
}

function openFirstOwnedDirectory(baseFd: number, child: string): DirectoryHandle | undefined {
  for (const descriptorRoot of ['/proc/self/fd', '/dev/fd']) {
    const opened = openDirectoryAt({ fd: baseFd, descriptorRoot }, child, false);
    if (opened !== undefined) return opened;
  }

  const lexicalChild = path.join(sessionsBaseDir(), child);
  const stat = fs.lstatSync(lexicalChild, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
  throw new SecureDescriptorUnavailableError();
}

/**
 * Open an owned inbox/outbox through stable directory descriptors.
 *
 * The container can rename writable session directories concurrently with
 * host delivery. Traversing from an already-open parent via /proc/self/fd
 * (or /dev/fd) pins every directory inode, so replacing a lexical pathname
 * after validation cannot redirect the subsequent host read, write, or
 * cleanup into another session.
 */
function openOwnedSessionSubdirectory(
  agentGroupId: string,
  sessionId: string,
  child: 'inbox' | 'outbox',
  create: boolean = false,
): DirectoryHandle | undefined {
  if (!isSafeAttachmentName(agentGroupId) || !isSafeAttachmentName(sessionId)) return undefined;

  const openedFds: number[] = [];
  let result: DirectoryHandle | undefined;
  try {
    const baseFd = fs.openSync(sessionsBaseDir(), DIRECTORY_OPEN_FLAGS);
    openedFds.push(baseFd);
    let current = openFirstOwnedDirectory(baseFd, agentGroupId);
    if (current === undefined) return undefined;
    openedFds.push(current.fd);
    for (const component of [sessionId]) {
      const next = openDirectoryAt(current, component, false);
      if (next === undefined) return undefined;
      openedFds.push(next.fd);
      current = next;
    }
    result = openDirectoryAt(current, child, create);
    if (result !== undefined) openedFds.push(result.fd);
    return result;
  } catch (err) {
    if (err instanceof SecureDescriptorUnavailableError) throw err;
    if (isExpectedUnsafePathError(err)) return undefined;
    throw err;
  } finally {
    for (const fd of openedFds) {
      if (fd !== result?.fd) fs.closeSync(fd);
    }
  }
}

/** Path to the host-owned inbound DB (messages_in + delivered). */
export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'inbound.db');
}

/** Path to the container-owned outbound DB (messages_out + processing_ack). */
export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
}

/** Path to the container heartbeat file (touched instead of DB writes). */
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}

/**
 * @deprecated Use inboundDbPath / outboundDbPath instead.
 * Kept temporarily for test compatibility during migration.
 */
export function sessionDbPath(agentGroupId: string, sessionId: string): string {
  return inboundDbPath(agentGroupId, sessionId);
}

function generateId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Find or create a session for a messaging group + thread.
 *
 * Session modes:
 * - 'shared': one session per messaging group (ignores threadId)
 * - 'per-thread': one session per (messaging group, thread)
 * - 'agent-shared': one session per agent group — all messaging groups
 *   wired with this mode share a single session (e.g. GitHub + Slack)
 */
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): { session: Session; created: boolean } {
  // agent-shared: single session per agent group, regardless of messaging group
  if (sessionMode === 'agent-shared') {
    const existing = findSessionByAgentGroup(agentGroupId);
    if (existing) {
      return { session: existing, created: false };
    }
  } else if (messagingGroupId) {
    const lookupThreadId = sessionMode === 'shared' ? null : threadId;
    // Scope lookup by agent_group_id so fan-out to multiple agents in the
    // same chat doesn't accidentally deliver to the wrong agent's session.
    const existing = findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
    if (existing) {
      return { session: existing, created: false };
    }
  }

  const id = generateId();
  const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: lookupThreadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };

  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Session created', { id, agentGroupId, messagingGroupId, threadId: lookupThreadId, sessionMode });

  return { session, created: true };
}

/** Create the session folder and initialize both DBs. */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });

  ensureSchema(inboundDbPath(agentGroupId, sessionId), 'inbound');
  ensureSchema(outboundDbPath(agentGroupId, sessionId), 'outbound');
}

/**
 * Write the default reply routing for a session into its inbound.db.
 *
 * The container reads this as the default (channel_type, platform_id, thread_id)
 * for outbound messages when the agent doesn't specify an explicit destination.
 * Derived from session.messaging_group_id → messaging_groups row + session.thread_id.
 *
 * Called on every container wake alongside the agent-to-agent module's
 * writeDestinations() (when installed) so the latest routing is always in
 * place, including after admin rewiring.
 */
export function writeSessionRouting(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const session = getSession(sessionId);
  if (!session) return;

  let channelType: string | null = null;
  let platformId: string | null = null;
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg) {
      channelType = mg.channel_type;
      platformId = mg.platform_id;
    }
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    upsertSessionRouting(db, {
      channel_type: channelType,
      platform_id: platformId,
      thread_id: session.thread_id,
    });
  } finally {
    db.close();
  }
  log.debug('Session routing written', { sessionId, channelType, platformId, threadId: session.thread_id });
}

/**
 * Write a message to a session's inbound DB (messages_in). Host-only.
 *
 * ⚠ Opens and closes the DB on every call. Do not refactor to reuse a
 * long-lived connection — see the "Cross-mount visibility invariants" note
 * at the top of this file.
 */
export function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    content: string;
    processAfter?: string | null;
    recurrence?: string | null;
    /**
     * 1 = this message should wake the agent (the default); 0 = accumulate
     * as context only, don't wake. Host's countDueMessages gates on this
     * column; the container still reads all prior messages as context when
     * a trigger-1 message does arrive.
     */
    trigger?: 0 | 1;
    /** Accept an exact stable replay of this deterministic external message ID. */
    idempotent?: boolean;
    /**
     * Authenticated inbound bytes supplied out-of-band from `content`.
     * Each call stages its own copies beneath this session's inbox.
     */
    attachments?: readonly InboundAttachmentLoadResult[];
  },
): boolean {
  const db = openInboundDb(agentGroupId, sessionId);
  try {
    if (message.idempotent) {
      const existing = db
        .prepare(
          `SELECT kind, timestamp, platform_id, channel_type, thread_id, content,
                  process_after, recurrence, series_id, trigger
             FROM messages_in WHERE id = ?`,
        )
        .get(message.id) as SessionMessageReplayIdentity | undefined;
      if (existing) {
        // A completed row proves the first attempt already finished staging.
        // Verify its descriptor-pinned files without creating anything; a
        // contradictory replay must not leave orphan files behind before the
        // identity collision is reported.
        const content = stageDirectInboundAttachments(
          agentGroupId,
          sessionId,
          message.id,
          message.content,
          message.attachments,
          'verify',
        );
        const expected = {
          kind: message.kind,
          timestamp: message.timestamp,
          platform_id: message.platformId ?? null,
          channel_type: message.channelType ?? null,
          thread_id: message.threadId ?? null,
          content,
          process_after: message.processAfter ?? null,
          recurrence: message.recurrence ?? null,
          series_id: message.id,
          trigger: message.trigger ?? 1,
        };
        if (isExactSessionMessageReplay(existing, expected)) {
          return false;
        }
        throw new Error('Mattermost replay message identity collision');
      }
    }
    // Extract base64 attachment data, save to inbox, replace with file paths.
    // Mattermost's authenticated buffers take the direct out-of-band path.
    const base64ExtractedContent = extractAttachmentFiles(agentGroupId, sessionId, message.id, message.content);
    const content = stageDirectInboundAttachments(
      agentGroupId,
      sessionId,
      message.id,
      base64ExtractedContent,
      message.attachments,
      'stage',
    );
    insertMessage(db, {
      id: message.id,
      kind: message.kind,
      timestamp: message.timestamp,
      platformId: message.platformId ?? null,
      channelType: message.channelType ?? null,
      threadId: message.threadId ?? null,
      content,
      processAfter: message.processAfter ?? null,
      recurrence: message.recurrence ?? null,
      trigger: message.trigger ?? 1,
    });
  } finally {
    db.close();
  }

  updateSession(sessionId, { last_active: new Date().toISOString() });
  return true;
}

type PersistedInboundAttachment = {
  type: 'file';
  name: string;
  mimeType?: string;
  size?: number;
  localPath?: string;
  unavailable?: string;
};

function deterministicAttachmentName(
  requestedName: string,
  mimeType: string | undefined,
  index: number,
  usedNames: Set<string>,
): string {
  const extension = extForMime(mimeType);
  const fallback = `attachment-${index + 1}${extension ? `.${extension}` : ''}`;
  // Leave headroom beneath common NAME_MAX=255 limits for deterministic
  // duplicate suffixes. byteLength matters because filenames are UTF-8.
  const initial =
    isSafeAttachmentName(requestedName) && Buffer.byteLength(requestedName, 'utf8') <= 240 ? requestedName : fallback;
  if (!usedNames.has(initial)) {
    usedNames.add(initial);
    return initial;
  }

  const dot = initial.lastIndexOf('.');
  const stem = dot > 0 ? initial.slice(0, dot) : initial;
  const suffix = dot > 0 ? initial.slice(dot) : '';
  let discriminator = index + 1;
  let candidate = `${stem}-${discriminator}${suffix}`;
  while (usedNames.has(candidate)) {
    discriminator++;
    candidate = `${stem}-${discriminator}${suffix}`;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * Stage direct buffers without ever embedding them in persisted message JSON.
 * Unsafe and duplicate display names receive deterministic per-message names,
 * so every fan-out destination gets the same metadata and local path.
 */
function stageDirectInboundAttachments(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  contentStr: string,
  attachments: readonly InboundAttachmentLoadResult[] | undefined,
  mode: 'stage' | 'verify',
): string {
  if (!attachments || attachments.length === 0) return contentStr;

  let parsed: Record<string, unknown>;
  try {
    const candidate: unknown = JSON.parse(contentStr);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return contentStr;
    parsed = candidate as Record<string, unknown>;
  } catch {
    return contentStr;
  }

  const persisted = Array.isArray(parsed.attachments) ? [...(parsed.attachments as unknown[])] : [];
  const usedNames = new Set<string>();
  for (const existing of persisted) {
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) continue;
    const name = (existing as Record<string, unknown>).name;
    if (typeof name === 'string' && isSafeAttachmentName(name)) usedNames.add(name);
  }

  const pendingFiles: Array<{ data: Buffer; metadata: PersistedInboundAttachment }> = [];
  let unavailableCount = 0;
  for (const [index, attachment] of attachments.entries()) {
    const requestedName = typeof attachment.name === 'string' ? attachment.name : '';
    const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType : undefined;
    const declaredSize =
      typeof attachment.size === 'number' && Number.isSafeInteger(attachment.size) && attachment.size >= 0
        ? attachment.size
        : undefined;
    const name = deterministicAttachmentName(requestedName, mimeType, index, usedNames);
    const metadata: PersistedInboundAttachment = { type: 'file', name };
    if (mimeType !== undefined) metadata.mimeType = mimeType;
    if (declaredSize !== undefined) metadata.size = declaredSize;

    if ('unavailable' in attachment && attachment.unavailable) {
      metadata.unavailable = attachment.unavailable;
      persisted.push(metadata);
      unavailableCount++;
      continue;
    }

    if (!Buffer.isBuffer(attachment.data) || declaredSize === undefined) {
      metadata.unavailable = 'metadata mismatch';
      persisted.push(metadata);
      unavailableCount++;
      continue;
    }
    if (attachment.data.length !== declaredSize) {
      metadata.unavailable = 'size mismatch';
      persisted.push(metadata);
      unavailableCount++;
      continue;
    }
    pendingFiles.push({ data: attachment.data, metadata });
    persisted.push(metadata);
  }

  const results = pendingFiles.map(({ data, metadata }, attachmentIndex) => {
    try {
      const operation = mode === 'stage' ? writeInboxFiles : verifyInboxFiles;
      return operation(agentGroupId, sessionId, messageId, [{ filename: metadata.name, data }])[0] ?? false;
    } catch {
      // Filesystem errors often embed the attempted pathname. Keep the
      // user-supplied filename out of host logs and degrade this item without
      // blocking the message or later channel ingress.
      log.warn('Inbound attachment filesystem operation failed', {
        messageId,
        attachmentIndex,
        stage: mode,
        category: 'filesystem_error',
      });
      return false;
    }
  });
  let stagedBytes = 0;
  for (const [index, success] of results.entries()) {
    const pending = pendingFiles[index];
    if (!pending) continue;
    if (success) {
      pending.metadata.localPath = `inbox/${messageId}/${pending.metadata.name}`;
      stagedBytes += pending.data.length;
    } else {
      pending.metadata.unavailable = 'staging failed';
      unavailableCount++;
    }
  }

  parsed.attachments = persisted;
  log.info('Inbound attachments prepared', {
    messageId,
    stage: mode,
    attachmentCount: attachments.length,
    stagedCount: results.filter(Boolean).length,
    unavailableCount,
    byteTotal: stagedBytes,
  });
  return JSON.stringify(parsed);
}

/** Verify exact replay bytes through pinned descriptors without creating files. */
function verifyInboxFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  files: OutboundFile[],
): boolean[] {
  const verified = files.map(() => false);
  if (files.length === 0 || !isSafeAttachmentName(messageId)) return verified;

  const inboxFd = openOwnedSessionSubdirectory(agentGroupId, sessionId, 'inbox');
  if (inboxFd === undefined) return verified;
  let messageHandle: DirectoryHandle | undefined;
  try {
    messageHandle = openDirectoryAt(inboxFd, messageId, false);
    if (messageHandle === undefined) return verified;
    for (const [index, file] of files.entries()) {
      if (!isSafeAttachmentName(file.filename)) continue;
      let fileFd: number | undefined;
      try {
        fileFd = fs.openSync(
          descriptorPath(messageHandle, file.filename),
          fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
        );
        const stat = fs.fstatSync(fileFd);
        if (
          stat.isFile() &&
          stat.nlink === 1 &&
          stat.size === file.data.length &&
          fs.readFileSync(fileFd).equals(file.data)
        ) {
          verified[index] = true;
        }
      } catch (err) {
        if (!isExpectedUnsafePathError(err)) throw err;
      } finally {
        if (fileFd !== undefined) fs.closeSync(fileFd);
      }
    }
    return verified;
  } finally {
    if (messageHandle !== undefined) fs.closeSync(messageHandle.fd);
    fs.closeSync(inboxFd.fd);
  }
}

/**
 * If message content has attachments with base64 `data`, save them to
 * the session's inbox directory and replace with `localPath`.
 *
 * Both `messageId` and `att.name` originate in untrusted input. WhatsApp
 * passes `msg.key.id` through raw (and that field is client generated, so a
 * peer can craft it), and other adapters may follow. The session dir is
 * mounted writable into the container, so a compromised agent can also
 * pre-place a symlink at `inbox/<future msgId>/` and wait for a chat message
 * with a matching id to redirect the host's write.
 *
 * Defenses, mirrored from the outbound side:
 *   1. basename checks on every owned path component.
 *   2. descriptor-relative directory traversal with O_NOFOLLOW.
 *   3. an open message-directory descriptor held through every file write.
 *   4. O_EXCL + O_NOFOLLOW file creation and descriptor-only writes.
 */
export function writeInboxFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  files: OutboundFile[],
): boolean[] {
  const written = files.map(() => false);
  if (files.length === 0) return written;
  if (!isSafeAttachmentName(messageId)) return written;

  const inboxFd = openOwnedSessionSubdirectory(agentGroupId, sessionId, 'inbox', true);
  if (inboxFd === undefined) return written;
  let messageHandle: DirectoryHandle | undefined;
  try {
    messageHandle = openDirectoryAt(inboxFd, messageId, true);
    if (messageHandle === undefined) return written;

    for (const [index, file] of files.entries()) {
      if (!isSafeAttachmentName(file.filename)) continue;
      const filePath = descriptorPath(messageHandle, file.filename);
      let fileFd: number | undefined;
      try {
        fileFd = fs.openSync(
          filePath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
        const stat = fs.fstatSync(fileFd);
        if (!stat.isFile() || stat.nlink !== 1) continue;
        fs.writeFileSync(fileFd, file.data);
        written[index] = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // A crash can occur after the attachment is staged but before the
        // platform receipt is completed. Recovery replays the deterministic
        // message ID; securely reuse the already-pinned file only when its
        // exact bytes match. Symlinks and conflicting files remain failures.
        let existingFd: number | undefined;
        try {
          existingFd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
          const existingStat = fs.fstatSync(existingFd);
          if (
            existingStat.isFile() &&
            existingStat.nlink === 1 &&
            existingStat.size === file.data.length &&
            fs.readFileSync(existingFd).equals(file.data)
          ) {
            written[index] = true;
          }
        } catch (existingErr) {
          if (!isExpectedUnsafePathError(existingErr)) throw existingErr;
        } finally {
          if (existingFd !== undefined) fs.closeSync(existingFd);
        }
      } finally {
        if (fileFd !== undefined) fs.closeSync(fileFd);
      }
    }
  } finally {
    if (messageHandle !== undefined) fs.closeSync(messageHandle.fd);
    fs.closeSync(inboxFd.fd);
  }
  return written;
}

function extractAttachmentFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  contentStr: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments)) return contentStr;

  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe inbound message id', { messageId });
    return contentStr;
  }

  const pending: Array<{ attachment: Record<string, unknown>; file: OutboundFile }> = [];
  for (const [attachmentIndex, att] of attachments.entries()) {
    if (typeof att.data !== 'string') continue;

    const rawName = deriveAttachmentName(att);
    const filename = isSafeAttachmentName(rawName) ? rawName : `attachment-${Date.now()}`;
    if (filename !== rawName) {
      log.warn('Refused unsafe attachment filename, would escape inbox', {
        messageId,
        attachmentIndex,
        category: 'unsafe_name',
      });
    }

    pending.push({
      attachment: att,
      file: { filename, data: Buffer.from(att.data, 'base64') },
    });
  }

  const results = writeInboxFiles(
    agentGroupId,
    sessionId,
    messageId,
    pending.map(({ file }) => file),
  );
  let changed = false;
  for (const [index, success] of results.entries()) {
    const item = pending[index];
    if (!success || !item) continue;
    item.attachment.name = item.file.filename;
    item.attachment.localPath = `inbox/${messageId}/${item.file.filename}`;
    delete item.attachment.data;
    changed = true;
    log.debug('Saved attachment to inbox', { messageId, attachmentIndex: index, size: item.attachment.size });
  }

  return changed ? JSON.stringify(parsed) : contentStr;
}

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  assertSafeSessionDatabaseArtifact(agentGroupId, sessionId, dbPath);
  const db = openInboundDbRaw(dbPath);
  migrateMessagesInTable(db);
  return db;
}

/** Open the outbound DB for a session. Host callers read by default. */
export function openOutboundDb(
  agentGroupId: string,
  sessionId: string,
  opts: { readonly?: boolean } = {},
): Database.Database {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  assertSafeSessionDatabaseArtifact(agentGroupId, sessionId, dbPath);
  return openOutboundDbRaw(dbPath, opts);
}

function assertSafeSessionDatabaseArtifact(agentGroupId: string, sessionId: string, dbPath: string): void {
  const baseDir = path.resolve(sessionsBaseDir());
  const ownedSessionDir = path.resolve(sessionDir(agentGroupId, sessionId));
  const relativeSession = path.relative(baseDir, ownedSessionDir);
  if (
    relativeSession === '' ||
    relativeSession === '..' ||
    relativeSession.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeSession)
  ) {
    throw new Error('Unsafe session database artifact');
  }

  let cursor = baseDir;
  for (const component of relativeSession.split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Unsafe session database artifact');
    }
  }

  const artifactStat = fs.lstatSync(dbPath, { throwIfNoEntry: false });
  if (!artifactStat || artifactStat.isSymbolicLink() || !artifactStat.isFile() || artifactStat.nlink !== 1) {
    throw new Error('Unsafe session database artifact');
  }
  const realSessionDir = fs.realpathSync(ownedSessionDir);
  const realArtifact = fs.realpathSync(dbPath);
  if (!isPathInside(realSessionDir, realArtifact)) {
    throw new Error('Unsafe session database artifact');
  }

  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecarPath = `${dbPath}${suffix}`;
    const sidecarStat = fs.lstatSync(sidecarPath, { throwIfNoEntry: false });
    if (sidecarStat && (sidecarStat.isSymbolicLink() || !sidecarStat.isFile() || sidecarStat.nlink !== 1)) {
      throw new Error('Unsafe session database artifact');
    }
  }
}

/**
 * Write a message directly to a session's outbound DB so the host delivery
 * loop picks it up. Used by the command gate to send denial responses
 * without waking a container.
 */
export function writeOutboundDirect(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  },
): void {
  const db = openOutboundDb(agentGroupId, sessionId, { readonly: false });
  try {
    db.prepare(
      `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), ?, ?, ?, ?, ?)`,
    ).run(message.id, message.kind, message.platformId, message.channelType, message.threadId, message.content);
  } finally {
    db.close();
  }
}

/**
 * @deprecated Use openInboundDb / openOutboundDb instead.
 */
export function openSessionDb(agentGroupId: string, sessionId: string): Database.Database {
  return openInboundDb(agentGroupId, sessionId);
}

/** Write a system response to a session's inbound.db so the container's findQuestionResponse() picks it up. */
export function writeSystemResponse(
  agentGroupId: string,
  sessionId: string,
  requestId: string,
  status: string,
  result: Record<string, unknown>,
): void {
  writeSessionMessage(agentGroupId, sessionId, {
    id: `sys-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      type: 'question_response',
      questionId: requestId,
      status,
      result,
    }),
  });
}

/**
 * Load outbox attachments for a delivered message.
 *
 * Symmetric with `extractAttachmentFiles` on the inbound side: the container
 * writes files into the session's `outbox/<messageId>/` directory alongside
 * its `messages_out` row, and the host reads them back at delivery time.
 *
 * Returns undefined when the outbox dir is missing or no declared file was
 * actually on disk — delivery continues without attachments rather than
 * failing the whole message.
 */
export function readOutboxFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  filenames: string[],
): OutboundFile[] | undefined {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox message id', { messageId });
    return undefined;
  }

  const outboxFd = openOwnedSessionSubdirectory(agentGroupId, sessionId, 'outbox');
  if (outboxFd === undefined) {
    log.warn('Rejecting unsafe outbox root', { messageId });
    return undefined;
  }
  let messageHandle: DirectoryHandle | undefined;
  try {
    messageHandle = openDirectoryAt(outboxFd, messageId, false);
    if (messageHandle === undefined) return undefined;

    const files: OutboundFile[] = [];
    for (const [attachmentIndex, filename] of filenames.entries()) {
      if (!isSafeAttachmentName(filename)) {
        log.warn('Refused unsafe outbox filename, would escape outbox', {
          messageId,
          attachmentIndex,
          category: 'unsafe_name',
        });
        continue;
      }

      let fileFd: number | undefined;
      try {
        fileFd = fs.openSync(
          descriptorPath(messageHandle, filename),
          fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
        );
        const stat = fs.fstatSync(fileFd);
        if (!stat.isFile() || stat.nlink !== 1) {
          log.warn('Rejecting unsafe outbox file', { messageId, attachmentIndex, category: 'unsafe_file' });
          continue;
        }
        files.push({ filename, data: fs.readFileSync(fileFd) });
      } catch {
        log.warn('Outbox file not found', { messageId, attachmentIndex, category: 'unavailable' });
      } finally {
        if (fileFd !== undefined) fs.closeSync(fileFd);
      }
    }
    return files.length > 0 ? files : undefined;
  } finally {
    if (messageHandle !== undefined) fs.closeSync(messageHandle.fd);
    fs.closeSync(outboxFd.fd);
  }
}

/**
 * Remove a message's outbox directory after successful delivery. Best-effort:
 * failures log and swallow. A cleanup failure must NOT propagate to the
 * delivery caller — the message is already on the user's screen, and a
 * thrown error would trigger the delivery retry path and deliver twice.
 */
export function clearOutbox(agentGroupId: string, sessionId: string, messageId: string): void {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox cleanup message id', { messageId });
    return;
  }

  const outboxFd = openOwnedSessionSubdirectory(agentGroupId, sessionId, 'outbox');
  if (outboxFd === undefined) {
    log.warn('Rejecting unsafe outbox cleanup root', { messageId });
    return;
  }
  const quarantineName = `.clear-${process.pid}-${randomUUID()}`;
  const sourcePath = descriptorPath(outboxFd, messageId);
  const quarantinePath = descriptorPath(outboxFd, quarantineName);
  try {
    fs.renameSync(sourcePath, quarantinePath);
    const stat = fs.lstatSync(quarantinePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fs.unlinkSync(quarantinePath);
    else fs.rmSync(quarantinePath, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Outbox cleanup failed (message already delivered)', { messageId, err });
    }
  } finally {
    fs.closeSync(outboxFd.fd);
  }
}

/** Mark a container as running for a session. */
export function markContainerRunning(sessionId: string): void {
  updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
}

/** Mark a container as idle for a session. */
export function markContainerIdle(sessionId: string): void {
  updateSession(sessionId, { container_status: 'idle' });
}

/** Mark a container as stopped for a session. */
export function markContainerStopped(sessionId: string): void {
  updateSession(sessionId, { container_status: 'stopped' });
}
