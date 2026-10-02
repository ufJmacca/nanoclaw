import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { CosCodexProvider } from './codex-cos.js';
import type { AppServer, JsonRpcNotification } from './codex-app-server.js';
import type { ProviderEvent } from './types.js';

function fixture(options: { stale?: boolean; unauthorized?: boolean; forged?: boolean; profile?: 'research' } = {}) {
  const writes: any[] = [],
    spawns: any[] = [];
  let refreshed = 0,
    stopped = 0,
    prepare = 0;
  const provider = new CosCodexProvider(
    { model: 'gpt-6-astra', proxyUrl: 'http://127.0.0.1:1234', profile: options.profile },
    {
      credentials: () => ({
        prepare: async () => {
          prepare++;
          return true;
        },
        refresh: async () => {
          refreshed++;
          return true;
        },
      }),
      writeConfig: () => {},
      attempts: () => ({ begin: async () => {}, end: async () => {} }),
      stop: async () => {
        stopped++;
      },
      spawn(overrides, spawnOptions) {
        spawns.push({ overrides, ...spawnOptions });
        const process = new EventEmitter() as any;
        const server: AppServer = {
          process,
          pending: new Map(),
          notificationHandlers: [],
          serverRequestHandlers: [],
          readline: { close() {} },
          diagnostic: () => {},
        } as any;
        process.kill = () => {
          process.emit('exit', 0);
        };
        process.stdin = {
          write(line: string) {
            const request = JSON.parse(line);
            writes.push(request);
            if (!request.method) return true;
            queueMicrotask(() => {
              const pending = server.pending.get(request.id);
              server.pending.delete(request.id);
              const result =
                request.method === 'thread/start' || request.method === 'thread/resume'
                  ? { thread: { id: 'persistent-thread' } }
                  : {};
              pending?.resolve(
                options.stale && request.method === 'thread/resume'
                  ? { id: request.id, error: { code: -1, message: 'thread not found; private-canary' } }
                  : { id: request.id, result },
              );
              const notify = (n: JsonRpcNotification) => server.notificationHandlers.forEach((handler) => handler(n));
              if (request.method === 'turn/start') {
                notify({ method: 'turn/started', params: { threadId: 'persistent-thread', turn: { id: 'turn' } } });
                if (options.forged)
                  for (const handler of server.serverRequestHandlers)
                    handler({ id: 999, method: 'item/permissions/requestApproval', params: {} });
                notify({
                  method: 'item/agentMessage/delta',
                  params: { threadId: 'foreign-thread', turnId: 'turn', delta: 'foreign-canary' },
                });
                notify({
                  method: 'item/agentMessage/delta',
                  params: { threadId: 'persistent-thread', turnId: 'turn', delta: 'Fixture answer' },
                });
                notify({
                  method: 'turn/completed',
                  params: {
                    threadId: 'persistent-thread',
                    turn: {
                      id: 'turn',
                      status: options.unauthorized ? 'failed' : 'completed',
                      ...(options.unauthorized
                        ? { error: { codexErrorInfo: 'unauthorized', message: 'private-canary' } }
                        : {}),
                    },
                  },
                });
              }
            });
            return true;
          },
        };
        return server;
      },
    },
  );
  async function run(continuation?: string, followup?: string) {
    const query = provider.query({
      prompt: 'Remember amber',
      cwd: '/workspace/agent',
      continuation,
      systemContext: { instructions: 'CoS fixture' },
    });
    if (followup) query.push(followup);
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    return events;
  }
  return { provider, run, writes, spawns, counts: () => ({ refreshed, stopped, prepare }) };
}

test('S05 specialist uses the native Codex transport with only research tools and its own continuation namespace', async () => {
  const f = fixture({ profile: 'research' });
  const events = await f.run();
  const init = events.find((event) => event.type === 'init') as { continuation: string };
  expect(init.continuation).toBe('cos-mission-codex-subscription-v1:persistent-thread');
  expect(f.writes.find((r) => r.method === 'thread/start').params.dynamicTools.map((t: any) => t.name)).toEqual([
    'cos_mission_context_get',
    'cos_result_submit',
  ]);
  await f.run(init.continuation);
  expect(f.writes.filter((r) => r.method === 'thread/start')).toHaveLength(1);
  expect(f.writes.filter((r) => r.method === 'thread/resume')).toHaveLength(1);
  const previous = f.counts().prepare;
  await f.run('cos-codex-subscription-v1:main-private-context');
  expect(f.counts().prepare).toBe(previous);
  expect(JSON.stringify(f.writes)).not.toContain('main-private-context');
  const coordinator = fixture();
  await coordinator.run(init.continuation);
  expect(coordinator.spawns).toHaveLength(0);
});

test('CoS keeps one native thread across queued replies and a new provider query', async () => {
  const f = fixture({ forged: true });
  const events = await f.run(undefined, 'Recall amber from another visual reply thread');
  const init = events.find((event) => event.type === 'init') as { continuation: string };
  expect(init.continuation).toStartWith('cos-codex-subscription-v1:');
  await f.run(init.continuation);
  expect(f.writes.filter((r) => r.method === 'thread/start')).toHaveLength(1);
  expect(f.writes.filter((r) => r.method === 'thread/resume')).toHaveLength(2);
  for (const r of f.writes.filter((r) => ['thread/start', 'thread/resume', 'turn/start'].includes(r.method))) {
    expect(r.params.environments).toEqual([]);
    expect(r.params.approvalPolicy).toBe('never');
    if (r.method === 'turn/start') expect(r.params.sandboxPolicy.type).toBe('readOnly');
    else expect(r.params.modelProvider).toBe('openai');
  }
  expect(f.writes.find((r) => r.method === 'thread/start').params.dynamicTools.map((t: any) => t.name)).toEqual([
    'cos_context_get',
    'cos_change_propose',
    'cos_request_status',
    'cos_knowledge_search',
    'cos_source_get',
    'cos_source_change_propose',
    'cos_answer_prepare',
    'cos_answer_get',
    'cos_calendar_read',
    'cos_work_change_propose',
    'cos_brief_schedule_propose',
    'cos_work_read',
    'cos_brief_request',
    'cos_mission_request',
    'cos_mission_get',
    'cos_mission_cancel',
    'cos_mission_result_get',
    'cos_mission_review',
  ]);
  expect(f.writes.find((r) => r.method === 'thread/resume').params.dynamicTools).toBeUndefined();
  expect(f.writes.find((r) => r.id === 999).error.code).toBe(-32601);
  expect(JSON.stringify(events)).not.toContain('foreign-canary');
  expect(events.filter((e) => e.type === 'result').map((e) => e.text)).toEqual(['Fixture answer', 'Fixture answer']);
  expect(
    f.spawns.every(
      (s) => s.environment.CODEX_HOME === '/home/node/.codex' && s.environment.OPENAI_API_KEY === undefined,
    ),
  ).toBe(true);
  expect(f.counts()).toEqual({ refreshed: 0, stopped: 3, prepare: 3 });
});
test('missing native history requires explicit recovery and never silently starts a fresh context', async () => {
  const f = fixture({ stale: true });
  const events = await f.run('cos-codex-subscription-v1:persistent-thread');
  expect(f.writes.filter((r) => r.method === 'thread/start' || r.method === 'turn/start')).toEqual([]);
  expect(events.some((e) => e.type === 'error' && e.classification === 'cos_context_recovery_required')).toBe(true);
  expect(JSON.stringify(events)).not.toContain('private-canary');
  expect(f.provider.isSessionInvalid(new Error('thread not found'))).toBe(false);
});
test('foreign or malformed continuations and pre-cancelled queries never start native execution', async () => {
  const f = fixture();
  await f.run('codex-dynamic-mcp-v1:ordinary-thread');
  expect(f.spawns).toEqual([]);
  const query = f.provider.query({ prompt: 'cancelled', cwd: '/workspace/agent' });
  query.abort();
  for await (const _ of query.events) throw new Error('Unexpected output');
  expect(f.spawns).toEqual([]);
});
test('native authentication failure renews once without replaying a CoS turn', async () => {
  const f = fixture({ unauthorized: true });
  const events = await f.run();
  expect(f.counts().refreshed).toBe(1);
  expect(f.writes.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain('private-canary');
});
