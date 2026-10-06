import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getOutboundDb } from '../db/connection.js';
import { executeCosRequest, cosTools } from './chief-of-staff.js';
import { digest, type CosRequest } from './generated/cos-protocol.js';
const request: CosRequest = {
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_context_get',
  params: { view: 'today' },
};
const previous = process.env.NANOCLAW_COS_PROTOCOL;
test('S10 strategic tools expose exact bounded requests without owner or publication authority', async () => {
  initTestSessionDb();
  for (const [name, keys] of [
    ['cos_review_charter_propose', ['request_id', 'change']],
    ['cos_strategy_observation_propose', ['request_id', 'change']],
    ['cos_strategy_direction_propose', ['request_id', 'request']],
    ['cos_review_request', ['request_id', 'request']],
    ['cos_review_submit', ['request_id', 'review_id', 'revision', 'draft']],
    ['cos_review_get', ['review_id', 'revision', 'historical']],
  ] as const) {
    const definition = cosTools.find(({ tool }) => tool.name === name);
    expect(definition).toBeDefined();
    expect(Object.keys(definition!.tool.inputSchema.properties!)).toEqual([...keys]);
    expect(definition!.tool.inputSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(await definition!.handler({ owner_id: 'forged', approved: true }))).toContain('denied');
  }
  expect(getOutboundDb().query('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
});
test('S04 work reader exposes bounded views and exact revisions without write authority', async () => {
  const tool = cosTools.find((definition) => definition.tool.name === 'cos_work_read');
  expect(tool).toBeDefined();
  expect(Object.keys(tool!.tool.inputSchema.properties!)).toEqual(['view', 'offset', 'record_id', 'version']);
  initTestSessionDb();
  expect(JSON.stringify(await tool!.handler({ view: 'all', owner_id: 'forged' }))).toContain('denied');
  expect(getOutboundDb().query('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
});
test('S04 work proposal exposes exact versioned changes and cannot accept caller authority', async () => {
  const tool = cosTools.find((definition) => definition.tool.name === 'cos_work_change_propose');
  expect(tool).toBeDefined();
  const schema = tool!.tool.inputSchema;
  expect(schema.required).toEqual(['change']);
  expect(Object.keys(schema.properties!)).toEqual(['request_id', 'change']);
  expect(schema.additionalProperties).toBe(false);
  const change = schema.properties!.change as any;
  expect(change.required).toContain('expected_version');
  expect(change.required).toContain('evidence');
  expect(change.properties.kind.enum).toEqual(['commitment', 'decision']);
  expect(change.properties.evidence.maxItems).toBe(10);
  expect(change.additionalProperties).toBe(false);
  initTestSessionDb();
  const result = await tool!.handler({ change: {}, owner_id: 'forged' });
  expect(JSON.stringify(result)).toContain('denied');
  expect(getOutboundDb().query('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
});
test('S02 answer tool requires a cited draft and advertises no caller authority', () => {
  const schema = cosTools.find((definition) => definition.tool.name === 'cos_answer_prepare')!.tool.inputSchema;
  expect(schema.required).toEqual(['draft']);
  expect(Object.keys(schema.properties!)).toEqual(['request_id', 'draft']);
  expect(schema.additionalProperties).toBe(false);
});
test('S02 answer tool rejects extra authority before writing an RPC message', async () => {
  initTestSessionDb();
  const tool = cosTools.find((definition) => definition.tool.name === 'cos_answer_prepare')!;
  const result = await tool.handler({
    draft: { kind: 'answer', coverage: 'insufficient', claims: [] },
    provider: 'foreign',
  });
  expect(JSON.stringify(result)).toContain('denied');
  expect(getOutboundDb().query('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
});
test('proposal tool advertises the complete exact-change contract to the provider', () => {
  const schema = cosTools.find((definition) => definition.tool.name === 'cos_change_propose')!.tool.inputSchema;
  const change = schema.properties!.change as {
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  expect(change.required).toEqual(['kind', 'title', 'description', 'lifecycle', 'reason', 'expected_version']);
  expect(change.properties.kind).toEqual({ type: 'string', enum: ['charter', 'goal', 'project'] });
  expect(change.additionalProperties).toBe(false);
});
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

test('a cancelled native tool cannot enqueue RPC or return a late host result', async () => {
  const { inbound } = initTestSessionDb();
  inbound.exec(
    'CREATE TABLE cos_rpc_responses(request_id TEXT,payload_hash TEXT,delivery_id TEXT,response TEXT,updated_at TEXT)',
  );
  const controller = new AbortController();
  controller.abort();
  expect((await executeCosRequest(request, 200, controller.signal)).status).toBe('unavailable');
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

test('S04 brief tool advertises bounded requests and rejects caller authority before RPC dispatch', async () => {
  initTestSessionDb();
  const tool = cosTools.find((x) => x.tool.name === 'cos_brief_request');
  expect(tool).toBeDefined();
  expect(tool!.tool.inputSchema.additionalProperties).toBe(false);
  expect(Object.keys(tool!.tool.inputSchema.properties!)).toEqual(['request_id', 'time_zone', 'artifact_id']);
  const result = await tool!.handler({ time_zone: 'UTC', owner_id: 'forged' });
  expect(JSON.stringify(result)).toContain('denied');
  expect(getOutboundDb().query('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
});
