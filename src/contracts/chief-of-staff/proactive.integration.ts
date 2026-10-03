import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate, SCHEMA_VERSION } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import type { Context } from '../../modules/chief-of-staff/domain/contracts.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { ProactiveStore } from '../../modules/chief-of-staff/automation/proactive-store.js';
import { BriefCollector } from '../../modules/chief-of-staff/automation/brief-collector.js';
import type { ProactiveDraft } from '../../modules/chief-of-staff/contracts/proactive-protocol.js';
import type { ProactiveCandidate } from '../../modules/chief-of-staff/automation/proactive-policy.js';
import { connectionFault } from './connection-fault.js';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
const scope = 'proactive-fixture-' + randomUUID();
const context: Context = {
  scopeId: scope,
  ownerId: 'fixture-owner',
  sessionId: scope,
  agentGroupId: scope,
  ingressId: randomUUID(),
};
const retained = { ...context, provider: 'codex', generation: randomUUID() };
let delegationEnabled = false;
const authority = {
  bindingDigest: digest('fixture private binding'),
  delegationDigest: digest('fixture approved delegation'),
  contextGeneration: retained.generation,
  provider: {
    profile: RESEARCH_TEMPLATE.providerProfile,
    model: 'fixture-codex',
    policyDigest: digest('fixture confined policy'),
  },
};
let fixtureGoal: string,
  fixtureProject: string,
  fixtureWork: string,
  workVersion = 2;
let base: string,
  knowledge: KnowledgeStore,
  now = new Date();
let admin: pg.Client, pool: pg.Pool, store: PriorityStore;
const policy = {
  due_horizon_hours: 48,
  no_update_days: null,
  max_candidates: 3,
  max_proposals: 2,
  notifications_per_day: 1,
  time_zone: 'Australia/Sydney',
  quiet_hours: null,
  urgent_rule: null,
};
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  assert.equal(await migrate(admin, fixtureRuntimeUser()), SCHEMA_VERSION);
  pool = new pg.Pool(await fixtureDatabaseConfig());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-proactive-fixture-'));
  for (const dir of ['artifacts', 'staging']) fs.mkdirSync(path.join(base, dir), { mode: 0o700 });
  const database = new BoundedDatabase(pool);
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(base, 'artifacts'), path.join(base, 'staging')),
  );
  store = new PriorityStore(database, knowledge, undefined, undefined, () => (delegationEnabled ? authority : null));
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,$2,'fixture',$1,$1,'active')",
    [scope, context.ownerId],
  );
});
after(async () => {
  if (admin) {
    await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
    for (const table of [
      'proactive_notifications',
      'proactive_feedback',
      'proactive_revisions',
      'proactive_suggestions',
      'proactive_batches',
      'proactive_observations',
      'proactive_policy_revisions',
      'proactive_policies',
      'mission_reviews',
      'mission_result_submissions',
      'mission_budget_reservations',
      'mission_attempts',
      'missions',
      'mission_work_orders',
      'mission_context_manifests',
      'mission_template_versions',
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
      if ((await admin.query('SELECT to_regclass($1) AS present', ['cos.' + table])).rows[0].present)
        await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
  }
  await pool?.end();
  await admin?.end();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});
async function approve(change: Parameters<PriorityStore['propose']>[2]) {
  const result = await store.propose(context, randomUUID(), change, retained);
  assert.equal(result.status, 'ok');
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(result.proposal_id),
        String(result.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  const applied = await store.apply(scope, String(result.proposal_id));
  assert.equal(applied.status, 'ok');
  return String(applied.record_id);
}
function proactive(database = store.database) {
  return new ProactiveStore({
    database,
    knowledge,
    collector: new BriefCollector({ database, knowledge, work: store.work, clock: () => now }),
    missions: store.missions,
  });
}
function draft(candidate: ProactiveCandidate, goal: string): ProactiveDraft {
  return {
    candidate_key: candidate.semantic_key,
    title: 'Review the milestone risk',
    purpose: 'Clarify the remaining obstacle',
    goal_id: goal,
    recommendation: 'question',
    action_class: 'clarification',
    confidence: 'medium',
    uncertainty: 'Some work may not be visible',
    expected_benefit: 'Avoid an unnecessary investigation',
    estimated_effort: { minutes: 15, assumptions: 'One owner clarification' },
    opportunity_cost: 'Displaces another review',
    permission_requirements: ['owner_approval'],
    work_order: null,
    review_at: new Date(now.getTime() + 3600000)
      .toISOString()
      .replace('.000Z', 'Z')
      .replace(/\.\d{3}Z$/, 'Z'),
    expires_at: new Date(now.getTime() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}
test('S07-T07/T09 proactive configuration requires exact owner approval and cannot rewrite goals', async () => {
  const change = {
    kind: 'proactive_policy' as const,
    state: 'active' as const,
    policy,
    expected_version: 0,
    reason: 'Fixture owner limits',
  };
  const proposed = await store.propose(context, randomUUID(), change);
  assert.equal(proposed.status, 'ok');
  assert.equal((await pool.query('SELECT * FROM cos.proactive_policies WHERE scope_id=$1', [scope])).rowCount, 0);
  assert.equal(
    (
      await store.decide(
        { ...context, ownerId: 'foreign' },
        String(proposed.proposal_id),
        String(proposed.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(proposed.proposal_id),
        String(proposed.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  assert.equal((await store.apply(scope, String(proposed.proposal_id))).status, 'ok');
  assert.equal((await store.apply(scope, String(proposed.proposal_id))).status, 'ok');
  const row = (await pool.query('SELECT * FROM cos.proactive_policies WHERE scope_id=$1', [scope])).rows[0];
  assert.equal(row.version, 1);
  assert.deepEqual(row.policy, policy);
  assert.equal((await pool.query('SELECT * FROM cos.records WHERE scope_id=$1', [scope])).rowCount, 0);
  const stale = await store.propose(context, randomUUID(), { ...change, reason: 'Stale competing policy' });
  assert.equal(stale.status, 'denied');
});
test('S07-T01/T07 runtime cannot rewrite host observations, proposal revisions, owner feedback or budget receipts', async () => {
  for (const table of [
    'proactive_observations',
    'proactive_revisions',
    'proactive_feedback',
    'proactive_notifications',
    'proactive_policy_revisions',
  ]) {
    const p = (
      await pool.query(
        "SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'UPDATE') AS update,has_table_privilege(current_user,$1,'DELETE') AS delete,has_table_privilege(current_user,$1,'TRUNCATE') AS truncate",
        ['cos.' + table],
      )
    ).rows[0];
    assert.deepEqual(p, { read: true, insert: true, update: false, delete: false, truncate: false });
  }
});
test('S07-T01/T03/T04 bounded batches deduplicate wording and owner dismissal survives replay', async () => {
  const goal = await approve({
    kind: 'goal',
    title: 'Deliver the fixture pilot',
    description: 'Approved direction',
    lifecycle: 'active',
    reason: 'Fixture owner',
    expected_version: 0,
  });
  const project = await approve({
    kind: 'project',
    title: 'Fixture pilot',
    description: 'Active project',
    lifecycle: 'active',
    reason: 'Fixture owner',
    expected_version: 0,
  });
  const work = await approve({
    kind: 'commitment',
    title: 'Confirmed milestone',
    description: 'Due soon',
    reason: 'Fixture owner',
    state: 'confirmed',
    project_id: project,
    due: {
      kind: 'instant',
      at: new Date(now.getTime() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      time_zone: 'Australia/Sydney',
    },
    defer_until: null,
    evidence: [],
    expected_version: 0,
  });
  fixtureGoal = goal;
  fixtureProject = project;
  fixtureWork = work;
  const p = proactive(),
    request = randomUUID(),
    batch = await p.batch(retained, request);
  assert.equal(batch.status, 'ok');
  assert.equal((batch.candidates as ProactiveCandidate[]).length, 1);
  assert.deepEqual(await p.batch(retained, request), batch);
  assert.equal((await pool.query('SELECT * FROM cos.proactive_observations WHERE scope_id=$1', [scope])).rowCount, 1);
  const candidate = (batch.candidates as ProactiveCandidate[])[0];
  const input = draft(candidate, goal),
    recommendation = await p.submit(retained, randomUUID(), String(batch.batch_id), input);
  assert.equal(recommendation.status, 'ok');
  const repeated = await p.submit(retained, randomUUID(), String(batch.batch_id), {
    ...input,
    title: 'Incidental different wording',
  });
  assert.equal(repeated.status, 'ok');
  assert.equal(repeated.suggestion_id, recommendation.suggestion_id);
  assert.equal((await pool.query('SELECT * FROM cos.missions WHERE scope_id=$1', [scope])).rowCount, 0);
  const disposition = {
    suggestion_id: String(recommendation.suggestion_id),
    expected_version: 1,
    decision: 'dismiss' as const,
    review_at: null,
    reason: 'Already handled',
    usefulness: 'not_useful' as const,
    review_seconds: 12,
  };
  const preview = await store.requestProactiveDisposition(retained, randomUUID(), disposition);
  assert.equal(preview.status, 'ok');
  const owner = { ...context, ingressId: randomUUID() };
  assert.equal(
    (await store.decide(owner, String(preview.proposal_id), String(preview.confirmation_token), 'approve')).status,
    'ok',
  );
  assert.equal((await store.apply(scope, String(preview.proposal_id))).status, 'ok');
  assert.equal((await store.apply(scope, String(preview.proposal_id))).status, 'ok');
  assert.equal((await pool.query('SELECT * FROM cos.proactive_feedback WHERE scope_id=$1', [scope])).rowCount, 1);
  const replay = await proactive().batch(retained, randomUUID());
  assert.equal(replay.status, 'ok');
  assert.deepEqual(replay.candidates, []);
  assert.equal((await pool.query('SELECT count(*)::int n FROM cos.records WHERE scope_id=$1', [scope])).rows[0].n, 2);
  // Material state change permits a linked proposal; changing its title alone does not.
  await approve({
    kind: 'commitment',
    record_id: work,
    expected_version: 1,
    title: 'Cosmetic new title',
    description: 'Due soon',
    reason: 'Fixture owner',
    state: 'confirmed',
    project_id: project,
    due: {
      kind: 'instant',
      at: new Date(now.getTime() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      time_zone: 'Australia/Sydney',
    },
    defer_until: null,
    evidence: [],
  });
  assert.deepEqual((await p.batch(retained, randomUUID())).candidates, []);
});
async function nextSuggestion(transform: (input: ProactiveDraft) => ProactiveDraft = (v) => v) {
  now = new Date();
  await approve({
    kind: 'commitment',
    record_id: fixtureWork,
    expected_version: workVersion++,
    title: 'Confirmed milestone',
    description: 'Updated due time',
    reason: 'Fixture owner changed due time',
    state: 'confirmed',
    project_id: fixtureProject,
    due: {
      kind: 'instant',
      at: new Date(now.getTime() + workVersion * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      time_zone: 'Australia/Sydney',
    },
    defer_until: null,
    evidence: [],
  });
  const p = proactive(),
    batch = await p.batch(retained, randomUUID());
  assert.equal(batch.status, 'ok');
  const candidate = (batch.candidates as ProactiveCandidate[]).find((c) => c.target_id === fixtureWork)!;
  assert.ok(candidate);
  const input = transform(draft(candidate, fixtureGoal)),
    request = randomUUID();
  const result = await p.submit(retained, request, String(batch.batch_id), input);
  assert.equal(result.status, 'ok');
  return { p, batch, input, request, result };
}
test('S07-T01/T05/T10 submission receipts bind exact payload and reject changed approved goals', async () => {
  const { p, batch, input, request, result } = await nextSuggestion();
  assert.equal(
    (await p.submit(retained, request, String(batch.batch_id), { ...input, purpose: 'A changed payload' })).status,
    'conflict',
  );
  assert.deepEqual(await p.submit(retained, request, String(batch.batch_id), input), result);
  const goal = (await pool.query('SELECT * FROM cos.records WHERE scope_id=$1 AND id=$2', [scope, fixtureGoal]))
    .rows[0];
  await approve({
    kind: 'goal',
    record_id: fixtureGoal,
    expected_version: goal.version,
    title: goal.title,
    description: 'Materially changed approved goal',
    lifecycle: 'active',
    reason: 'Fixture owner changed direction',
  });
  assert.equal((await p.submit(retained, randomUUID(), String(batch.batch_id), input)).status, 'denied');
  const acceptance = {
    suggestion_id: String(result.suggestion_id),
    expected_version: 1,
    decision: 'accept' as const,
    review_at: null,
    reason: 'Review the suggestion',
    usefulness: 'unrated' as const,
    review_seconds: 15,
  };
  assert.equal((await store.requestProactiveDisposition(retained, randomUUID(), acceptance)).status, 'denied');
});
test('S07-PG01 lost dismissal commit acknowledgement remains unresolved until the same disposition is confirmed', async () => {
  const { result, input } = await nextSuggestion();
  const request = {
    suggestion_id: String(result.suggestion_id),
    expected_version: 1,
    decision: 'dismiss' as const,
    review_at: null,
    reason: 'Already handled',
    usefulness: 'not_useful' as const,
    review_seconds: 20,
  };
  const preview = await store.requestProactiveDisposition(retained, randomUUID(), request);
  assert.equal(preview.status, 'ok');
  const owner = { ...context, ingressId: randomUUID() };
  assert.equal(
    (await store.decide(owner, String(preview.proposal_id), String(preview.confirmation_token), 'approve')).status,
    'ok',
  );
  const faultyPool = new pg.Pool(await fixtureDatabaseConfig()),
    connection = await faultyPool.connect();
  const query = connection.query.bind(connection);
  let dropped = false;
  connection.query = (async (...args: unknown[]) => {
    const value = await (query as (...p: unknown[]) => Promise<unknown>)(...args);
    if (args[0] === 'COMMIT' && !dropped) {
      dropped = true;
      throw Error('fixture commit acknowledgement lost');
    }
    return value;
  }) as typeof connection.query;
  connection.release();
  const faulty = new PriorityStore(new BoundedDatabase(faultyPool), knowledge);
  try {
    assert.equal((await faulty.apply(scope, String(preview.proposal_id))).status, 'pending');
    assert.equal((await store.apply(scope, String(preview.proposal_id))).status, 'ok');
    assert.equal(
      (await store.decide(owner, String(preview.proposal_id), String(preview.confirmation_token), 'approve')).status,
      'ok',
    );
    const resumed = await proactive().batch(retained, randomUUID());
    assert.equal(resumed.status, 'ok');
    assert.ok(!(resumed.candidates as ProactiveCandidate[]).some((c) => c.semantic_key === input.candidate_key));
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM cos.proactive_feedback WHERE scope_id=$1 AND suggestion_id=$2', [
          scope,
          result.suggestion_id,
        ])
      ).rows[0].n,
      1,
    );
  } finally {
    await faultyPool.end();
  }
});
test('S07-PG01 a real partition cannot acknowledge acceptance, invent empty history or queue a mission', async () => {
  const { result } = await nextSuggestion();
  const preview = await store.requestProactiveDisposition(retained, randomUUID(), {
    suggestion_id: String(result.suggestion_id),
    expected_version: 1,
    decision: 'accept',
    review_at: null,
    reason: 'Clarify this idea',
    usefulness: 'unrated',
    review_seconds: 10,
  });
  assert.equal(preview.status, 'ok');
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    faultyPool = new pg.Pool(relay.config),
    database = new BoundedDatabase(faultyPool, 350);
  const faulty = new PriorityStore(database, knowledge),
    owner = { ...context, ingressId: randomUUID() };
  try {
    await database.run((client) => client.query('SELECT 1'));
    relay.partition();
    assert.equal(
      (await faulty.decide(owner, String(preview.proposal_id), String(preview.confirmation_token), 'approve')).status,
      'pending',
    );
    assert.notEqual((await proactive(database).batch(retained, randomUUID())).status, 'ok');
    assert.equal((await store.apply(scope, String(preview.proposal_id))).status, 'denied');
    assert.equal((await pool.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1', [scope])).rowCount, 0);
    relay.restore();
    await delay(1050);
    assert.equal(
      (await faulty.decide(owner, String(preview.proposal_id), String(preview.confirmation_token), 'approve')).status,
      'ok',
    );
    const applied = await store.apply(scope, String(preview.proposal_id));
    assert.equal(applied.status, 'ok');
    assert.equal(applied.mission_id, null);
    assert.equal(applied.clarification_required, true);
  } finally {
    await faultyPool.end();
    await relay.close();
  }
});

test('S07-T05 changed supporting project requires a revised preview before acceptance or publication', async () => {
  const { p, result } = await nextSuggestion();
  const project = (await pool.query('SELECT * FROM cos.records WHERE scope_id=$1 AND id=$2', [scope, fixtureProject]))
    .rows[0];
  await approve({
    kind: 'project',
    record_id: fixtureProject,
    expected_version: project.version,
    title: project.title,
    description: 'Owner materially changes pilot scope',
    lifecycle: 'active',
    reason: 'Owner revised the project',
  });
  assert.equal(
    (
      await store.requestProactiveDisposition(retained, randomUUID(), {
        suggestion_id: String(result.suggestion_id),
        expected_version: 1,
        decision: 'accept',
        review_at: null,
        reason: 'Old preview is stale',
        usefulness: 'unrated',
        review_seconds: 2,
      })
    ).status,
    'denied',
  );
  const history = await p.history(retained);
  assert.ok(
    (history.items as Array<{ suggestion_id: string; withheld?: string }>).find(
      (r) => r.suggestion_id === result.suggestion_id,
    )?.withheld,
  );
});
test('S07-T06/T10 a storm stays within batch/proposal limits and checked briefs reserve one durable digest', async () => {
  now = new Date();
  for (let index = 0; index < 3; index++)
    await approve({
      kind: 'decision',
      title: 'Fixture unresolved dependency ' + index,
      description: 'Owner-recorded decision',
      reason: 'Fixture owner',
      state: 'needed',
      project_id: fixtureProject,
      due: null,
      defer_until: null,
      evidence: [],
      expected_version: 0,
    });
  const p = proactive(),
    batch = await p.batch(retained, randomUUID());
  assert.equal(batch.status, 'ok');
  assert.equal((batch.candidates as ProactiveCandidate[]).length, 3);
  for (const [index, candidate] of (batch.candidates as ProactiveCandidate[]).entries())
    assert.equal(
      (await p.submit(retained, randomUUID(), String(batch.batch_id), draft(candidate, fixtureGoal))).status,
      index < 2 ? 'ok' : 'denied',
    );
  const request = randomUUID(),
    brief = await store.briefArtifacts!.prepare(retained, request, 'Australia/Sydney');
  assert.equal(brief.status, 'ok');
  assert.equal((brief.snapshot as { suggested_work: unknown[] }).suggested_work.length, 1);
  assert.match(String(brief.text), /Suggested work — awaiting owner disposition/);
  assert.deepEqual(await store.briefArtifacts!.prepare(retained, request, 'Australia/Sydney'), brief);
  const next = await store.briefArtifacts!.prepare(retained, randomUUID(), 'Australia/Sydney');
  assert.equal(next.status, 'ok');
  assert.deepEqual((next.snapshot as { suggested_work: unknown[] }).suggested_work, []);
  assert.equal((await pool.query('SELECT * FROM cos.proactive_notifications WHERE scope_id=$1', [scope])).rowCount, 1);
  const currentPolicy = (await pool.query('SELECT version FROM cos.proactive_policies WHERE scope_id=$1', [scope]))
    .rows[0].version;
  await approve({
    kind: 'proactive_policy',
    state: 'active',
    policy: { ...policy, time_zone: 'UTC', quiet_hours: { start: '00:00', end: '23:59' }, notifications_per_day: 3 },
    expected_version: currentPolicy,
    reason: 'Fixture quiet hours',
  });
  await nextSuggestion();
  const quiet = await store.briefArtifacts!.prepare(retained, randomUUID(), 'Australia/Sydney');
  assert.equal(quiet.status, 'ok');
  assert.deepEqual((quiet.snapshot as { suggested_work: unknown[] }).suggested_work, []);
  assert.equal((await pool.query('SELECT * FROM cos.proactive_notifications WHERE scope_id=$1', [scope])).rowCount, 1);
});
test('S07-T04/T05 precise acceptance queues one existing bounded mission after current delegation checks', async () => {
  const sourceName = randomUUID() + '.md';
  fs.writeFileSync(
    path.join(base, 'staging', sourceName),
    'Fixture milestone has a capacity risk. Compare documented options.',
    { mode: 0o600 },
  );
  const source = await knowledge.importSource(context, randomUUID(), {
    sourceKey: randomUUID(),
    filename: sourceName,
    title: 'Fixture project risk',
    processingProviders: ['codex'],
    expectedVersion: 0,
    projectId: fixtureProject,
  });
  assert.equal(source.status, 'ok');
  await admin.query(
    'INSERT INTO cos.mission_template_versions(scope_id,id,version,body,digest,reviewed_by,provenance) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      scope,
      RESEARCH_TEMPLATE.id,
      RESEARCH_TEMPLATE.version,
      JSON.stringify(RESEARCH_TEMPLATE),
      digest(RESEARCH_TEMPLATE),
      context.ownerId,
      JSON.stringify({ fixture_only: true }),
    ],
  );
  const { result } = await nextSuggestion((input) => ({
    ...input,
    recommendation: 'act',
    action_class: 'research',
    permission_requirements: ['owner_approval', 'source_access', 'delegation_consent'],
    work_order: {
      question: 'Compare documented options for the fixture capacity risk.',
      goal_id: fixtureGoal,
      project_id: fixtureProject,
      sources: [{ source_id: String(source.source_id), revision_id: String(source.revision_id) }],
      acceptance_criteria: [
        { id: 'options', description: 'Explain documented capacity tradeoffs with source evidence.' },
      ],
      limits: { ...MISSION_DEFAULT_LIMITS },
    },
  }));
  assert.equal((await pool.query('SELECT * FROM cos.missions WHERE scope_id=$1', [scope])).rowCount, 0);
  const request = {
    suggestion_id: String(result.suggestion_id),
    expected_version: 1,
    decision: 'accept' as const,
    review_at: null,
    reason: 'Authorise this bounded comparison',
    usefulness: 'useful' as const,
    review_seconds: 30,
  };
  assert.equal((await store.requestProactiveDisposition(retained, randomUUID(), request)).status, 'denied');
  delegationEnabled = true;
  const first = await store.requestProactiveDisposition(retained, randomUUID(), request),
    second = await store.requestProactiveDisposition(retained, randomUUID(), request);
  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'ok');
  assert.equal((await pool.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1', [scope])).rowCount, 0);
  delegationEnabled = false;
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(first.proposal_id),
        String(first.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  delegationEnabled = true;
  for (const preview of [first, second])
    assert.equal(
      (
        await store.decide(
          { ...context, ingressId: randomUUID() },
          String(preview.proposal_id),
          String(preview.confirmation_token),
          'approve',
        )
      ).status,
      'ok',
    );
  assert.equal((await store.apply(scope, String(first.proposal_id))).status, 'ok');
  assert.equal((await store.apply(scope, String(first.proposal_id))).status, 'ok');
  assert.equal((await store.apply(scope, String(second.proposal_id))).status, 'conflict');
  assert.equal((await pool.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1', [scope])).rowCount, 1);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM cos.mission_budget_reservations WHERE scope_id=$1', [scope])).rows[0]
      .n,
    1,
  );
  const feedbackBefore = (
    await pool.query('SELECT count(*)::int n FROM cos.proactive_feedback WHERE scope_id=$1', [scope])
  ).rows[0].n;
  const policyVersion = (await pool.query('SELECT version FROM cos.proactive_policies WHERE scope_id=$1', [scope]))
    .rows[0].version;
  await approve({
    kind: 'proactive_policy',
    state: 'paused',
    policy,
    expected_version: policyVersion,
    reason: 'Fixture compatible rollback pauses generation and notifications',
  });
  assert.equal((await proactive().batch(retained, randomUUID())).status, 'denied');
  const pausedBrief = await store.briefArtifacts!.prepare(retained, randomUUID(), 'Australia/Sydney');
  assert.equal(pausedBrief.status, 'ok');
  assert.deepEqual((pausedBrief.snapshot as { suggested_work: unknown[] }).suggested_work, []);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM cos.proactive_feedback WHERE scope_id=$1', [scope])).rows[0].n,
    feedbackBefore,
  );
  assert.equal((await pool.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1', [scope])).rowCount, 1);
  await approve({
    kind: 'proactive_policy',
    state: 'active',
    policy,
    expected_version: policyVersion + 1,
    reason: 'Fixture owner resumes only the recorded limits',
  });
  // A new proposal cannot be accepted after supporting source access is revoked.
  const fresh = await nextSuggestion();
  const preview = await store.requestProactiveDisposition(retained, randomUUID(), {
    ...request,
    suggestion_id: String(fresh.result.suggestion_id),
  });
  assert.equal(preview.status, 'ok');
  await admin.query("UPDATE cos.sources SET status='revoked',version=version+1 WHERE scope_id=$1 AND id=$2", [
    scope,
    source.source_id,
  ]);
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(preview.proposal_id),
        String(preview.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  assert.equal((await proactive().batch(retained, randomUUID())).status, 'denied');
  assert.equal((await pool.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1', [scope])).rowCount, 1);
});
