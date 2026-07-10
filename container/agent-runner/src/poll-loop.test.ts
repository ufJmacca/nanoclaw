import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { dispatchResultText, processQuery, selectNextRoutingTurn } from './poll-loop.js';
import { sendMessage } from './mcp-tools/core.js';
import { sendCard } from './mcp-tools/interactive.js';
import { scheduleTask } from './mcp-tools/scheduling.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  delete process.env.NANOCLAW_AGENT_DIR;
  delete process.env.NANOCLAW_OUTBOX_DIR;
  closeSessionDb();
});

function insertMessage(id: string, kind: string, content: object, opts?: { processAfter?: string; trigger?: 0 | 1 }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as XML block', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<messages>');
    expect(prompt).toContain('</messages>');
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[SCHEDULED TASK]');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[WEBHOOK: github/push]');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[SYSTEM RESPONSE]');
    expect(prompt).toContain('register_group');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('[SYSTEM RESPONSE]');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });

  it('uses the newest wake-triggering message instead of accumulated context for reply routing', () => {
    const insert = getInboundDb().prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', ?, ?, 'mattermost', ?, '{"text":"hi"}')`,
    );
    insert.run('accumulated-root-a', 2, 0, 'mattermost:primary:channel-a', 'root-a');
    insert.run('trigger-root-b', 4, 1, 'mattermost:primary:channel-a', 'root-b');

    const routing = extractRouting(getPendingMessages());

    expect(routing.threadId).toBe('root-b');
    expect(routing.inReplyTo).toBe('trigger-root-b');
  });

  it('separates two same-poll Mattermost roots into ordered turns', () => {
    const insert = getInboundDb().prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', ?, 'mattermost:primary:channel-a',
               'mattermost', ?, '{"text":"hi"}')`,
    );
    insert.run('accumulated-context', 2, 0, 'older-root');
    insert.run('root-a-message', 4, 1, 'root-a');
    insert.run('root-b-message', 6, 1, 'root-b');

    const pending = getPendingMessages();
    const firstTurn = selectNextRoutingTurn(pending);
    const secondTurn = selectNextRoutingTurn(pending.slice(firstTurn.length));

    expect(firstTurn.map((message) => message.id)).toEqual(['accumulated-context', 'root-a-message']);
    expect(extractRouting(firstTurn).threadId).toBe('root-a');
    expect(secondTurn.map((message) => message.id)).toEqual(['root-b-message']);
    expect(extractRouting(secondTurn).threadId).toBe('root-b');
  });

  it('keeps the active Mattermost root on a mid-turn send_message', async () => {
    let toolResult: Awaited<ReturnType<typeof sendMessage.handler>> | undefined;
    const query: AgentQuery = {
      push() {
        /* unused */
      },
      end() {
        /* unused */
      },
      abort() {
        /* unused */
      },
      events: {
        async *[Symbol.asyncIterator]() {
          toolResult = await sendMessage.handler({ text: 'Still working.' });
          yield { type: 'result' as const, text: null };
        },
      },
    };

    await processQuery(
      query,
      {
        platformId: 'mattermost:primary:channel-a',
        channelType: 'mattermost',
        threadId: 'root-post-id',
        inReplyTo: 'inbound-reply',
      },
      ['inbound-reply'],
      'mock',
    );

    expect(toolResult?.isError).not.toBe(true);
    const [outbound] = getUndeliveredMessages();
    expect(outbound?.channel_type).toBe('mattermost');
    expect(outbound?.platform_id).toBe('mattermost:primary:channel-a');
    expect(outbound?.thread_id).toBe('root-post-id');
  });

  it('publishes active Mattermost routing for the separate MCP process', async () => {
    let observed: Record<string, unknown> | null = null;
    const query: AgentQuery = {
      push() {
        /* unused */
      },
      end() {
        /* unused */
      },
      abort() {
        /* unused */
      },
      events: {
        async *[Symbol.asyncIterator]() {
          const database = getOutboundDb()
            .query('PRAGMA database_list')
            .all()
            .find((row) => (row as { name: string }).name === 'main') as { file: string };
          const child = spawnSync(
            process.execPath,
            [
              '-e',
              `import { Database } from 'bun:sqlite';
               const db = new Database(process.argv[1], { readonly: true });
               const row = db.query("SELECT value FROM session_state WHERE key = 'active_turn_routing'").get();
               console.log(row?.value ?? 'null');`,
              database.file,
            ],
            { encoding: 'utf8' },
          );
          expect(child.status).toBe(0);
          observed = JSON.parse(child.stdout.trim());
          yield { type: 'result' as const, text: null };
        },
      },
    };

    await processQuery(
      query,
      {
        platformId: 'mattermost:primary:channel-a',
        channelType: 'mattermost',
        threadId: 'root-post-id',
        inReplyTo: 'inbound-reply',
      },
      ['inbound-reply'],
      'mock',
    );

    expect(observed).toEqual({
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:channel-a',
      thread_id: 'root-post-id',
      resolvedName: '(current conversation)',
    });
  });

  it('keeps the active Mattermost root on a mid-turn send_card', async () => {
    const query: AgentQuery = {
      push() {
        /* unused */
      },
      end() {
        /* unused */
      },
      abort() {
        /* unused */
      },
      events: {
        async *[Symbol.asyncIterator]() {
          await sendCard.handler({ card: { title: 'Status' }, fallbackText: 'Status' });
          yield { type: 'result' as const, text: null };
        },
      },
    };

    await processQuery(
      query,
      {
        platformId: 'mattermost:primary:channel-a',
        channelType: 'mattermost',
        threadId: 'root-post-id',
        inReplyTo: 'inbound-reply',
      },
      ['inbound-reply'],
      'mock',
    );

    const [outbound] = getUndeliveredMessages();
    expect(outbound?.channel_type).toBe('mattermost');
    expect(outbound?.platform_id).toBe('mattermost:primary:channel-a');
    expect(outbound?.thread_id).toBe('root-post-id');
  });

  it('keeps the active Mattermost root on a task scheduled mid-turn', async () => {
    const query: AgentQuery = {
      push() {
        /* unused */
      },
      end() {
        /* unused */
      },
      abort() {
        /* unused */
      },
      events: {
        async *[Symbol.asyncIterator]() {
          await scheduleTask.handler({ prompt: 'Follow up', processAfter: '2030-01-01T09:00:00Z' });
          yield { type: 'result' as const, text: null };
        },
      },
    };

    await processQuery(
      query,
      {
        platformId: 'mattermost:primary:channel-a',
        channelType: 'mattermost',
        threadId: 'root-post-id',
        inReplyTo: 'inbound-reply',
      },
      ['inbound-reply'],
      'mock',
    );

    const [outbound] = getUndeliveredMessages();
    expect(outbound?.kind).toBe('system');
    expect(outbound?.channel_type).toBe('mattermost');
    expect(outbound?.platform_id).toBe('mattermost:primary:channel-a');
    expect(outbound?.thread_id).toBe('root-post-id');
  });

  it('does not retain a completed turn as the default send_message route', async () => {
    await processQuery(
      fakeQuery([{ type: 'result', text: null }]),
      {
        platformId: 'mattermost:primary:channel-a',
        channelType: 'mattermost',
        threadId: 'root-post-id',
        inReplyTo: 'inbound-reply',
      },
      ['inbound-reply'],
      'mock',
    );

    const result = await sendMessage.handler({ text: 'Too late.' });

    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('advances reply and MCP routing when a second Mattermost root joins the shared query', async () => {
    let releasePush!: () => void;
    const pushed = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    const query: AgentQuery = {
      push() {
        releasePush();
      },
      end() {
        /* unused */
      },
      abort() {
        /* unused */
      },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result' as const, text: 'Reply to A' };
          await pushed;
          await sendMessage.handler({ text: 'Working on B' });
          yield { type: 'result' as const, text: 'Reply to B' };
        },
      },
    };

    getInboundDb()
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES ('root-b-message', 2, 'chat', datetime('now'), 'pending', 1,
                 'mattermost:primary:channel-a', 'mattermost', 'root-b', '{"text":"second root"}')`,
      )
      .run();

    await processQuery(
      query,
      {
        platformId: 'mattermost:primary:channel-a',
        channelType: 'mattermost',
        threadId: 'root-a',
        inReplyTo: 'root-a-message',
      },
      ['root-a-message'],
      'mock',
    );

    const outbound = outboundBySeq();
    expect(outbound.map((message) => JSON.parse(message.content).text)).toEqual([
      'Reply to A',
      'Working on B',
      'Reply to B',
    ]);
    expect(outbound.map((message) => message.thread_id)).toEqual(['root-a', 'root-b', 'root-b']);
  });

  it('does not copy a Mattermost root onto a different destination channel', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
         VALUES ('channel-b', 'Channel B', 'channel', 'mattermost', 'mattermost:primary:channel-b')`,
      )
      .run();

    dispatchResultText('<message to="channel-b">Cross-channel update</message>', {
      platformId: 'mattermost:primary:channel-a',
      channelType: 'mattermost',
      threadId: 'root-a',
      inReplyTo: 'root-a-message',
    });

    const [outbound] = getUndeliveredMessages();
    expect(outbound.platform_id).toBe('mattermost:primary:channel-b');
    expect(outbound.thread_id).toBeNull();
  });
});

describe('final-response file directives', () => {
  it('queues a file attachment for delivery through the current channel', () => {
    const tempDir = fs.mkdtempSync('/tmp/nanoclaw-file-directive-');
    const sourcePath = path.join(tempDir, 'chart.png');
    const outboxDir = path.join(tempDir, 'outbox');
    fs.writeFileSync(sourcePath, 'fake-png');
    process.env.NANOCLAW_OUTBOX_DIR = outboxDir;

    dispatchResultText('<file path="' + sourcePath + '" text="Here is the chart." filename="report.png" />', {
      platformId: 'telegram:123',
      channelType: 'telegram',
      threadId: null,
      inReplyTo: 'inbound-1',
    });

    const [outbound] = getUndeliveredMessages();
    expect(outbound.platform_id).toBe('telegram:123');
    expect(outbound.channel_type).toBe('telegram');
    expect(outbound.in_reply_to).toBe('inbound-1');

    const content = JSON.parse(outbound.content);
    expect(content.text).toBe('Here is the chart.');
    expect(content.files).toEqual(['report.png']);
    expect(fs.existsSync(path.join(outboxDir, outbound.id, 'report.png'))).toBe(true);
  });
});

describe('provider progress delivery', () => {
  it('writes progress events to the originating Telegram channel before the final response', async () => {
    const query = fakeQuery([
      { type: 'progress', message: 'Reading the repository and checking tests.' },
      { type: 'result', text: 'Done.' },
    ]);

    await processQuery(
      query,
      { platformId: 'telegram:123', channelType: 'telegram', threadId: null, inReplyTo: 'inbound-1' },
      ['inbound-1'],
      'mock',
    );

    const out = outboundBySeq();
    expect(out).toHaveLength(2);
    expect(out.map((msg) => JSON.parse(msg.content).text)).toEqual([
      'Reading the repository and checking tests.',
      'Done.',
    ]);
    expect(out.map((msg) => msg.channel_type)).toEqual(['telegram', 'telegram']);
    expect(out.map((msg) => msg.platform_id)).toEqual(['telegram:123', 'telegram:123']);
  });

  it('does not send a final response that only repeats already delivered progress', async () => {
    const query = fakeQuery([
      { type: 'progress', message: 'Reading the repository and checking tests.' },
      { type: 'result', text: 'Reading the repository and checking tests.' },
    ]);

    await processQuery(
      query,
      { platformId: 'telegram:123', channelType: 'telegram', threadId: null, inReplyTo: 'inbound-1' },
      ['inbound-1'],
      'mock',
    );

    const out = outboundBySeq();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!.content).text).toBe('Reading the repository and checking tests.');
  });

  it('keeps progress events off non-Telegram channels', async () => {
    const query = fakeQuery([
      { type: 'progress', message: 'Checking the implementation.' },
      { type: 'result', text: 'Done.' },
    ]);

    await processQuery(
      query,
      { platformId: 'discord:123', channelType: 'discord', threadId: 'thread-1', inReplyTo: 'inbound-1' },
      ['inbound-1'],
      'mock',
    );

    const out = outboundBySeq();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!.content).text).toBe('Done.');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

function fakeQuery(events: ProviderEvent[]): AgentQuery {
  return {
    push() {
      /* unused */
    },
    end() {
      /* unused */
    },
    abort() {
      /* unused */
    },
    events: {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    },
  };
}

function outboundBySeq() {
  return getUndeliveredMessages().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});
