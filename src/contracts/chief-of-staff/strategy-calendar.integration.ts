import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { KnowledgeStore, type KnowledgeContext } from '../../modules/chief-of-staff/knowledge/store.js';
import { digest, type ProposalChange } from '../../modules/chief-of-staff/domain/contracts.js';
import { CalendarStore } from '../../modules/chief-of-staff/calendar/store.js';
import { CalendarEvidence } from '../../modules/chief-of-staff/calendar/evidence.js';
import { CalendarView } from '../../modules/chief-of-staff/calendar/view.js';
import { GOOGLE_EVENT_READ_SCOPE } from '../../modules/chief-of-staff/calendar/reader.js';
import { fixtureCalendarReader } from '../../modules/chief-of-staff/calendar/fixture-reader.js';
import { collectCalendarSnapshot } from '../../modules/chief-of-staff/calendar/snapshot.js';
import { ReviewCollector } from '../../modules/chief-of-staff/strategy/collector.js';
import { outcomeStatus, type ReviewSnapshot } from '../../modules/chief-of-staff/strategy/review.js';
import { connectionFault } from './connection-fault.js';

const scope = 'strategy-calendar-' + randomUUID(),
  binding = randomUUID();
const context: KnowledgeContext = {
  scopeId: scope,
  ownerId: 'fixture-owner',
  agentGroupId: scope,
  sessionId: scope,
  ingressId: randomUUID(),
  provider: 'codex',
  generation: randomUUID(),
};
const request = { charter_version: 1, previous_review_id: null },
  identity = { review_id: 'review-' + digest(scope), revision: 1, previous: null };
let admin: pg.Client,
  store: PriorityStore,
  knowledge: KnowledgeStore,
  calendar: CalendarStore,
  view: CalendarView,
  collector: ReviewCollector,
  root: string,
  source: string,
  unselected: string,
  initiative: string;
let open = true,
  window: { timeMin: string; timeMax: string; timeZone: string };
async function approve(change: ProposalChange) {
  const p = await store.propose(context, randomUUID(), change, context);
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
  return applied;
}
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-strategy-calendar-'));
  for (const name of ['staging', 'artifacts']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(root, 'artifacts'), path.join(root, 'staging')),
    {},
    {
      calendarEnabled: () => true,
      calendarAccess: (selectedScope, selectedBinding) =>
        open && selectedScope === scope && selectedBinding === binding,
    },
  );
  store = new PriorityStore(database, knowledge);
  calendar = new CalendarStore(database, {}, new CalendarEvidence(knowledge.artifacts));
  view = new CalendarView({
    store: calendar,
    knowledge,
    enabled: () => true,
    assertOpen: (selectedScope, selectedBinding) => {
      if (!open || selectedScope !== scope || selectedBinding !== binding) throw Error('fixture_calendar_closed');
    },
  });
  collector = new ReviewCollector({ database, knowledge, work: store.work, calendarView: view });
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture',$1,$1,'active')",
    [scope],
  );
  assert.equal(
    (
      await calendar.bind(context, {
        id: binding,
        provider: 'fixture',
        calendarIds: ['selected'],
        scopes: [GOOGLE_EVENT_READ_SCOPE],
        timeZone: 'UTC',
        processingProviders: ['codex'],
      })
    ).status,
    'ok',
  );
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  window = {
    timeMin: new Date(now.getTime() - 86400000).toISOString(),
    timeMax: new Date(now.getTime() + 30 * 86400000).toISOString(),
    timeZone: 'UTC',
  };
  const fixture = fixtureCalendarReader({
    access: { generation: binding + ':1', calendarIds: ['selected'], scopes: [GOOGLE_EVENT_READ_SCOPE], auth: 'ready' },
    calendars: {
      selected: ['meeting', 'unselected'].map((id) => ({
        id,
        etag: 'v1',
        summary: id === 'meeting' ? 'Selected scheduled allocation' : 'UnselectedStrategyCalendarCanary',
        description: 'Synthetic fixture only',
        start: { dateTime: new Date(now.getTime() - 30 * 60000).toISOString() },
        end: { dateTime: new Date(now.getTime() + 30 * 60000).toISOString() },
      })),
    },
  });
  const attempt = randomUUID();
  assert.equal((await calendar.start(context, binding, 'selected', attempt, window)).status, 'ok');
  assert.equal(
    (
      await calendar.publish(
        context,
        binding,
        attempt,
        await collectCalendarSnapshot(fixture.reader, 'selected', window),
      )
    ).status,
    'ok',
  );
  const rows = (
    await admin.query(
      'SELECT source_id,provider_event_id FROM cos.calendar_observations WHERE scope_id=$1 ORDER BY provider_event_id',
      [scope],
    )
  ).rows;
  source = rows.find((r) => r.provider_event_id === 'meeting').source_id;
  unselected = rows.find((r) => r.provider_event_id === 'unselected').source_id;
  assert.equal((await knowledge.recordCalendarContext(context)).status, 'ok');
  initiative = String(
    (
      await approve({
        kind: 'project',
        title: 'Calendar allocation is not effort',
        description: 'Observe a useful result',
        lifecycle: 'active',
        expected_version: 0,
        reason: 'Fixture owner scope',
      })
    ).record_id,
  );
  await approve({
    kind: 'review_charter',
    expected_version: 0,
    reason: 'Review selected allocation',
    definition: {
      title: 'Selected calendar review',
      initiative_ids: [initiative],
      source_ids: [source],
      starts_at: window.timeMin,
      ends_at: window.timeMax,
      cadence: 'manual',
      resource_constraints: 'Six hours a week',
      evidence_limits: 'One selected synthetic calendar observation; outside work is unknown',
      exploration_minutes_per_week: 60,
      measures: [
        { id: 'result', initiative_id: initiative, outcome: 'A useful result', test: 'Observe an actual result' },
      ],
      assumptions: [],
    },
  });
});
after(async () => {
  try {
    if (admin) {
      await admin.query('BEGIN');
      try {
        await admin.query('SET CONSTRAINTS ALL DEFERRED');
        await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
        await admin.query('UPDATE cos.calendar_states SET current_snapshot=NULL,last_attempt=NULL WHERE scope_id=$1', [
          scope,
        ]);
        for (const table of [
          'review_charters',
          'review_charter_revisions',
          'calendar_event_revisions',
          'calendar_observations',
          'calendar_snapshots',
          'calendar_states',
          'calendar_bindings',
          'derivation_links',
          'evidence_refs',
          'chunks',
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
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await store?.database.pool.end();
    await admin?.end();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});
test('S10-T06/T08 selected calendar allocation is cited without exposing or reading unselected event text', async () => {
  const result = await collector.collect(context, request, identity);
  assert.equal(result.status, 'ok');
  const snapshot = result.snapshot as ReviewSnapshot;
  assert.equal(snapshot.calendar_allocations.length, 1);
  assert.equal(snapshot.calendar_allocations[0].source_id, source);
  assert.equal(snapshot.calendar_allocations[0].scheduled_minutes, 60);
  assert.equal(outcomeStatus(snapshot, initiative, 'result'), 'unknown');
  assert.equal(snapshot.observations.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /UnselectedStrategyCalendarCanary/);
  assert.equal(
    (
      await admin.query('SELECT count(*)::int AS n FROM cos.evidence_refs WHERE scope_id=$1 AND source_id=$2', [
        scope,
        unselected,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(store.database.pool.totalCount, store.database.pool.idleCount);
});
test('S10 a required calendar adapter cannot be omitted to claim an empty allocation', async () => {
  const closed = new ReviewCollector({ database: store.database, knowledge, work: store.work });
  const result = await closed.collect(context, request, identity);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.coverage, 'incomplete');
  assert.equal(Object.hasOwn(result, 'snapshot'), false);
});
test('S10-PG01 a real partition between core capture and calendar evidence yields incomplete without disclosing the partial core', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350);
  const remoteKnowledge = new KnowledgeStore(
    database,
    knowledge.artifacts,
    {},
    { calendarEnabled: () => true, calendarAccess: () => open },
  );
  const remoteCalendar = new CalendarStore(database),
    remoteView = new CalendarView({
      store: remoteCalendar,
      knowledge: remoteKnowledge,
      enabled: () => true,
      assertOpen: () => {
        if (!open) throw Error('fixture_calendar_closed');
      },
    });
  let reached = false;
  const remote = new ReviewCollector({
    database,
    knowledge: remoteKnowledge,
    work: store.work,
    calendarView: remoteView,
    hooks: {
      afterCollection: async () => {
        reached = true;
        assert.equal(database.pool.totalCount, database.pool.idleCount);
        relay.partition();
      },
    },
  });
  try {
    const result = await remote.collect(context, request, identity);
    assert.equal(reached, true);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.coverage, 'incomplete');
    for (const field of ['snapshot', 'text', 'version_refs', 'calendar_locations'])
      assert.equal(Object.hasOwn(result, field), false);
    assert.equal(database.pool.totalCount, 0);
  } finally {
    relay.restore();
    await database.pool.end();
    await relay.close();
  }
  assert.equal((await collector.collect(context, request, identity)).status, 'ok');
});
test('S10 incomplete selected calendar coverage remains explicitly limited', async () => {
  const attempt = randomUUID();
  assert.equal((await calendar.start(context, binding, 'selected', attempt, window)).status, 'ok');
  assert.equal((await calendar.fail(context, binding, attempt, 'calendar_unavailable')).status, 'ok');
  context.generation = randomUUID();
  context.ingressId = randomUUID();
  assert.equal((await knowledge.recordCalendarContext(context)).status, 'ok');
  const result = await collector.collect(context, request, identity);
  assert.equal(result.status, 'ok');
  const snapshot = result.snapshot as ReviewSnapshot;
  assert.equal(snapshot.coverage, 'limited');
  assert.equal(snapshot.source_coverage[0].state, 'incomplete');
  assert.equal(snapshot.calendar_allocations[0].scheduled_minutes, 60);
  assert.equal(outcomeStatus(snapshot, initiative, 'result'), 'unknown');
});
test('S10 selected calendar credential withdrawal blocks collection despite retained event bytes', async () => {
  open = false;
  context.generation = randomUUID();
  const result = await collector.collect(context, request, identity);
  assert.equal(result.status, 'denied');
  assert.equal(Object.hasOwn(result, 'snapshot'), false);
});
