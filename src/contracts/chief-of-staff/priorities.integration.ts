import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { parseDatabaseConfig } from '../../modules/chief-of-staff/store/config.js';
import { connectChecked } from '../../modules/chief-of-staff/store/preflight.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import type { Change, Context } from '../../modules/chief-of-staff/domain/contracts.js';

let admin: pg.Client;
let pool: pg.Pool;
let store: PriorityStore;
const scope = 'fixture-' + randomUUID();
const context: Context = {
  scopeId: scope,
  ownerId: 'fixture-owner',
  sessionId: scope,
  agentGroupId: scope,
  ingressId: randomUUID(),
};
const change: Change = {
  kind: 'goal',
  title: 'Launch a pilot',
  description: 'Reliability before features',
  lifecycle: 'active',
  reason: 'Owner direction',
  expected_version: 0,
};

before(async () => {
  // Only the explicitly admitted separate test profile is accepted by this suite.
  admin = await connectChecked(process.env, 'test', 'migration');
  const lock = await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked');
  assert.equal(lock.rows[0].locked, true, 'another integration suite owns the target');
  await migrate(admin, process.env.COS_TEST_PGUSER!);
  const runtime = await connectChecked(process.env, 'test');
  await runtime.end();
  pool = new pg.Pool(parseDatabaseConfig(process.env, 'test'));
  store = new PriorityStore(BoundedDatabase.fromConfig(parseDatabaseConfig(process.env, 'test')));
  await pool.query(
    `INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status)
    VALUES($1,$2,'fixture-instance',$1,$1,'active')`,
    [scope, context.ownerId],
  );
});

after(async () => {
  if (pool) {
    for (const table of ['outbox', 'events', 'operations', 'proposals', 'records'])
      await pool.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    await pool.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
    await pool.end();
  }
  await store?.database.pool.end();
  await admin?.end();
});

test('S01-T02 unapproved proposals are excluded; owner approval applies one durable record', async () => {
  const result = await store.propose(context, randomUUID(), change);
  assert.equal(result.status, 'ok');
  const before = await store.context(context);
  assert.deepEqual(before.records, []);
  const proposal = String(result.proposal_id);
  const token = String(result.confirmation_token);
  const decision = await store.decide({ ...context, ingressId: randomUUID() }, proposal, token, 'approve');
  assert.equal(decision.status, 'ok');
  assert.equal((await store.apply(scope, proposal)).status, 'ok');
  const records = (await store.context(context)).records as Array<{ title: string }>;
  assert.equal(records.length, 1);
  assert.equal(records[0].title, change.title);
});

test('S01-T03 repeated request returns its original proposal; changed payload conflicts', async () => {
  const request = randomUUID();
  const first = await store.propose(context, request, { ...change, title: 'Pilot Alpha', kind: 'project' });
  assert.equal(first.status, 'ok');
  assert.deepEqual(await store.propose(context, request, { ...change, title: 'Pilot Alpha', kind: 'project' }), first);
  assert.equal((await store.propose(context, request, { ...change, title: 'Different' })).status, 'conflict');
});

test('S01-T04 wrong owner, foreign scope, bad token and decision replay cannot approve', async () => {
  const result = await store.propose(context, randomUUID(), change);
  assert.equal(result.status, 'ok');
  for (const wrong of [
    { ...context, ownerId: 'outsider' },
    { ...context, scopeId: 'foreign' },
    { ...context, agentGroupId: 'foreign' },
  ]) {
    assert.equal(
      (await store.decide(wrong, String(result.proposal_id), String(result.confirmation_token), 'approve')).status,
      'denied',
    );
  }
  assert.equal((await store.decide(context, String(result.proposal_id), 'forged', 'approve')).status, 'denied');
});

test('S01-T05 retry after projection loss recovers the original operation result', async () => {
  const request = randomUUID();
  const first = await store.propose(context, request, change);
  assert.equal(first.status, 'ok');
  const restarted = new PriorityStore(BoundedDatabase.fromConfig(parseDatabaseConfig(process.env, 'test')));
  try {
    assert.deepEqual(await restarted.propose(context, request, change), first);
  } finally {
    await restarted.database.pool.end();
  }
});

test('S01-T03 concurrent retries create one proposal and repeated approval applies once', async () => {
  const request = randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => store.propose(context, request, change)));
  assert.equal(results[0].status, 'ok');
  for (const result of results) assert.deepEqual(result, results[0]);
  const proposal = String(results[0].proposal_id),
    token = String(results[0].confirmation_token);
  const owner = { ...context, ingressId: randomUUID() };
  const first = await store.decide(owner, proposal, token, 'approve');
  assert.equal(first.status, 'ok');
  assert.deepEqual(await store.decide(owner, proposal, token, 'approve'), first);
  const applied = await Promise.all([store.apply(scope, proposal), store.apply(scope, proposal)]);
  assert.equal(applied[0].status, 'ok');
  assert.deepEqual(applied[0], applied[1]);
  const count = await pool.query(
    "SELECT count(*)::integer AS count FROM cos.records WHERE scope_id=$1 AND provenance->>'proposal_id'=$2",
    [scope, proposal],
  );
  assert.equal(count.rows[0].count, 1);
});

test('S01-T06 a stale approved edit cannot overwrite a newer revision', async () => {
  const records = (await store.context(context)).records as Array<{ id: string; version: number }>;
  const record = records[0];
  const one = await store.propose(context, randomUUID(), {
    ...change,
    title: 'First revision',
    record_id: record.id,
    expected_version: record.version,
  });
  const two = await store.propose(context, randomUUID(), {
    ...change,
    title: 'Stale revision',
    record_id: record.id,
    expected_version: record.version,
  });
  for (const proposal of [one, two])
    assert.equal(
      (
        await store.decide(
          { ...context, ingressId: randomUUID() },
          String(proposal.proposal_id),
          String(proposal.confirmation_token),
          'approve',
        )
      ).status,
      'ok',
    );
  assert.equal((await store.apply(scope, String(one.proposal_id))).status, 'ok');
  assert.equal((await store.apply(scope, String(two.proposal_id))).status, 'conflict');
  const current = await pool.query('SELECT title,version FROM cos.records WHERE id=$1', [record.id]);
  assert.equal(current.rows[0].title, 'First revision');
  assert.equal(current.rows[0].version, record.version + 1);
});

test('S01-T04 expiry and replaying a decision event across proposals deny mutation', async () => {
  const expired = await store.propose(context, randomUUID(), change);
  await pool.query("UPDATE cos.proposals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
    expired.proposal_id,
  ]);
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(expired.proposal_id),
        String(expired.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  const one = await store.propose(context, randomUUID(), change),
    two = await store.propose(context, randomUUID(), change);
  const owner = { ...context, ingressId: randomUUID() };
  assert.equal(
    (await store.decide(owner, String(one.proposal_id), String(one.confirmation_token), 'reject')).status,
    'ok',
  );
  assert.equal(
    (await store.decide(owner, String(two.proposal_id), String(two.confirmation_token), 'approve')).status,
    'denied',
  );
});

test('S01-PG05 loss of COMMIT acknowledgement returns pending, then reconciles the same request', async () => {
  const faultyPool = new pg.Pool(parseDatabaseConfig(process.env, 'test'));
  const connection = await faultyPool.connect();
  const original = connection.query.bind(connection);
  let dropped = false;
  connection.query = (async (...args: unknown[]) => {
    const value = await (original as (...params: unknown[]) => Promise<unknown>)(...args);
    if (args[0] === 'COMMIT' && !dropped) {
      dropped = true;
      throw new Error('fixture: commit acknowledgement lost');
    }
    return value;
  }) as typeof connection.query;
  connection.release();
  const request = randomUUID();
  const faulty = new PriorityStore(new BoundedDatabase(faultyPool));
  try {
    assert.deepEqual(await faulty.propose(context, request, change), { status: 'pending', request_id: request });
    const recovered = await store.propose(context, request, change);
    assert.equal(recovered.status, 'ok');
    assert.deepEqual(await store.propose(context, request, change), recovered);
    const count = await pool.query(
      'SELECT count(*)::integer AS count FROM cos.operations WHERE session_id=$1 AND request_id=$2',
      [context.sessionId, request],
    );
    assert.equal(count.rows[0].count, 1);
  } finally {
    await faultyPool.end();
  }
});
