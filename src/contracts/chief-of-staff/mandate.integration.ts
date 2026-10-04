import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { CalendarStore } from '../../modules/chief-of-staff/calendar/store.js';
import { GOOGLE_EVENT_READ_SCOPE } from '../../modules/chief-of-staff/calendar/reader.js';
import { RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import type { MandateChange } from '../../modules/chief-of-staff/contracts/mandate-protocol.js';
import { digest, type ProposalChange, type Result } from '../../modules/chief-of-staff/domain/contracts.js';
import { installReviewedMissionTemplate } from '../../modules/chief-of-staff/missions/template-admin.js';

const scope = 'mandate-' + randomUUID();
const context = { scopeId: scope, ownerId: 'owner', agentGroupId: scope, sessionId: scope, ingressId: randomUUID() };
const binding = {
  ...context,
  instanceId: 'fixture',
  channelId: scope,
  messagingGroupId: 'fixture-messaging',
  botId: 'fixture-bot',
  provider: 'codex' as const,
};
const authority = {
  bindingDigest: digest('private owner-approved fixture binding'),
  delegationDigest: digest('fixture reviewed delegation'),
  contextGeneration: randomUUID(),
  provider: {
    profile: RESEARCH_TEMPLATE.providerProfile,
    model: 'fixture-codex',
    policyDigest: digest('fixture policy'),
  },
};
let enabled = true;
let calendarAccessible = true;
let admin: pg.Client, store: PriorityStore, calendar: CalendarStore, knowledge: KnowledgeStore, base: string;
let change: MandateChange;
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mandate-'));
  for (const dir of ['artifacts', 'staging']) fs.mkdirSync(path.join(base, dir), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(base, 'artifacts'), path.join(base, 'staging')),
    {},
    { calendarAccess: () => calendarAccessible },
  );
  calendar = new CalendarStore(database);
  store = new PriorityStore(database, knowledge, undefined, undefined, (ctx) =>
    enabled &&
    ctx.sessionId === context.sessionId &&
    ctx.ownerId === context.ownerId &&
    ctx.agentGroupId === context.agentGroupId &&
    ctx.scopeId === context.scopeId
      ? authority
      : null,
  );
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'owner','fixture',$1,$1,'active')",
    [scope],
  );
  await admin.query('BEGIN');
  await installReviewedMissionTemplate(admin, binding, randomUUID(), {
    expectedRevision: 0,
    enabled: true,
    templateDigest: digest(RESEARCH_TEMPLATE),
    reviewRef: 'fixture-owner-review',
  });
  await admin.query('COMMIT');
  const calendarId = randomUUID();
  assert.equal(
    (
      await calendar.bind(context, {
        id: calendarId,
        provider: 'fixture',
        calendarIds: ['selected'],
        scopes: [GOOGLE_EVENT_READ_SCOPE],
        timeZone: 'UTC',
        processingProviders: ['codex'],
      })
    ).status,
    'ok',
  );
  const sourceKey = randomUUID();
  fs.writeFileSync(path.join(base, 'staging', sourceKey + '.md'), '# Pilot Alpha\nA private project note.\n', {
    mode: 0o600,
  });
  const source = await knowledge.importSource(context, randomUUID(), {
    sourceKey,
    filename: sourceKey + '.md',
    title: 'Pilot Alpha notes',
    processingProviders: ['codex'],
    expectedVersion: 0,
  });
  assert.equal(source.status, 'ok');
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
  const instant = (offset: number) =>
    new Date(Math.floor((now + offset) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  change = {
    kind: 'standing_mandate',
    mandate_id: null,
    expected_version: 0,
    action: 'activate',
    reason: 'Prepare selected important meetings; do not contact attendees or modify the calendar.',
    definition: {
      title: 'Pilot Alpha meeting preparation',
      purpose: 'Prepare a private briefing using the selected calendar and Pilot Alpha notes.',
      goal_id: null,
      project_id: null,
      source_ids: [String(source.source_id)],
      calendar: { binding_id: calendarId, calendar_ids: ['selected'], event_ids: ['pilot-review'] },
      template: 'meeting_preparation_v1',
      operation: 'prepare_private_briefing',
      trigger: { kind: 'event_approaching', look_ahead_minutes: 1440, max_matches: 1 },
      schedule: {
        state: 'active',
        time_zone: 'UTC',
        local_time: '08:00',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        quiet_hours: { start: '22:00', end: '07:00' },
        snooze_until: null,
      },
      output: 'originating_owner',
      notifications_per_day: 1,
      escalation_rule: null,
      limits: { ...MISSION_DEFAULT_LIMITS },
      budget: {
        max_missions: 2,
        max_attempts: 4,
        max_turns: 8,
        max_tool_calls: 48,
        max_concurrent_workers: 1,
        wall_seconds: 1200,
      },
      starts_at: instant(-60000),
      review_at: instant(86400000),
      expires_at: instant(172800000),
      failure_policy: { max_failures: 2, unknown_usage: 'suspend', missed_occurrences: 'coalesce_latest' },
    },
  };
});
after(async () => {
  if (admin) {
    await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
    await admin.query('UPDATE cos.calendar_states SET current_snapshot=NULL,last_attempt=NULL WHERE scope_id=$1', [
      scope,
    ]);
    for (const table of [
      'mandate_notifications',
      'mandate_native_bindings',
      'mandate_activity',
      'mandate_reservations',
      'mandate_missions',
      'mandate_occurrences',
      'mandate_revisions',
      'mandates',
      'mission_reviews',
      'mission_result_submissions',
      'mission_budget_reservations',
      'mission_attempts',
      'missions',
      'mission_work_orders',
      'mission_context_manifests',
      'mission_template_versions',
      'calendar_event_revisions',
      'calendar_observations',
      'calendar_snapshots',
      'calendar_states',
      'calendar_bindings',
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
    ]) {
      if ((await admin.query('SELECT to_regclass($1) AS name', ['cos.' + table])).rows[0].name)
        await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    }
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
  }
  await store?.database.pool.end();
  await admin?.end();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});
async function propose(input: MandateChange = change): Promise<Result> {
  return store.propose(context, randomUUID(), input as unknown as ProposalChange);
}
async function approve(proposal: Result) {
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
  return store.apply(scope, String(proposal.proposal_id));
}
test('S08-T01/T04 initial standing authority requires the exact private owner approval and creates no work', async () => {
  const id = randomUUID();
  const proposal = await store.propose(context, id, change as unknown as ProposalChange);
  assert.equal(proposal.status, 'ok');
  assert.deepEqual(proposal.change, change);
  assert.deepEqual(await store.propose(context, id, change as unknown as ProposalChange), proposal);
  assert.equal((await store.apply(scope, String(proposal.proposal_id))).status, 'denied');
  assert.equal(
    (
      await store.decide(
        { ...context, ownerId: 'intruder', ingressId: randomUUID() },
        String(proposal.proposal_id),
        String(proposal.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  const applied = await approve(proposal);
  assert.equal(applied.status, 'ok');
  assert.match(String(applied.record_id), /^mandate-[a-f0-9]{64}$/);
  assert.deepEqual(await store.apply(scope, String(proposal.proposal_id)), applied);
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.missions WHERE scope_id=$1', [scope])).rows[0].n,
    0,
  );
  const revisions = (
    await admin.query('SELECT version,body,proposal_id FROM cos.mandate_revisions WHERE scope_id=$1', [scope])
  ).rows;
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].version, 1);
  assert.deepEqual(revisions[0].body.definition, change.definition);
  assert.equal(revisions[0].proposal_id, proposal.proposal_id);
});
test('S08-T01/T04/T10 absent subscription authority, missing sources and broader operations cannot be proposed', async () => {
  enabled = false;
  try {
    assert.equal((await propose()).status, 'denied');
  } finally {
    enabled = true;
  }
  assert.equal(
    (await propose({ ...change, definition: { ...change.definition, source_ids: ['foreign'] } })).status,
    'denied',
  );
  assert.equal(
    (
      await propose({
        ...change,
        definition: { ...change.definition, operation: 'write_calendar' },
      } as unknown as MandateChange)
    ).status,
    'denied',
  );
  assert.equal(
    (await store.propose({ ...context, sessionId: 'foreign' }, randomUUID(), change as unknown as ProposalChange))
      .status,
    'denied',
  );
});
test('S08-T01 a host-local calendar access fence blocks delegation even while cached binding metadata remains ready', async () => {
  calendarAccessible = false;
  try {
    assert.equal((await propose()).status, 'denied');
  } finally {
    calendarAccessible = true;
  }
});
test('S08-T04 approval replay cannot mutate immutable revisions; pause/resume cannot widen the definition', async () => {
  const initial = await propose();
  assert.equal(initial.status, 'ok');
  const activated = await approve(initial);
  const id = String(activated.record_id);
  const first = (
    await admin.query('SELECT * FROM cos.mandate_revisions WHERE scope_id=$1 AND mandate_id=$2', [scope, id])
  ).rows[0];
  const pause: MandateChange = {
    ...change,
    mandate_id: id,
    expected_version: 1,
    action: 'pause',
    reason: 'Pause preparation.',
  };
  assert.equal(
    (await propose({ ...pause, definition: { ...pause.definition, notifications_per_day: 3 } })).status,
    'denied',
  );
  assert.equal((await approve(await propose(pause))).status, 'ok');
  assert.equal((await propose({ ...pause, action: 'resume' })).status, 'denied');
  assert.equal((await approve(await propose({ ...pause, expected_version: 2, action: 'resume' }))).status, 'ok');
  assert.deepEqual(
    (
      await admin.query('SELECT * FROM cos.mandate_revisions WHERE scope_id=$1 AND mandate_id=$2 AND version=1', [
        scope,
        id,
      ])
    ).rows[0],
    first,
  );
  const runtime = await connectFixtureDatabase(process.env, 'runtime');
  try {
    await assert.rejects(
      runtime.query('UPDATE cos.mandate_revisions SET body=$3 WHERE scope_id=$1 AND mandate_id=$2', [
        scope,
        id,
        JSON.stringify({ approved: true }),
      ]),
      (error: any) => error.code === '42501',
    );
  } finally {
    await runtime.end();
  }
  assert.equal((await approve(await propose({ ...pause, expected_version: 3, action: 'revoke' }))).status, 'ok');
  assert.equal((await propose({ ...pause, expected_version: 4, action: 'resume' })).status, 'denied');
});
