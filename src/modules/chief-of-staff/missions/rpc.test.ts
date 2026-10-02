import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { createAgentGroup } from '../../../db/agent-groups.js';
import { createSession, getSession, updateSession } from '../../../db/sessions.js';
import { installCosMissionBoundary, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { stopCosMissionAttempt } from '../../../cos-mission-stop.js';
import { digest, type Result } from '../domain/contracts.js';
import { createMissionRpcHandler } from './rpc.js';
import type { MissionWorkerGrant } from './dispatch.js';
let inbox: Database.Database;
const identity: CosMissionIdentity = {
  scopeId: 'scope',
  missionId: 'mission',
  attemptId: 'attempt',
  generation: 1,
  agentGroupId: 'child',
  sessionId: 'session',
  provider: 'codex',
};
beforeEach(() => {
  runMigrations(initTestDb());
  inbox = new Database(':memory:');
  createAgentGroup({
    id: 'child',
    name: 'child',
    folder: 'child',
    agent_provider: 'codex',
    created_at: new Date().toISOString(),
  });
  createSession({
    id: 'session',
    agent_group_id: 'child',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: 'codex',
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  });
  installCosMissionBoundary(identity, getDb());
});
afterEach(() => {
  inbox.close();
  closeDb();
});
function fixture() {
  const grant: MissionWorkerGrant = { identity, lease: { owner: 'host', fence: 1 } };
  const resolve = vi.fn(async (): Promise<MissionWorkerGrant | null> => grant);
  const readContext = vi.fn(async (): Promise<Result> => ({ status: 'ok', context: { text: 'PRIVATE_CANARY' } }));
  const submit = vi.fn(
    async (): Promise<Result> => ({ status: 'ok', state: 'awaiting_review', submission_id: 'submission' }),
  );
  const handler = createMissionRpcHandler({ resolve, runs: { readContext }, submit });
  const request = {
    protocol: 'cos-mission-rpc/v1',
    request_id: randomUUID(),
    method: 'cos_mission_context_get',
    params: {},
  };
  const content = { action: 'cos_mission_rpc', request, delivery_id: randomUUID() };
  const session = getSession('session')!;
  const response = () =>
    JSON.parse(
      (
        inbox
          .prepare('SELECT response FROM cos_rpc_responses WHERE request_id=? AND payload_hash=? AND delivery_id=?')
          .get(request.request_id, digest(content.request), content.delivery_id) as { response: string }
      ).response,
    );
  return { grant, resolve, readContext, submit, handler, request, content, session, response };
}
it('S05-T03 bridges the assigned context using the exact native identity and tags retained bytes for purge', async () => {
  const f = fixture();
  await f.handler(f.content, f.session, inbox);
  expect(f.readContext).toHaveBeenCalledWith(
    identity,
    f.grant.lease,
    'worker-' + digest({ request_id: f.request.request_id, delivery_id: f.content.delivery_id }),
  );
  expect(f.response()).toMatchObject({
    protocol: 'cos-mission-rpc/v1',
    status: 'ok',
    result: { context: { text: 'PRIVATE_CANARY' } },
  });
  expect(inbox.prepare('SELECT scope_id,session_id,generation FROM cos_rpc_contexts').get()).toEqual({
    scope_id: 'scope',
    session_id: 'session',
    generation: 'attempt',
  });
  expect(f.submit).not.toHaveBeenCalled();
});
it('S05-T08 sends only a schema-checked result to host review admission, never worker completion', async () => {
  const f = fixture();
  const result = {
    format: 'cos-research-result/v1',
    outcome: 'blocked',
    claims: [],
    criteria: [{ id: 'comparison', claim_ids: [] }],
    limitations: ['Missing evidence.'],
  };
  const content = { ...f.content, request: { ...f.request, method: 'cos_result_submit', params: { result } } };
  await f.handler(content, f.session, inbox);
  expect(f.submit).toHaveBeenCalledWith(
    identity,
    f.grant.lease,
    f.request.request_id,
    'worker-' + digest({ request_id: f.request.request_id, delivery_id: f.content.delivery_id }),
    result,
  );
  expect(f.readContext).not.toHaveBeenCalled();
  const row = inbox.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string };
  expect(JSON.parse(row.response)).toMatchObject({ status: 'ok', result: { state: 'awaiting_review' } });
});
it('S05-T03 rejects forged identity, malformed envelopes and non-child callers before reading', async () => {
  const f = fixture();
  for (const patch of [
    { action: 'cos_rpc' },
    { session_id: 'other' },
    { delivery_id: 'bad' },
    { request: { ...f.request, params: { scope_id: 'other' } } },
  ])
    await f.handler({ ...f.content, ...patch }, f.session, inbox);
  expect(f.resolve).not.toHaveBeenCalled();
  await f.handler(f.content, { ...f.session, agent_group_id: 'other' }, inbox);
  expect(f.response().status).toBe('denied');
  expect(f.readContext).not.toHaveBeenCalled();
  f.resolve.mockResolvedValue({ ...f.grant, identity: { ...identity, missionId: 'other' } });
  await f.handler(f.content, f.session, inbox);
  expect(f.response().status).toBe('denied');
  expect(f.readContext).not.toHaveBeenCalled();
});
it.each(['stop', 'closed', 'fence', 'offline'])(
  'S05-T07/T10 suppresses context if %s changes while the host reads',
  async (change) => {
    const f = fixture();
    f.readContext.mockImplementationOnce(async () => {
      if (change === 'stop') stopCosMissionAttempt(identity, 'authority_lost', getDb());
      if (change === 'closed') updateSession('session', { status: 'closed' });
      if (change === 'fence') f.resolve.mockResolvedValue({ ...f.grant, lease: { owner: 'new-host', fence: 2 } });
      if (change === 'offline') f.resolve.mockRejectedValue(new Error('private details'));
      return { status: 'ok', context: { text: 'PRIVATE_CANARY' } };
    });
    await f.handler(f.content, f.session, inbox);
    expect(f.response().status).toMatch(/denied|unavailable/);
    expect(JSON.stringify(f.response())).not.toMatch(/PRIVATE_CANARY|private details/);
  },
);
it('S05-T09 performs fresh checks on response replay and replaces stale content with denial', async () => {
  const f = fixture();
  await f.handler(f.content, f.session, inbox);
  f.resolve.mockResolvedValue(null);
  await f.handler(f.content, f.session, inbox);
  expect(f.response().status).toBe('denied');
  expect(JSON.stringify(f.response())).not.toContain('PRIVATE_CANARY');
  expect(f.readContext).toHaveBeenCalledTimes(1);
});
it('S05-T03 bounds replies and never mirrors host approval tokens', async () => {
  const f = fixture();
  f.readContext.mockResolvedValueOnce({ status: 'ok', confirmation_token: 'SECRET_TOKEN', context: {} });
  await f.handler(f.content, f.session, inbox);
  expect(JSON.stringify(f.response())).not.toContain('SECRET_TOKEN');
  f.readContext.mockResolvedValueOnce({ status: 'ok', context: 'x'.repeat(100000) });
  await f.handler(f.content, f.session, inbox);
  expect(f.response()).toMatchObject({ status: 'unavailable' });
  expect(f.response().result).toBeUndefined();
});
