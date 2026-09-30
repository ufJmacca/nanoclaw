import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { runOneTurn } from './codex.js';
import type { AppServer, JsonRpcNotification } from './codex-app-server.js';
async function drive(notifications: JsonRpcNotification[], cancelled = () => false) {
  const process = new EventEmitter() as any;
  const writes: any[] = [];
  let renewed = 0;
  let server: AppServer;
  process.stdin = {
    write(line: string) {
      const request = JSON.parse(line);
      writes.push(request);
      queueMicrotask(() => {
        server.pending.get(request.id)?.resolve({ id: request.id, result: {} });
        server.pending.delete(request.id);
        for (const notification of notifications)
          for (const handler of server.notificationHandlers) handler(notification);
      });
      return true;
    },
  };
  server = {
    process,
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
    readline: { close() {} },
  } as unknown as AppServer;
  const events = [];
  for await (const event of runOneTurn(
    server,
    'thread-1',
    'fixture prompt',
    'model',
    undefined,
    '/workspace/agent',
    (id) => id,
    () => false,
    () => {},
    async () => {
      renewed++;
    },
    cancelled,
  ))
    events.push(event);
  return { events, writes, renewed };
}
test('a native unauthorized turn renews once, reports failure, and is never replayed automatically', async () => {
  const { events, writes, renewed } = await drive([
    {
      method: 'turn/completed',
      params: {
        turn: { status: 'failed', error: { message: 'private-error-canary', codexErrorInfo: 'unauthorized' } },
      },
    },
  ]);
  expect(renewed).toBe(1);
  expect(writes.map((x) => x.method)).toEqual(['turn/start']);
  expect(events.some((x) => x.type === 'error')).toBe(true);
  expect(events.some((x) => x.type === 'result')).toBe(true);
  expect(JSON.stringify(events)).not.toContain('private-error-canary');
});
test('cancellation before dispatch prevents the model request and all output', async () => {
  const result = await drive([{ method: 'turn/completed', params: { turn: { status: 'completed' } } }], () => true);
  expect(result.writes).toEqual([]);
  expect(result.events).toEqual([]);
  expect(result.renewed).toBe(0);
});
test('a terminal authentication notification survives a completion without repeated error details', async () => {
  const result = await drive([
    {
      method: 'error',
      params: {
        threadId: 'thread-1',
        willRetry: false,
        error: { message: 'private-error-canary', codexErrorInfo: 'unauthorized' },
      },
    },
    { method: 'turn/completed', params: { turn: { status: 'failed' } } },
  ]);
  expect(result.renewed).toBe(1);
  expect(result.writes).toHaveLength(1);
  expect(JSON.stringify(result.events)).not.toContain('private-error-canary');
});
test('quota failures do not trigger credential rotation', async () => {
  const result = await drive([
    {
      method: 'turn/completed',
      params: { turn: { status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } },
    },
  ]);
  expect(result.renewed).toBe(0);
  expect(result.writes).toHaveLength(1);
});
