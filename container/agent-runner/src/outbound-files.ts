import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations } from './destinations.js';
import { writeMessageOut } from './db/messages-out.js';
import { getSessionRouting } from './db/session-routing.js';
import { getOutboundDb } from './db/connection.js';

const DEFAULT_AGENT_DIR = '/workspace/agent';
const DEFAULT_OUTBOX_DIR = '/workspace/outbox';

export interface ResolvedRouting {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  resolvedName: string;
}

export interface QueueFileMessageInput {
  path: string;
  text?: string;
  filename?: string;
  to?: string;
  inReplyTo?: string | null;
  defaultRouting?: ResolvedRouting;
}

export interface QueuedFileMessage {
  id: string;
  seq: number;
  resolvedName: string;
  filename: string;
}

const ACTIVE_TURN_ROUTING_KEY = 'active_turn_routing';

/**
 * Make the routing of the message currently being answered visible to MCP
 * tools. Shared sessions keep a channel-scoped session route, so their
 * per-message thread/root must come from the active turn instead.
 */
export interface ActiveTurnRoutingBinding {
  update(routing: ResolvedRouting | null): void;
  release(): void;
}

export function bindActiveTurnRouting(routing: ResolvedRouting | null): ActiveTurnRoutingBinding {
  writeActiveTurnRouting(routing);
  let released = false;
  return {
    update(next) {
      if (!released) writeActiveTurnRouting(next);
    },
    release() {
      if (released) return;
      released = true;
      writeActiveTurnRouting(null);
    },
  };
}

function readActiveTurnRouting(): ResolvedRouting | null {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(ACTIVE_TURN_ROUTING_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as Partial<ResolvedRouting>;
    if (
      typeof value.channel_type !== 'string' ||
      typeof value.platform_id !== 'string' ||
      (typeof value.thread_id !== 'string' && value.thread_id !== null) ||
      typeof value.resolvedName !== 'string'
    ) {
      return null;
    }
    return value as ResolvedRouting;
  } catch {
    return null;
  }
}

function writeActiveTurnRouting(routing: ResolvedRouting | null): void {
  const db = getOutboundDb();
  if (!routing) {
    db.prepare('DELETE FROM session_state WHERE key = ?').run(ACTIVE_TURN_ROUTING_KEY);
    return;
  }
  db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
    ACTIVE_TURN_ROUTING_KEY,
    JSON.stringify(routing),
    new Date().toISOString(),
  );
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * If `to` is omitted, use the session's default reply routing. If the
 * session has no default route, fall back to the legacy single-destination
 * shortcut.
 */
export function resolveRouting(to: string | undefined): ResolvedRouting | { error: string } {
  if (!to) {
    const activeTurnRouting = readActiveTurnRouting();
    if (activeTurnRouting) return activeTurnRouting;

    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }

    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations - specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }

  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };

  if (dest.type === 'channel') {
    const session = getSessionRouting();
    const activeTurnRouting = readActiveTurnRouting();
    const current = activeTurnRouting ?? {
      channel_type: session.channel_type,
      platform_id: session.platform_id,
      thread_id: session.thread_id,
    };
    const threadId =
      current.channel_type === dest.channelType && current.platform_id === dest.platformId ? current.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }

  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export function isSafeOutboundFilename(filename: string): boolean {
  return (
    filename.length > 0 &&
    filename === path.basename(filename) &&
    filename !== '.' &&
    filename !== '..' &&
    !/[\\/\0]/.test(filename)
  );
}

export function resolveAgentFilePath(filePath: string): string {
  const agentDir = process.env.NANOCLAW_AGENT_DIR || DEFAULT_AGENT_DIR;
  return path.isAbsolute(filePath) ? filePath : path.resolve(agentDir, filePath);
}

export function queueFileMessage(input: QueueFileMessageInput): QueuedFileMessage | { error: string } {
  if (!input.path) return { error: 'path is required' };

  const routing = input.to || !input.defaultRouting ? resolveRouting(input.to) : input.defaultRouting;
  if ('error' in routing) return routing;

  const resolvedPath = resolveAgentFilePath(input.path);
  if (!fs.existsSync(resolvedPath)) return { error: `File not found: ${input.path}` };

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) return { error: `Path is not a file: ${input.path}` };

  const filename = input.filename || path.basename(resolvedPath);
  if (!isSafeOutboundFilename(filename)) {
    return { error: `Invalid filename "${filename}". Use a plain basename without path separators.` };
  }

  const id = generateId();
  const outboxRoot = process.env.NANOCLAW_OUTBOX_DIR || DEFAULT_OUTBOX_DIR;
  const outboxDir = path.join(outboxRoot, id);
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

  const seq = writeMessageOut({
    id,
    in_reply_to: input.inReplyTo ?? null,
    kind: 'chat',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id,
    content: JSON.stringify({ text: input.text || '', files: [filename] }),
  });

  return { id, seq, resolvedName: routing.resolvedName, filename };
}
