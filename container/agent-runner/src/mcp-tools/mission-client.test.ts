import { afterEach, expect, test } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getOutboundDb } from '../db/connection.js';
import { executeMissionRequest } from './mission-client.js';
import { digest } from './generated/cos-protocol.js';
import type { MissionWorkerRequest } from './generated/mission-worker-protocol.js';
const request: MissionWorkerRequest = {
  protocol: 'cos-mission-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_mission_context_get',
  params: {},
};
const previous = process.env.NANOCLAW_COS_PROTOCOL;
afterEach(() => {
  closeSessionDb();
  if (previous === undefined) delete process.env.NANOCLAW_COS_PROTOCOL;
  else process.env.NANOCLAW_COS_PROTOCOL = previous;
});
function fixture() {
  process.env.NANOCLAW_COS_PROTOCOL = 'cos-mission-rpc/v1';
  const { inbound } = initTestSessionDb();
  inbound.exec(
    'CREATE TABLE cos_rpc_responses(request_id TEXT,payload_hash TEXT,delivery_id TEXT,response TEXT,updated_at TEXT)',
  );
  return inbound;
}
test('S05 specialist native RPC uses its own action and requires a fresh matching host delivery', async () => {
  const inbound = fixture();
  inbound.prepare('INSERT INTO cos_rpc_responses VALUES(?,?,?,?,?)').run(
    request.request_id,
    digest(request),
    'stale',
    JSON.stringify({
      protocol: request.protocol,
      request_id: request.request_id,
      status: 'ok',
      result: 'stale-canary',
    }),
    'fixture',
  );
  const response = {
    protocol: request.protocol,
    request_id: request.request_id,
    status: 'ok',
    result: { sources: [] },
  };
  setTimeout(() => {
    const row = getOutboundDb().query('SELECT content FROM messages_out').get() as { content: string };
    const envelope = JSON.parse(row.content);
    inbound
      .prepare('INSERT INTO cos_rpc_responses VALUES(?,?,?,?,?)')
      .run(request.request_id, digest(request), envelope.delivery_id, JSON.stringify(response), 'fixture');
  }, 5);
  expect(await executeMissionRequest(request, 200)).toEqual(response);
  const row = getOutboundDb()
    .query('SELECT kind,channel_type,platform_id,thread_id,content FROM messages_out')
    .get() as any;
  expect(row).toMatchObject({ kind: 'system', channel_type: null, platform_id: null, thread_id: null });
  expect(JSON.parse(row.content)).toMatchObject({ action: 'cos_mission_rpc', request });
});
test('S05 specialist cannot send under the coordinator profile or use forged authority', async () => {
  fixture();
  process.env.NANOCLAW_COS_PROTOCOL = 'cos-rpc/v1';
  expect((await executeMissionRequest(request, 20)).status).toBe('unavailable');
  process.env.NANOCLAW_COS_PROTOCOL = 'cos-mission-rpc/v1';
  expect((await executeMissionRequest({ ...request, params: { mission_id: 'other' } } as any, 20)).status).toBe(
    'denied',
  );
  const abort = new AbortController();
  abort.abort();
  expect((await executeMissionRequest(request, 20, abort.signal)).status).toBe('unavailable');
  expect(getOutboundDb().query('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
});
test('S05 stale context replies cannot survive an unavailable host', async () => {
  const inbound = fixture();
  inbound.prepare('INSERT INTO cos_rpc_responses VALUES(?,?,?,?,?)').run(
    request.request_id,
    digest(request),
    'stale',
    JSON.stringify({
      protocol: request.protocol,
      request_id: request.request_id,
      status: 'ok',
      result: 'old-context',
    }),
    'fixture',
  );
  expect((await executeMissionRequest(request, 20)).status).toBe('pending');
});
