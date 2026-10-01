import { connectionFault } from './connection-fault.js';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkStore } from '../../modules/chief-of-staff/store/work.js';
import { CalendarStore } from '../../modules/chief-of-staff/calendar/store.js';
import { CalendarEvidence } from '../../modules/chief-of-staff/calendar/evidence.js';
import { CalendarView } from '../../modules/chief-of-staff/calendar/view.js';
import { fixtureCalendarReader } from '../../modules/chief-of-staff/calendar/fixture-reader.js';
import { collectCalendarSnapshot } from '../../modules/chief-of-staff/calendar/snapshot.js';
import { GOOGLE_EVENT_READ_SCOPE } from '../../modules/chief-of-staff/calendar/reader.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureDatabaseConfig, connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { BriefRunStore } from '../../modules/chief-of-staff/automation/brief-store.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import type { ProposalChange } from '../../modules/chief-of-staff/domain/contracts.js';
import { BriefArtifacts } from '../../modules/chief-of-staff/automation/brief-artifacts.js';
import { BriefCollector } from '../../modules/chief-of-staff/automation/brief-collector.js';
import { BriefDelivery } from '../../modules/chief-of-staff/automation/brief-delivery.js';
import { BriefDispatch } from '../../modules/chief-of-staff/automation/brief-dispatch.js';
import { BriefReconciliation } from '../../modules/chief-of-staff/automation/brief-reconciliation.js';
import { NativeBriefTasks } from '../../modules/chief-of-staff/automation/native-tasks.js';
import { scheduledContext, readScheduledLease } from '../../modules/chief-of-staff/automation/scheduled-origin.js';
import { createRpcHandler } from '../../modules/chief-of-staff/bridge/rpc.js';
import { installCosBoundary, type CosBinding } from '../../cos-boundary.js';
import { initTestDb, closeDb } from '../../db/connection.js';
import { INBOUND_SCHEMA } from '../../db/schema.js';
import type { Session } from '../../types.js';
import Database from 'better-sqlite3';
import type { WorkChange } from '../../modules/chief-of-staff/contracts/protocol.js';
const scope = 'brief-' + randomUUID(),
  context = {
    scopeId: scope,
    ownerId: 'owner',
    agentGroupId: scope,
    sessionId: scope,
    ingressId: randomUUID(),
    provider: 'codex',
    generation: randomUUID(),
  };
let calendarAccess = true;
let admin: pg.Client,
  pool: pg.Pool,
  store: PriorityStore,
  knowledge: KnowledgeStore,
  base: string,
  collector: BriefCollector;
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  pool = new pg.Pool(await fixtureDatabaseConfig());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-brief-fixture-'));
  for (const dir of ['artifacts', 'staging']) fs.mkdirSync(path.join(base, dir), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(base, 'artifacts'), path.join(base, 'staging')),
    {},
    { calendarEnabled: () => true, calendarAccess: () => calendarAccess },
  );
  store = new PriorityStore(database, knowledge);
  await pool.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,$2,'fixture',$1,$1,'active')",
    [scope, context.ownerId],
  );
  collector = new BriefCollector({
    database,
    work: store.work,
    knowledge,
    clock: () => new Date('2026-10-04T01:00:00Z'),
  });
});
after(async () => {
  if (admin) {
    await admin.query('UPDATE cos.calendar_states SET current_snapshot=NULL,last_attempt=NULL WHERE scope_id=$1', [
      scope,
    ]);
    await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
    for (const table of [
      'calendar_event_revisions',
      'calendar_observations',
      'calendar_snapshots',
      'calendar_states',
      'calendar_bindings',
      'brief_notifications',
      'brief_call_reservations',
      'brief_runs',
      'brief_schedule_revisions',
      'brief_schedules',
      'work_revisions',
      'work_items',
      'derivation_links',
      'evidence_refs',
      'chunks',
      'revocation_tombstones',
      'source_revisions',
      'sources',
      'artifacts',
      'outbox',
      'events',
      'operations',
      'proposals',
      'records',
    ])
      await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
  }
  await pool?.end();
  await store?.database.pool.end();
  await admin?.end();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});
const change: WorkChange = {
  kind: 'commitment',
  title: 'Fixture agreed review',
  description: 'Owner confirmed preparation',
  reason: 'Fixture suggestion',
  state: 'confirmed',
  project_id: null,
  due: { kind: 'date', date: '2026-10-04', time_zone: 'Australia/Sydney' },
  defer_until: null,
  evidence: [],
  expected_version: 0,
};
async function approve(c: ProposalChange) {
  const p = await store.propose(context, randomUUID(), c);
  assert.equal(p.status, 'ok');
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(p.proposal_id),
        String(p.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  const applied = await store.apply(scope, String(p.proposal_id));
  assert.equal(applied.status, 'ok');
  return String(applied.record_id);
}
test('S04 brief empty state is useful, scoped, and does not infer a free day', async () => {
  const result = await collector.collect(context, 'Australia/Sydney');
  assert.equal(result.status, 'ok');
  assert.match(String(result.text), /No confirmed commitments/);
  assert.match(String(result.text), /Calendar: unavailable/);
  assert.match(String(result.text), /does not establish that nothing is scheduled/);
  assert.equal((await collector.collect({ ...context, ownerId: 'foreign' }, 'Australia/Sydney')).status, 'denied');
  assert.equal((await collector.collect(context, 'invalid/timezone')).status, 'denied');
});
test('S04 brief uses only approved current work, keeps exact versions, and removes completed commitments', async () => {
  const proposed = await store.propose(context, randomUUID(), { ...change, title: 'Unapproved canary' });
  assert.equal(proposed.status, 'ok');
  const id = await approve(change);
  const before = await collector.collect(context, 'Australia/Sydney');
  assert.equal(before.status, 'ok');
  const snapshot = before.snapshot as any;
  assert.equal(snapshot.commitments[0].id, id);
  assert.equal(snapshot.commitments[0].version, 1);
  assert.equal(snapshot.attention[0].reason, 'due_within_window');
  assert.ok(!JSON.stringify(before).includes('Unapproved canary'));
  await approve({ ...change, record_id: id, expected_version: 1, state: 'completed' });
  const after = await collector.collect(context, 'Australia/Sydney');
  assert.equal(after.status, 'ok');
  assert.deepEqual((after.snapshot as any).commitments, []);
  assert.equal(snapshot.commitments[0].version, 1); // New state cannot mutate the captured object.
});

test('S04 immutable brief artifacts replay their original versions while publication rechecks current work', async () => {
  const id = await approve({ ...change, title: 'Persisted brief canary' });
  const briefs = new BriefArtifacts(collector),
    request = randomUUID();
  const before = await briefs.prepare(context, request, 'Australia/Sydney');
  assert.equal(before.status, 'ok');
  assert.ok(before.artifact_id);
  assert.equal(
    (
      await briefs.prepare(
        { ...context, origin: { kind: 'schedule', runId: 'a'.repeat(64), generation: 1 } },
        randomUUID(),
        'Australia/Sydney',
      )
    ).status,
    'denied',
  );
  const captured = JSON.stringify(before.snapshot);
  assert.equal(
    (await new BriefArtifacts(collector).prepare(context, request, 'Australia/Sydney')).artifact_id,
    before.artifact_id,
  );
  assert.equal((await briefs.prepare(context, request, 'UTC')).status, 'conflict');
  assert.equal((await briefs.get({ ...context, ownerId: 'foreign' }, String(before.artifact_id))).status, 'denied');
  assert.equal((await briefs.authorizePublication(context, String(before.text))).status, 'ok');
  await approve({ ...change, title: 'Changed work canary', record_id: id, expected_version: 1, state: 'completed' });
  const history = await briefs.get({ ...context, generation: randomUUID() }, String(before.artifact_id));
  assert.equal(history.status, 'ok');
  assert.equal(JSON.stringify(history.snapshot), captured);
  assert.equal((await briefs.authorizePublication(context, String(before.text))).status, 'denied');
  assert.equal((await briefs.get(context, String(before.artifact_id), true)).status, 'denied');
  const historical = await briefs.readHistory(context, String(before.artifact_id));
  assert.equal(historical.status, 'ok');
  assert.match(String(historical.text), /^Historical brief/);
  assert.equal((await briefs.authorizePublication(context, String(historical.text))).status, 'ok');
});

test('S04 scheduled brief preparation requires the exact active lease and approved timezone', async () => {
  await approve({
    kind: 'brief_schedule',
    title: 'Fixture morning',
    reason: 'Fixture owner request',
    expected_version: 0,
    policy: {
      state: 'active',
      time_zone: 'UTC',
      local_time: '09:00',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      quiet_hours: null,
      snooze_until: null,
    },
    limits: { max_turns: 2, max_tool_calls: 12, deadline_seconds: 120, refresh_seconds: 0 },
  });
  const clock = new Date(Date.now() + 86400000);
  clock.setUTCHours(9, 0, 0, 0);
  const runs = new BriefRunStore(store.database, { clock: () => clock }),
    reserved = await runs.reserveDue(context);
  assert.equal(reserved.status, 'ok');
  const run = reserved.run as any;
  const lease = await runs.claim(context, run.id, 'fixture-host');
  assert.equal(lease.status, 'ok');
  const scheduled = {
      ...context,
      origin: { kind: 'schedule' as const, runId: run.id, generation: Number(lease.generation) },
      ingressId: `brief:${run.id}:${lease.generation}`,
    },
    briefs = new BriefArtifacts(collector);
  assert.equal((await briefs.prepare(scheduled, randomUUID(), 'Australia/Sydney')).status, 'denied');
  assert.equal(
    (
      await briefs.prepare(
        { ...scheduled, origin: { ...scheduled.origin, generation: scheduled.origin.generation + 1 } },
        randomUUID(),
        'UTC',
      )
    ).status,
    'denied',
  );
  const created = await briefs.prepare(scheduled, randomUUID(), 'UTC');
  assert.equal(created.status, 'ok');
  assert.equal((created.snapshot as any).time_zone, 'UTC');
  const reference = {
    artifact_id: String(created.artifact_id),
    output_digest: digest(String(created.text)),
    context_generation: scheduled.generation,
    provider: scheduled.provider,
  };
  assert.equal(
    (await runs.prepare(context, run.id, Number(lease.generation), { ...reference, output_digest: '0'.repeat(64) }))
      .status,
    'denied',
  );
  assert.equal((await runs.prepare(context, run.id, Number(lease.generation), reference)).status, 'ok');
  assert.equal((await runs.prepare(context, run.id, Number(lease.generation), reference)).status, 'ok');
  const persisted = (
    await pool.query('SELECT snapshot,state FROM cos.brief_runs WHERE scope_id=$1 AND id=$2', [scope, run.id])
  ).rows[0];
  assert.equal(persisted.state, 'prepared');
  assert.deepEqual(persisted.snapshot, reference);
  assert.ok(!JSON.stringify(persisted).includes('CoS brief'));
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () => runs.beginDelivery(context, run.id, Number(lease.generation), randomUUID())),
  );
  const admitted = attempts.filter((x) => x.status === 'ok');
  assert.equal(admitted.length, 1);
  const delivery = admitted[0];
  assert.equal(
    (await runs.deliveryCurrent(context, run.id, Number(lease.generation), String(delivery.attempt_id))).status,
    'ok',
  );
  assert.equal((await runs.cancel(context, run.id, Number(lease.generation))).status, 'ok');
  assert.equal(
    (await runs.deliveryCurrent(context, run.id, Number(lease.generation), String(delivery.attempt_id))).status,
    'denied',
  );
  assert.equal(
    (await pool.query('SELECT state FROM cos.brief_notifications WHERE scope_id=$1 AND run_id=$2', [scope, run.id]))
      .rows[0].state,
    'uncertain',
  );
  // A late verified platform receipt records the actual effect even after owner cancellation.
  const delivered = { state: 'delivered' as const, platform_receipt: 'fixture-post-id' };
  assert.equal(
    (await runs.finishDelivery(context, run.id, Number(lease.generation), String(delivery.attempt_id), delivered))
      .status,
    'ok',
  );
  assert.equal(
    (await runs.finishDelivery(context, run.id, Number(lease.generation), String(delivery.attempt_id), delivered))
      .status,
    'ok',
  );
  assert.equal(
    (
      await runs.finishDelivery(context, run.id, Number(lease.generation), String(delivery.attempt_id), {
        state: 'uncertain',
      })
    ).status,
    'denied',
  );
  assert.equal((await runs.beginDelivery(context, run.id, Number(lease.generation), randomUUID())).status, 'denied');
  assert.equal(
    (
      await pool.query('SELECT state,receipt FROM cos.brief_notifications WHERE scope_id=$1 AND run_id=$2', [
        scope,
        run.id,
      ])
    ).rows[0].receipt.platform_receipt,
    'fixture-post-id',
  );
  assert.equal((await briefs.prepare(scheduled, randomUUID(), 'UTC')).status, 'denied');
});

async function nextPreparedBrief() {
  const day = (
    await pool.query('SELECT last_local_date::text AS day FROM cos.brief_schedules WHERE scope_id=$1', [scope])
  ).rows[0].day;
  const clock = new Date(day + 'T09:00:00Z');
  clock.setUTCDate(clock.getUTCDate() + 1);
  const runs = new BriefRunStore(store.database, { clock: () => clock });
  const reserved = await runs.reserveDue(context);
  assert.equal(reserved.status, 'ok');
  const run = reserved.run as any;
  const lease = await runs.claim(context, run.id, 'fixture-host');
  assert.equal(lease.status, 'ok');
  const scheduled = {
    ...context,
    generation: randomUUID(),
    origin: { kind: 'schedule' as const, runId: run.id, generation: Number(lease.generation) },
    ingressId: `brief:${run.id}:${lease.generation}`,
  };
  const artifacts = new BriefArtifacts(collector);
  const artifact = await artifacts.prepare(scheduled, randomUUID(), 'UTC');
  assert.equal(artifact.status, 'ok');
  assert.equal(
    (
      await runs.prepare(scheduled, run.id, scheduled.origin.generation, {
        artifact_id: String(artifact.artifact_id),
        output_digest: digest(artifact.text),
        context_generation: scheduled.generation,
        provider: scheduled.provider,
      })
    ).status,
    'ok',
  );
  return { runs, run, scheduled, artifacts };
}

test('S04 lost delivery-start acknowledgement cannot authorize a send after restart', async () => {
  const f = await nextPreparedBrief();
  const faultyPool = new pg.Pool(await fixtureDatabaseConfig()),
    client = await faultyPool.connect(),
    original = client.query.bind(client);
  let started = false,
    dropped = false;
  client.query = (async (...args: unknown[]) => {
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    if (typeof args[0] === 'string' && args[0].includes("SET state='delivering'")) started = true;
    if (args[0] === 'COMMIT' && started && !dropped) {
      dropped = true;
      throw Error('fixture_lost_delivery_start_ack');
    }
    return result;
  }) as typeof client.query;
  client.release();
  try {
    const attempt = randomUUID();
    assert.equal(
      (
        await new BriefRunStore(new BoundedDatabase(faultyPool)).beginDelivery(
          f.scheduled,
          f.run.id,
          f.scheduled.origin.generation,
          attempt,
        )
      ).status,
      'pending',
    );
    const restarted = new BriefRunStore(store.database);
    assert.equal(
      (await restarted.beginDelivery(f.scheduled, f.run.id, f.scheduled.origin.generation, attempt)).status,
      'denied',
    );
    assert.equal(
      (await restarted.beginDelivery(f.scheduled, f.run.id, f.scheduled.origin.generation, randomUUID())).status,
      'denied',
    );
    assert.equal(((await restarted.inspect(f.scheduled, f.run.id)).notification as any).state, 'delivering');
    // Startup reconciliation consumes the orphaned delivery fence; it never retries the post.
    assert.equal(
      (
        await restarted.finishDelivery(f.scheduled, f.run.id, f.scheduled.origin.generation, attempt, {
          state: 'uncertain',
        })
      ).status,
      'ok',
    );
    assert.equal(((await restarted.inspect(f.scheduled, f.run.id)).run as any).state, 'uncertain');
  } finally {
    await faultyPool.end();
  }
});

test('S04 checked notifications record delivery or ambiguity once and deny changed private membership', async () => {
  for (const mode of ['delivered', 'uncertain', 'revoked']) {
    const f = await nextPreparedBrief();
    let calls = 0;
    const delivery = new BriefDelivery({
      runs: f.runs,
      artifacts: f.artifacts,
      current: () => f.scheduled,
      admitted: async () => mode !== 'revoked',
      send: async (_context, text, id) => {
        calls++;
        assert.equal(id, 'brief-' + f.run.id);
        assert.match(text, /CoS brief/);
        if (mode === 'uncertain') throw Error('fixture accepted then connection lost');
        return 'fixture-confirmed-post';
      },
    });
    const sent = await delivery.deliver(f.scheduled);
    assert.equal(sent.status, 'ok');
    assert.equal(sent.state, mode === 'revoked' ? 'failed' : mode);
    await delivery.deliver(f.scheduled);
    assert.equal(calls, mode === 'revoked' ? 0 : 1);
    const notification = (await new BriefRunStore(store.database).inspect(f.scheduled, f.run.id)).notification as any;
    assert.equal(notification.state, sent.state);
    assert.ok(!JSON.stringify(notification).includes('CoS brief'));
  }
});

test('S04 brief persistence reconciles a lost commit acknowledgement and blocks on a real database partition', async () => {
  const fixtureContext = { ...context, generation: randomUUID() },
    request = randomUUID();
  const faultyPool = new pg.Pool(await fixtureDatabaseConfig()),
    client = await faultyPool.connect(),
    original = client.query.bind(client);
  let inserted = false,
    dropped = false;
  client.query = (async (...args: unknown[]) => {
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    if (typeof args[0] === 'string' && args[0].includes('INSERT INTO cos.artifacts')) inserted = true;
    if (args[0] === 'COMMIT' && inserted && !dropped) {
      dropped = true;
      throw Error('fixture_lost_brief_commit_ack');
    }
    return result;
  }) as typeof client.query;
  client.release();
  const make = (database: BoundedDatabase) => {
    const k = new KnowledgeStore(
      database,
      knowledge.artifacts,
      {},
      { calendarEnabled: () => true, calendarAccess: () => calendarAccess },
    );
    return new BriefArtifacts(
      new BriefCollector({ database, knowledge: k, work: new WorkStore(k), clock: collector.options.clock }),
    );
  };
  try {
    assert.equal(
      (await make(new BoundedDatabase(faultyPool)).prepare(fixtureContext, request, 'UTC')).status,
      'pending',
    );
    const recovered = await new BriefArtifacts(collector).prepare(fixtureContext, request, 'UTC');
    assert.equal(recovered.status, 'ok');
    assert.equal(
      (await new BriefArtifacts(collector).prepare(fixtureContext, request, 'UTC')).artifact_id,
      recovered.artifact_id,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM cos.operations WHERE session_id=$1 AND request_id=$2', [
          scope,
          request,
        ])
      ).rows[0].n,
      1,
    );
  } finally {
    await faultyPool.end();
  }
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350);
  try {
    await database.run((c) => c.query('SELECT 1'));
    relay.partition();
    const files = fs.readdirSync(path.join(base, 'artifacts')).sort(),
      briefs = make(database),
      next = randomUUID(),
      fresh = { ...context, generation: randomUUID() };
    assert.ok(['pending', 'unavailable'].includes((await briefs.prepare(fresh, next, 'UTC')).status));
    assert.deepEqual(fs.readdirSync(path.join(base, 'artifacts')).sort(), files);
    relay.restore();
    await delay(1100);
    assert.equal((await briefs.prepare(fresh, next, 'UTC')).status, 'ok');
  } finally {
    await database.pool.end();
    await relay.close();
  }
});

test('S04 recurring fixture: approved schedule, native restart, checked briefs and confirmed commitment resolution', async () => {
  const db = initTestDb(),
    inbound = new Database(':memory:');
  inbound.exec(INBOUND_SCHEMA);
  const binding: CosBinding = {
    scopeId: scope,
    ownerId: context.ownerId,
    sessionId: scope,
    agentGroupId: scope,
    messagingGroupId: 'fixture-mg',
    instanceId: 'fixture',
    channelId: scope,
    botId: 'fixture-bot',
    provider: 'codex',
  };
  const session = {
    id: scope,
    agent_group_id: scope,
    messaging_group_id: 'fixture-mg',
    thread_id: null,
    status: 'active',
    agent_provider: 'codex',
  } as Session;
  installCosBoundary(binding, db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?').run(context.ingressId);
  const schedule = (await pool.query('SELECT * FROM cos.brief_schedules WHERE scope_id=$1', [scope])).rows[0];
  await approve({
    kind: 'brief_schedule',
    record_id: schedule.id,
    title: 'Fixture recurring brief',
    expected_version: schedule.version,
    reason: 'Fixture recurring demonstration',
    policy: schedule.policy,
    limits: schedule.limits,
  });
  const date = (
    await pool.query('SELECT last_local_date::text AS day FROM cos.brief_schedules WHERE scope_id=$1', [scope])
  ).rows[0].day;
  const clock = new Date(date + 'T09:00:00Z');
  clock.setUTCDate(clock.getUTCDate() + 1);
  const runs = new BriefRunStore(store.database, { clock: () => clock });
  const artifacts = new BriefArtifacts(new BriefCollector({ ...collector.options, clock: () => clock }));
  const tasks = new NativeBriefTasks(inbound);
  const local = () => {
    const c = scheduledContext(session, db);
    return c ? { ...c, provider: 'codex', generation: context.generation } : null;
  };
  let wakes = 0;
  const dispatchOptions = {
    db,
    runs,
    session: () => session,
    admitted: async () => true,
    running: () => false,
    withTasks: async <T>(_session: Session, op: (tasks: NativeBriefTasks) => Promise<T>) => op(tasks),
    prepare: async () => true,
    wake: async () => {
      wakes++;
    },
  };
  const sent: Array<{ text: string; id: string }> = [];
  const delivery = new BriefDelivery({
    runs,
    artifacts,
    current: local,
    admitted: async () => true,
    send: async (_context, text, id) => {
      sent.push({ text, id });
      return 'fixture-post-' + sent.length;
    },
  });
  const recoveryOptions = {
    db,
    runs,
    local,
    admitted: async () => true,
    running: () => false,
    stop: () => {},
    retire: (b: CosBinding, r: Parameters<NativeBriefTasks['retire']>[1]) => tasks.retire(b, r),
    taskState: (b: CosBinding, r: Parameters<NativeBriefTasks['state']>[1]) => tasks.state(b, r),
    deliver: (c: Parameters<BriefDelivery['deliver']>[0]) => delivery.deliver(c),
  };
  const rpcStore = new PriorityStore(store.database, knowledge);
  // Keep fixture clock and artifact publication identical to the sender's collector.
  rpcStore.briefArtifacts!.collector.options.clock = () => clock;
  const handler = createRpcHandler({
    store: rpcStore,
    knowledge,
    resolveContext: async () => scheduledContext(session, db) ?? null,
    resolveKnowledgeContext: async () => local(),
    reserveTool: (c, id) => runs.reserveCall(c, c.origin!.runId, c.origin!.generation, 'tool', id),
  });
  let commitment = '';
  try {
    const relay = await connectionFault(await fixtureDatabaseConfig());
    const partitioned = new BoundedDatabase(new pg.Pool(relay.config), 350);
    try {
      await partitioned.run((c) => c.query('SELECT 1'));
      relay.partition();
      const denied = await new BriefDispatch({
        ...dispatchOptions,
        runs: new BriefRunStore(partitioned, { clock: () => clock }),
      }).drain(binding);
      assert.ok(['pending', 'unavailable'].includes(denied.status));
      assert.equal(readScheduledLease(db, binding), null);
      assert.equal(wakes, 0);
      assert.deepEqual(inbound.prepare('SELECT id FROM messages_in').all(), []);
    } finally {
      relay.restore();
      await partitioned.pool.end();
      await relay.close();
    }
    const lostPool = new pg.Pool(await fixtureDatabaseConfig()),
      lostClient = await lostPool.connect(),
      original = lostClient.query.bind(lostClient);
    let claimed = false,
      dropped = false;
    lostClient.query = (async (...args: unknown[]) => {
      const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
      if (typeof args[0] === 'string' && args[0].includes("SET state='dispatched'")) claimed = true;
      if (args[0] === 'COMMIT' && claimed && !dropped) {
        dropped = true;
        throw Error('fixture_lost_dispatch_claim_ack');
      }
      return result;
    }) as typeof lostClient.query;
    lostClient.release();
    try {
      assert.equal(
        (
          await new BriefDispatch({
            ...dispatchOptions,
            runs: new BriefRunStore(new BoundedDatabase(lostPool), { clock: () => clock }),
          }).drain(binding)
        ).status,
        'pending',
      );
      assert.equal(readScheduledLease(db, binding), null);
      assert.equal(wakes, 0);
      assert.deepEqual(inbound.prepare('SELECT id FROM messages_in').all(), []);
    } finally {
      await lostPool.end();
    }
    for (let morning = 0; morning < 3; morning++) {
      assert.equal((await new BriefDispatch(dispatchOptions).drain(binding)).status, 'ok');
      const lease = readScheduledLease(db, binding)!;
      assert.ok(lease);
      // Reconstruct host scheduling after dispatch, preserving the native retry and durable generation.
      inbound.prepare('UPDATE messages_in SET tries=1 WHERE id=?').run('cos-brief-' + lease.runId);
      assert.equal((await new BriefDispatch(dispatchOptions).drain(binding)).status, 'ok');
      assert.deepEqual(readScheduledLease(db, binding), lease);
      assert.equal(
        (
          inbound.prepare('SELECT tries FROM messages_in WHERE id=?').get('cos-brief-' + lease.runId) as {
            tries: number;
          }
        ).tries,
        1,
      );
      const native = local()!;
      assert.equal((await runs.reserveCall(native, lease.runId, lease.generation, 'model', randomUUID())).status, 'ok');
      const request = {
        protocol: 'cos-rpc/v1',
        request_id: randomUUID(),
        method: 'cos_brief_request',
        params: { time_zone: 'UTC' },
      };
      await handler({ action: 'cos_rpc', delivery_id: randomUUID(), request }, session, inbound);
      const response = JSON.parse(
        (
          inbound.prepare('SELECT response FROM cos_rpc_responses WHERE request_id=?').get(request.request_id) as {
            response: string;
          }
        ).response,
      );
      assert.equal(response.status, 'ok');
      const before = (await runs.inspect(native, lease.runId)).run as {
        model_calls: number;
        tool_calls: number;
        state: string;
      };
      assert.deepEqual(
        { model: before.model_calls, tool: before.tool_calls, state: before.state },
        { model: 1, tool: 1, state: 'prepared' },
      );
      const recovery = new BriefReconciliation(recoveryOptions);
      assert.equal((await recovery.drain(binding)).status, 'ok');
      assert.equal((await recovery.drain(binding)).status, 'ok');
      assert.equal(readScheduledLease(db, binding), null);
      assert.equal((await new BriefDispatch(dispatchOptions).drain(binding)).state, 'not_due');
      assert.equal(sent.length, morning + 1);
      if (morning === 1) assert.ok(sent[morning].text.includes('Recurring fixture commitment'));
      else assert.ok(!sent[morning].text.includes('Recurring fixture commitment'));
      assert.match(sent[morning].text, /Calendar: unavailable/);
      if (morning === 0) commitment = await approve({ ...change, title: 'Recurring fixture commitment' });
      if (morning === 1)
        await approve({
          ...change,
          title: 'Recurring fixture commitment',
          record_id: commitment,
          expected_version: 1,
          state: 'completed',
        });
      clock.setUTCDate(clock.getUTCDate() + 1);
    }
    assert.equal(new Set(sent.map((x) => x.id)).size, 3);
    assert.equal(wakes, 6); // Repeated native wakes reuse three runs and their original reservations.
  } finally {
    inbound.close();
    closeDb();
  }
});

test('S04-T07 collects cited calendar snapshots with visible staleness and denies revocation during disclosure', async () => {
  const calendar = new CalendarStore(store.database, {}, new CalendarEvidence(knowledge.artifacts));
  const binding = randomUUID(),
    snapshotId = randomUUID(),
    window = { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-10T00:00:00Z', timeZone: 'Australia/Sydney' };
  assert.equal(
    (
      await calendar.bind(context, {
        id: binding,
        provider: 'fixture',
        calendarIds: ['selected'],
        scopes: [GOOGLE_EVENT_READ_SCOPE],
        timeZone: window.timeZone,
        processingProviders: ['codex'],
      })
    ).status,
    'ok',
  );
  const fixture = fixtureCalendarReader({
    access: { generation: binding + ':1', calendarIds: ['selected'], scopes: [GOOGLE_EVENT_READ_SCOPE], auth: 'ready' },
    calendars: {
      selected: [
        {
          id: 'meeting',
          etag: 'v1',
          summary: 'Brief calendar canary',
          description: 'PRIVATE_LONG_DESCRIPTION',
          start: { date: '2026-10-04' },
          end: { date: '2026-10-05' },
        },
      ],
    },
  });
  assert.equal((await calendar.start(context, binding, 'selected', snapshotId, window)).status, 'ok');
  assert.equal(
    (
      await calendar.publish(
        context,
        binding,
        snapshotId,
        await collectCalendarSnapshot(fixture.reader, 'selected', window),
      )
    ).status,
    'ok',
  );
  const view = new CalendarView({
    store: calendar,
    knowledge,
    enabled: () => true,
    assertOpen: () => {
      if (!calendarAccess) throw Error('fixture revoked');
    },
  });
  const briefs = new BriefCollector({ ...collector.options, calendarView: view });
  const briefArtifacts = new BriefArtifacts(briefs);
  const saved = await briefArtifacts.prepare(
    { ...context, generation: randomUUID() },
    randomUUID(),
    'Australia/Sydney',
  );
  assert.equal(saved.status, 'ok');
  const result = await briefs.collect({ ...context, generation: randomUUID() }, 'Australia/Sydney');
  assert.equal(result.status, 'ok');
  const snapshot = result.snapshot as any;
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].summary, 'Brief calendar canary');
  assert.equal(snapshot.events[0].snapshot_id, snapshotId);
  assert.equal(snapshot.coverage.calendar, 'stale');
  assert.equal(snapshot.calendar_coverage[0].snapshot_id, snapshotId);
  assert.ok(snapshot.calendar_coverage[0].last_success_at);
  assert.match(String(result.text), /Last successful refresh/);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_LONG_DESCRIPTION'));
  knowledge.hooks.beforeDisclosure = async () => {
    calendarAccess = false;
  };
  assert.equal((await briefs.collect({ ...context, generation: randomUUID() }, 'Australia/Sydney')).status, 'denied');
  knowledge.hooks.beforeDisclosure = undefined;
  assert.equal(
    (await briefArtifacts.get({ ...context, generation: randomUUID() }, String(saved.artifact_id))).status,
    'denied',
  );
  const denied = await briefs.collect({ ...context, generation: randomUUID() }, 'Australia/Sydney');
  assert.equal(denied.status, 'ok');
  assert.deepEqual((denied.snapshot as any).events, []);
  assert.equal((denied.snapshot as any).coverage.calendar, 'unavailable');
  calendarAccess = true;
  const source = (await pool.query('SELECT id,version FROM cos.sources WHERE scope_id=$1', [scope])).rows[0];
  const proposal = await store.propose(context, randomUUID(), {
    kind: 'source_delete',
    source_id: source.id,
    expected_version: source.version,
    reason: 'Fixture retention test',
  });
  assert.equal(proposal.status, 'ok');
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
  assert.equal((await store.apply(scope, String(proposal.proposal_id))).status, 'ok');
  assert.equal(
    (await briefArtifacts.get({ ...context, generation: randomUUID() }, String(saved.artifact_id))).status,
    'denied',
  );
  await admin.query(
    "UPDATE cos.revocation_tombstones SET purge_after=clock_timestamp()-interval '1 second' WHERE scope_id=$1",
    [scope],
  );
  // This store fixture has no native provider history; its cleanup hook has no local files to remove.
  knowledge.hooks.purgeContexts = async () => ({ status: 'ok' });
  assert.equal((await knowledge.purgeDue(scope)).status, 'ok');
  const metadata = (
    await pool.query('SELECT digest,lifecycle FROM cos.artifacts WHERE scope_id=$1 AND id=$2', [
      scope,
      saved.artifact_id,
    ])
  ).rows[0];
  assert.equal(metadata.lifecycle, 'deleted');
  assert.throws(() => knowledge.artifacts.read(String(saved.artifact_id), metadata.digest));
});
