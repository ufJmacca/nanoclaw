import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  fixtureDatabaseConfig,
  connectFixtureDatabase,
  fixtureRuntimeUser,
  fixtureProfile,
} from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import type { Change, Context } from '../../modules/chief-of-staff/domain/contracts.js';
import { databaseFingerprint } from '../../modules/chief-of-staff/ops/target-identity.js';
import { connectionFault } from './connection-fault.js';

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

test('S01-PG04 actual connection partition is bounded and reconnects to the external target', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig(process.env));
  const partitionPool = new pg.Pool(relay.config);
  const database = new BoundedDatabase(partitionPool, 350);
  try {
    assert.equal((await database.run((client) => client.query('SELECT 1 AS value'))).rows[0].value, 1);
    relay.partition();
    const started = Date.now();
    await assert.rejects(
      database.run((client) => client.query('SELECT 2 AS value')),
      /CoS database unavailable/,
    );
    assert.ok(Date.now() - started < 1500, 'network stall exceeded bounded deadline');
    relay.restore();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal((await database.run((client) => client.query('SELECT 3 AS value'))).rows[0].value, 3);
  } finally {
    await partitionPool.end();
    await relay.close();
  }
});

before(async () => {
  // Separate tests retain the protected marker; runtime fixtures require a live Pi-owned guard.
  admin = await connectFixtureDatabase(process.env, 'migration');
  const lock = await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked');
  assert.equal(lock.rows[0].locked, true, 'another integration suite owns the target');
  await migrate(admin, fixtureRuntimeUser());
  const runtime = await connectFixtureDatabase(process.env);
  try {
    assert.equal(
      await databaseFingerprint(admin, await fixtureDatabaseConfig(process.env, 'migration')),
      await databaseFingerprint(runtime, await fixtureDatabaseConfig(process.env)),
    );
  } finally {
    await runtime.end();
  }
  pool = new pg.Pool(await fixtureDatabaseConfig(process.env));
  store = new PriorityStore(BoundedDatabase.fromConfig(await fixtureDatabaseConfig(process.env)));
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

test('S01 trusted scope setup is idempotent and refuses identity replacement', async () => {
  const id = scope + '-binding';
  const binding = {
    scopeId: id,
    ownerId: 'fixture-owner',
    instanceId: 'fixture-instance',
    channelId: id,
    agentGroupId: id,
    messagingGroupId: id,
    sessionId: id,
    botId: 'fixture-bot',
    provider: 'codex' as const,
  };
  try {
    assert.equal((await store.bindScope(binding)).status, 'ok');
    assert.equal((await store.bindScope(binding)).status, 'ok');
    assert.equal((await store.bindScope({ ...binding, ownerId: 'foreign' })).status, 'conflict');
    const rows = (await pool.query('SELECT owner_id FROM cos.scopes WHERE id=$1', [id])).rows;
    assert.deepEqual(rows, [{ owner_id: 'fixture-owner' }]);
  } finally {
    await pool.query('DELETE FROM cos.scopes WHERE id=$1', [id]);
  }
});

test('S01-T03 repeated request returns its original proposal; changed payload conflicts', async () => {
  const request = randomUUID();
  const first = await store.propose(context, request, { ...change, title: 'Pilot Alpha', kind: 'project' });
  assert.equal(first.status, 'ok');
  assert.deepEqual(await store.propose(context, request, { ...change, title: 'Pilot Alpha', kind: 'project' }), first);
  assert.equal((await store.propose(context, request, { ...change, title: 'Different' })).status, 'conflict');
});

test('S01-T05 durable outbox retains exact previews and separate approved apply work', async () => {
  const proposal = await store.propose(context, randomUUID(), { ...change, title: 'Durable preview' });
  const pending = await store.pendingOutbox(scope);
  const preview = (
    pending.items as Array<{
      id: string;
      kind: string;
      payload: { proposal_id: string; confirmation_token: string };
      expires_at: string;
      session_id: string;
    }>
  ).find((item) => item.payload.proposal_id === proposal.proposal_id);
  assert.ok(preview);
  assert.equal(preview.kind, 'approval_preview');
  assert.equal(preview.session_id, context.sessionId);
  assert.equal(preview.payload.confirmation_token, proposal.confirmation_token);
  assert.ok(Date.parse(preview.expires_at) > Date.now());
  assert.equal((await store.acknowledgePreview(scope, preview.id)).status, 'ok');
  assert.ok(
    !(await store.pendingOutbox(scope)).items ||
      !JSON.stringify((await store.pendingOutbox(scope)).items).includes('Durable preview'),
  );
  await store.decide(
    { ...context, ingressId: randomUUID() },
    String(proposal.proposal_id),
    String(proposal.confirmation_token),
    'approve',
  );
  const ready = (await store.pendingOutbox(scope)).items as Array<{ kind: string; payload: { proposal_id: string } }>;
  assert.ok(ready.some((item) => item.kind === 'proposal_apply' && item.payload.proposal_id === proposal.proposal_id));
  assert.equal((await store.apply(scope, String(proposal.proposal_id))).status, 'ok');
  assert.ok(!JSON.stringify((await store.pendingOutbox(scope)).items).includes(String(proposal.proposal_id)));
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
  const restarted = new PriorityStore(BoundedDatabase.fromConfig(await fixtureDatabaseConfig(process.env)));
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
  const faultyPool = new pg.Pool(await fixtureDatabaseConfig(process.env));
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

test('S01-PG02 a real maintenance lease excludes runtime operations across independent connections', async () => {
  const maintenance = await connectFixtureDatabase(process.env);
  const runtime = new BoundedDatabase(new pg.Pool(await fixtureDatabaseConfig(process.env)), 2000, 2, () => true);
  let finish!: () => void;
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let work: Promise<unknown> | undefined;
  try {
    if (fixtureProfile() === 'runtime') {
      // The parent guard owns the exclusive runtime fence for the whole fixture session.
      assert.equal((await maintenance.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0].locked, false);
      await assert.rejects(
        runtime.run(async () => {
          throw new Error('must_not_run');
        }, true),
        /CoS database unavailable/,
      );
      return;
    }
    work = runtime.run(async () => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await entering;
    assert.equal((await maintenance.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0].locked, false);
    finish();
    await work;
    assert.equal((await maintenance.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0].locked, true);
    await assert.rejects(
      runtime.run(async () => {
        throw new Error('must_not_run');
      }, true),
      /CoS database unavailable/,
    );
    await maintenance.query('SELECT pg_advisory_unlock(73101003)');
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(await runtime.run(async (client) => (await client.query('SELECT 1 AS value')).rows[0].value), 1);
  } finally {
    finish?.();
    await work?.catch(() => {});
    await runtime.pool.end();
    await maintenance.end();
  }
});

test('S01 active-charter edits settle collisions once, including concurrent activation', async () => {
  const approved = async (value: Change) => {
    const proposal = await store.propose(context, randomUUID(), value);
    assert.equal(proposal.status, 'ok');
    const id = String(proposal.proposal_id);
    assert.equal(
      (await store.decide({ ...context, ingressId: randomUUID() }, id, String(proposal.confirmation_token), 'approve'))
        .status,
      'ok',
    );
    return id;
  };
  const create = async (title: string, lifecycle: Change['lifecycle']) => {
    const id = await approved({ ...change, kind: 'charter', title, lifecycle });
    const applied = await store.apply(scope, id);
    assert.equal(applied.status, 'ok');
    return String(applied.record_id);
  };
  const active = await create('Current charter', 'active');
  const candidates = await Promise.all(
    ['Alternative one', 'Alternative two'].map((title) => create(title, 'inactive')),
  );
  const activate = (id: string) =>
    approved({ ...change, kind: 'charter', title: 'Alternative charter', record_id: id, expected_version: 1 });
  const collisions = await Promise.all(candidates.map(activate));
  for (const id of collisions) {
    assert.equal((await store.apply(scope, id)).status, 'conflict');
    assert.equal((await store.apply(scope, id)).status, 'conflict');
    const state = await pool.query(
      `SELECT p.state, o.delivered_at IS NOT NULL AS settled
      FROM cos.proposals p JOIN cos.outbox o ON o.id='apply-'||p.id WHERE p.id=$1`,
      [id],
    );
    assert.deepEqual(state.rows, [{ state: 'conflict', settled: true }]);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM cos.events WHERE resource_id=$1 AND kind='conflict'", [id]))
        .rows[0].n,
      1,
    );
  }
  const deactivate = await approved({
    ...change,
    kind: 'charter',
    title: 'Retired charter',
    record_id: active,
    expected_version: 1,
    lifecycle: 'inactive',
  });
  assert.equal((await store.apply(scope, deactivate)).status, 'ok');
  const concurrent = await Promise.all(candidates.map(activate));
  const results = await Promise.all(concurrent.map((id) => store.apply(scope, id)));
  assert.deepEqual(results.map((r) => r.status).sort(), ['conflict', 'ok']);
  const records = await pool.query(
    "SELECT id,version FROM cos.records WHERE scope_id=$1 AND kind='charter' AND lifecycle='active'",
    [scope],
  );
  assert.equal(records.rowCount, 1);
  assert.equal(records.rows[0].version, 2);
});
