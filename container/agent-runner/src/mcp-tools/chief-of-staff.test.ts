import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getOutboundDb } from '../db/connection.js';
import { executeCosRequest } from './chief-of-staff.js';
import { digest, type CosRequest } from './generated/cos-protocol.js';
const request: CosRequest = {
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_context_get',
  params: { view: 'today' },
};
const previous = process.env.NANOCLAW_COS_PROTOCOL;
beforeEach(() => {
  process.env.NANOCLAW_COS_PROTOCOL = 'cos-rpc/v1';
});
afterEach(() => {
  closeSessionDb();
  if (previous === undefined) delete process.env.NANOCLAW_COS_PROTOCOL;
  else process.env.NANOCLAW_COS_PROTOCOL = previous;
});

test('S01-T09 returns a matching host response and writes only to its outbound database', async () => {
  const { inbound } = initTestSessionDb();
  inbound.exec(
    'CREATE TABLE cos_rpc_responses(request_id TEXT,payload_hash TEXT,delivery_id TEXT,response TEXT,updated_at TEXT)',
  );
  const response = { protocol: 'cos-rpc/v1', request_id: request.request_id, status: 'ok', result: { records: [] } };
  const respond = setTimeout(() => {
    const queued = getOutboundDb().query('SELECT content FROM messages_out').get() as { content: string };
    const deliveryId = JSON.parse(queued.content).delivery_id;
    inbound
      .prepare('INSERT INTO cos_rpc_responses VALUES(?,?,?,?,?)')
      .run(request.request_id, digest(request), deliveryId, JSON.stringify(response), 'fixture');
  }, 5);
  expect(await executeCosRequest(request, 200)).toEqual(response);
  const queued = getOutboundDb().query('SELECT kind,content FROM messages_out').get() as {
    kind: string;
    content: string;
  };
  expect(queued.kind).toBe('system');
  expect(JSON.parse(queued.content)).toMatchObject({ action: 'cos_rpc', request });
  clearTimeout(respond);
});

test('S01-T09 timeout returns pending with the same request ID, never false success', async () => {
  const { inbound } = initTestSessionDb();
  inbound.exec(
    'CREATE TABLE cos_rpc_responses(request_id TEXT,payload_hash TEXT,delivery_id TEXT,response TEXT,updated_at TEXT)',
  );
  expect(await executeCosRequest(request, 20)).toEqual({
    protocol: 'cos-rpc/v1',
    request_id: request.request_id,
    status: 'pending',
  });
});

test('S01-T01 disabled profile cannot enqueue CoS requests', async () => {
  initTestSessionDb();
  delete process.env.NANOCLAW_COS_PROTOCOL;
  expect((await executeCosRequest(request, 20)).status).toBe('unavailable');
  expect(getOutboundDb().query('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
});

test('S01-T09 old host schema is unavailable without modifying the host-owned database', async () => {
  const { inbound } = initTestSessionDb();
  expect((await executeCosRequest(request, 20)).status).toBe('unavailable');
  expect(inbound.query("SELECT name FROM sqlite_master WHERE name='cos_rpc_responses'").get()).toBeNull();
});

test('S01-T04 a cached response cannot bypass a fresh host authorisation check', async () => {
  const { inbound } = initTestSessionDb();
  inbound.exec(
    'CREATE TABLE cos_rpc_responses(request_id TEXT,payload_hash TEXT,delivery_id TEXT,response TEXT,updated_at TEXT)',
  );
  const stale = { protocol: 'cos-rpc/v1', request_id: request.request_id, status: 'ok', result: { private: 'stale' } };
  inbound
    .prepare('INSERT INTO cos_rpc_responses VALUES(?,?,?,?,?)')
    .run(request.request_id, digest(request), 'old-delivery', JSON.stringify(stale), 'old');
  expect((await executeCosRequest(request, 20)).status).toBe('pending');
});
