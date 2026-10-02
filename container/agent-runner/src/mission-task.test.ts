import { afterEach, expect, test } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getOutboundDb } from './db/connection.js';
import { runMissionTask } from './mission-task.js';
import type { AgentProvider, QueryInput } from './providers/types.js';
import type { MissionRuntimeConfig } from './mcp-tools/generated/mission-runtime.js';
import { getContinuation, setContinuation } from './db/session-state.js';
const config: MissionRuntimeConfig = {
  provider: 'codex',
  model: 'fixture',
  runtime: 'codex-subscription/v1',
  profile: 'research',
  contextGeneration: '11111111-1111-4111-8111-111111111111',
  agentGroupId: 'child',
  assistantName: 'CoS Research',
  groupName: 'CoS Research',
  maxMessagesPerPrompt: 1,
  mcpServers: {},
  mission: {
    missionId: 'mission-one',
    attemptId: '11111111-1111-4111-8111-111111111111',
    inputId: 'input-one',
    generation: 1,
    workOrderDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
    templateDigest: 'c'.repeat(64),
  },
};
afterEach(closeSessionDb);
function fixture(options: { error?: boolean; wait?: boolean } = {}) {
  const { inbound } = initTestSessionDb();
  const content = {
    text: 'Perform the approved read-only research work order using only its admitted context.',
    mission: {
      mission_id: config.mission.missionId,
      attempt_id: config.mission.attemptId,
      generation: 1,
      work_order_digest: config.mission.workOrderDigest,
    },
  };
  inbound
    .prepare("INSERT INTO messages_in(id,kind,timestamp,status,content) VALUES('input-one','task',?,'pending',?)")
    .run(new Date().toISOString(), JSON.stringify(content));
  const queries: QueryInput[] = [];
  let aborted = 0,
    resume: (() => void) | undefined;
  const provider: AgentProvider = {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => true,
    query(input) {
      queries.push(input);
      return {
        push() {
          throw new Error('no_followups');
        },
        end() {},
        abort() {
          aborted++;
          resume?.();
        },
        events: (async function* () {
          yield { type: 'init' as const, continuation: 'cos-mission-codex-subscription-v1:child-thread' };
          if (options.wait)
            await new Promise<void>((resolve) => {
              resume = resolve;
            });
          if (options.error) yield { type: 'error' as const, message: 'private-error', retryable: true };
          yield { type: 'result' as const, text: '<send_message to="owner">DO NOT ROUTE THIS</send_message>' };
        })(),
      };
    },
  };
  const run = (signal?: AbortSignal, deadlineAt = new Date(Date.now() + 60000).toISOString()) =>
    runMissionTask({ config, deadlineAt, instructions: 'Reviewed fixed template.', provider, signal });
  return { inbound, queries, run, aborted: () => aborted };
}
test('S05 native specialist acknowledges one exact task without routing provider output or inheriting main continuation', async () => {
  const f = fixture();
  setContinuation('cos-codex-subscription:main', 'main-secret');
  setContinuation('codex', 'ordinary-secret');
  expect(await f.run()).toBe('processed');
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0].continuation).toBeUndefined();
  expect(f.queries[0].prompt).not.toContain('secret');
  expect(getContinuation('cos-mission-subscription:' + config.mission.attemptId)).toBe(
    'cos-mission-codex-subscription-v1:child-thread',
  );
  expect(getOutboundDb().query('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
  expect(getOutboundDb().query('SELECT status FROM processing_ack').get()).toEqual({ status: 'completed' });
  expect(await f.run()).toBe('idle');
  expect(f.queries).toHaveLength(1);
});
test('S05 interrupted native transport resumes the same attempt context and never clears it on error', async () => {
  const f = fixture({ error: true });
  setContinuation('cos-mission-subscription:' + config.mission.attemptId, 'cos-mission-codex-subscription-v1:retained');
  getOutboundDb().exec(
    "INSERT INTO processing_ack(message_id,status,status_changed) VALUES('input-one','processing',datetime('now'))",
  );
  expect(await f.run()).toBe('failed');
  expect(f.queries[0].continuation).toBe('cos-mission-codex-subscription-v1:retained');
  expect(getContinuation('cos-mission-subscription:' + config.mission.attemptId)).toBe(
    'cos-mission-codex-subscription-v1:child-thread',
  );
  expect(getOutboundDb().query('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
});
test('S05 foreign, routed or additional input cannot start a specialist model turn', async () => {
  for (const sql of [
    "UPDATE messages_in SET id='foreign'",
    "UPDATE messages_in SET kind='chat'",
    "UPDATE messages_in SET channel_type='mattermost'",
    "UPDATE messages_in SET recurrence='* * * * *'",
    "UPDATE messages_in SET content='{}'",
    "INSERT INTO messages_in(id,kind,timestamp,content) VALUES('extra','task','now','private-sibling')",
  ]) {
    const f = fixture();
    f.inbound.exec(sql);
    await expect(f.run()).rejects.toThrow('mission_input_denied');
    expect(f.queries).toHaveLength(0);
    closeSessionDb();
  }
});
test('S05 cancellation and deadline abort the query without publishing its late output', async () => {
  const f = fixture({ wait: true }),
    controller = new AbortController();
  const running = f.run(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  expect(await running).toBe('failed');
  expect(f.aborted()).toBe(1);
  expect(getOutboundDb().query('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
  closeSessionDb();
  const expired = fixture();
  expect(await expired.run(undefined, new Date(Date.now() - 1).toISOString())).toBe('failed');
  expect(expired.queries).toHaveLength(0);
  closeSessionDb();
  const deadline = fixture({ wait: true });
  expect(await deadline.run(undefined, new Date(Date.now() + 20).toISOString())).toBe('failed');
  expect(deadline.aborted()).toBe(1);
});
