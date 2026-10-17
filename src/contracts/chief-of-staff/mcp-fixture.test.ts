import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: calls.spawn,
}));
vi.mock('../../host-environment.js', () => ({ safeHostEnvironment: () => ({}) }));
import { McpFixture } from './mcp-fixture.js';

const image = 'sha256:' + 'a'.repeat(64);
let worker: ReturnType<typeof child>, fixture: McpFixture | undefined;
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}
function open(startupTimeoutMs = 90000) {
  fixture = new McpFixture(
    '/fixture',
    '/fixture/session',
    '/fixture',
    image,
    '',
    {
      containerName: 'fixture-startup',
      args: ['run', 'synthetic-worker'],
    },
    { startupTimeoutMs },
  );
  return fixture;
}
function observe<T>(promise: Promise<T>) {
  let state = 'pending';
  const settled = promise.then(
    (value) => {
      state = 'resolved';
      return { value, error: undefined };
    },
    (error) => {
      state = 'rejected';
      return { value: undefined, error };
    },
  );
  return { state: () => state, settled };
}
beforeEach(() => {
  vi.useFakeTimers();
  worker = child();
  calls.spawn.mockReset().mockImplementation((_command, args) => {
    if (args[0] !== 'rm') return worker;
    const stopped = child();
    queueMicrotask(() => stopped.emit('exit', 0));
    return stopped;
  });
});
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  vi.useRealTimers();
});

it('permits a slow cold container handshake without extending ordinary RPC deadlines', async () => {
  const client = open(),
    startup = observe(client.start());
  await vi.advanceTimersByTimeAsync(60000);
  expect(startup.state()).toBe('pending');
  worker.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
  await startup.settled;
  expect(startup.state()).toBe('resolved');
  const request = observe(client.request('tools/list', {}));
  await vi.advanceTimersByTimeAsync(24999);
  expect(request.state()).toBe('pending');
  await vi.advanceTimersByTimeAsync(1);
  expect(request.state()).toBe('rejected');
  expect((await request.settled).error).toMatchObject({ code: 'fixture_mcp_request_deadline' });
});

it('still fails a missing initialization reply at the bounded startup deadline', async () => {
  const startup = observe(open().start());
  await vi.advanceTimersByTimeAsync(89999);
  expect(startup.state()).toBe('pending');
  await vi.advanceTimersByTimeAsync(1);
  expect(startup.state()).toBe('rejected');
  expect((await startup.settled).error).toMatchObject({ code: 'fixture_mcp_startup_deadline' });
});

it('classifies a dead worker separately from a startup deadline', async () => {
  const startup = observe(open().start());
  worker.stderr.write('synthetic-private-diagnostic');
  worker.emit('exit', 1);
  expect((await startup.settled).error).toMatchObject({ code: 'fixture_mcp_transport_unavailable' });
});

it('rejects invalid or unbounded startup budgets before spawning a worker', () => {
  for (const value of [0, -1, NaN, Infinity, 120001]) {
    expect(() => open(value)).toThrow('invalid_fixture_startup_timeout');
  }
  expect(calls.spawn).not.toHaveBeenCalled();
});
