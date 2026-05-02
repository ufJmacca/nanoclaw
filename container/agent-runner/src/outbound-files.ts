import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations } from './destinations.js';
import { writeMessageOut } from './db/messages-out.js';
import { getSessionRouting } from './db/session-routing.js';

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
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId
        ? session.thread_id
        : null;
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
