import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { TEAM_TEMPLATES } from '../../modules/chief-of-staff/contracts/team-templates.js';
import { TEAM_DEFAULT_LIMITS, type TeamRequest } from '../../modules/chief-of-staff/contracts/team-protocol.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { TeamRunStore } from '../../modules/chief-of-staff/missions/team-run-store.js';
import type { TeamChildWorkOrder } from '../../modules/chief-of-staff/missions/team-work-order.js';
import { RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MissionRunStore } from '../../modules/chief-of-staff/missions/run-store.js';
import { checkMissionReview } from '../../modules/chief-of-staff/contracts/mission-review.js';
import { TeamFinalReviews } from '../../modules/chief-of-staff/missions/team-final-review.js';
import type { CosMissionIdentity } from '../../cos-mission-boundary.js';
import type { MissionDispatchLease } from '../../modules/chief-of-staff/missions/run-store.js';

const scope = 'team-admission-' + randomUUID();
const context = { scopeId: scope, ownerId: 'owner', agentGroupId: scope, sessionId: scope, ingressId: randomUUID() };
const authority = {
  bindingDigest: digest('private fixture origin'),
  delegationDigest: digest('reviewed fixture delegation'),
  contextGeneration: randomUUID(),
  provider: {
    profile: 'codex-subscription/research-v1',
    model: 'fixture-codex',
    policyDigest: digest('fixture consent'),
  },
  templateBundleDigest: digest(TEAM_TEMPLATES),
  templateDigest: digest(RESEARCH_TEMPLATE),
  teamPolicyDigest: digest('fixture team admission revision one'),
};
let enabled = true,
  admin: pg.Client,
  store: PriorityStore,
  knowledge: KnowledgeStore,
  base: string;
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-team-admission-'));
  for (const dir of ['artifacts', 'staging']) fs.mkdirSync(path.join(base, dir), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(base, 'artifacts'), path.join(base, 'staging')),
  );
  store = new PriorityStore(
    database,
    knowledge,
    undefined,
    undefined,
    () => authority,
    () => (enabled ? authority : null),
  );
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'owner','fixture',$1,$1,'active')",
    [scope],
  );
});
after(async () => {
  if (admin) {
    await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
    for (const table of [
      'mission_team_budget_events',
      'mission_team_calls',
      'mission_team_reviews',
      'mission_team_reworks',
      'mission_team_children',
      'mission_team_reservations',
      'mission_team_dependencies',
      'mission_team_steps',
      'mission_team_roots',
      'mission_team_work_orders',
      'mission_reviews',
      'mission_result_submissions',
      'mission_budget_reservations',
      'mission_attempts',
      'missions',
      'mission_work_orders',
      'mission_context_manifests',
      'mission_template_versions',
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
async function input(): Promise<TeamRequest> {
  const id = randomUUID();
  fs.writeFileSync(path.join(base, 'staging', id + '.md'), 'A costs less. B has more capacity.', { mode: 0o600 });
  const source = await knowledge.importSource(context, randomUUID(), {
    sourceKey: id,
    filename: id + '.md',
    title: 'Fixture options',
    processingProviders: ['codex'],
    expectedVersion: 0,
  });
  assert.equal(source.status, 'ok');
  const sources = [{ source_id: String(source.source_id), revision_id: String(source.revision_id) }];
  const acceptance_criteria = [{ id: 'tradeoff', description: 'Compare cost and capacity, preserving disagreement.' }];
  const step = (step_id: string, template_id: keyof typeof TEAM_TEMPLATES, depends_on: string[] = []) => ({
    step_id,
    template_id,
    template_version: 1 as const,
    depends_on,
    input_artifact_refs: depends_on.map((step_id) => ({ step_id, result_schema: 'cos-research-result/v1' })),
    sources,
    required: true,
    acceptance_criteria,
    result_schema: TEAM_TEMPLATES[template_id].resultSchema as 'cos-research-result/v1' | 'cos-team-review/v1',
    max_rework_count: 0 as const,
    limits: { ...MISSION_DEFAULT_LIMITS },
  });
  return {
    question: 'Compare A and B.',
    goal_id: null,
    project_id: null,
    sources,
    acceptance_criteria,
    limits: { ...TEAM_DEFAULT_LIMITS },
    partial_policy: 'block',
    steps: [
      step('technical', 'team-technical-analyst'),
      step('operations', 'team-operational-analyst'),
      step('synthesis', 'team-writer', ['technical', 'operations']),
      step('review', 'team-reviewer', ['synthesis']),
    ],
  };
}
async function templates() {
  for (const t of Object.values(TEAM_TEMPLATES))
    await admin.query(
      'INSERT INTO cos.mission_template_versions(scope_id,id,version,body,digest,reviewed_by,provenance) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [scope, t.id, t.version, JSON.stringify(t), digest(t), 'owner', '{}'],
    );
}
async function rows(table: string) {
  return (await admin.query(`SELECT * FROM cos.${table} WHERE scope_id=$1 ORDER BY created_at`, [scope])).rows;
}
async function approve(p: Record<string, unknown>) {
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
  return store.apply(scope, String(p.proposal_id));
}
test('S06-T01 team request requires separately admitted authority and every exact reviewed template', async () => {
  const r = await input();
  assert.equal((await store.requestTeam(context, randomUUID(), r)).status, 'denied');
  await templates();
  enabled = false;
  try {
    assert.equal((await store.requestTeam(context, randomUUID(), r)).status, 'denied');
  } finally {
    enabled = true;
  }
  const unconfigured = new PriorityStore(store.database, knowledge, undefined, undefined, () => authority);
  assert.equal((await unconfigured.requestTeam(context, randomUUID(), r)).status, 'denied');
  assert.equal((await rows('mission_team_roots')).length, 0);
});
test('S06-T01/T03/PG01 one exact approval admits a graph and escrows all step credits once', async () => {
  const r = await input(),
    requestId = randomUUID();
  const [a, b] = await Promise.all([
    store.requestTeam(context, requestId, r),
    store.requestTeam(context, requestId, r),
  ]);
  assert.equal(a.status, 'ok');
  assert.deepEqual(a, b);
  assert.equal((await rows('mission_team_roots')).length, 1);
  assert.equal((await rows('mission_team_steps')).length, 0);
  assert.equal((await store.requestTeam(context, requestId, { ...r, question: 'Changed request' })).status, 'conflict');
  const applied = await approve(a);
  assert.equal(applied.status, 'ok');
  assert.equal(applied.record_id, a.team_id);
  const before = await rows('mission_team_reservations');
  assert.equal(before.length, 4);
  assert.equal(
    before.reduce((sum, row) => sum + row.max_attempts, 0),
    8,
  );
  assert.equal(
    before.reduce((sum, row) => sum + row.max_turns, 0),
    16,
  );
  assert.equal(
    before.reduce((sum, row) => sum + row.max_tool_calls, 0),
    96,
  );
  const steps = await rows('mission_team_steps');
  assert.equal(steps.length, 4);
  assert.equal(steps.filter((s) => s.state === 'ready').length, 2);
  assert.equal(steps.filter((s) => s.state === 'blocked').length, 2);
  const [x, y] = await Promise.all([
    store.apply(scope, String(a.proposal_id)),
    store.apply(scope, String(a.proposal_id)),
  ]);
  assert.deepEqual(x, applied);
  assert.deepEqual(y, applied);
  assert.deepEqual(await rows('mission_team_reservations'), before);
  assert.equal((await rows('mission_team_budget_events')).length, 4);
  assert.equal((await rows('mission_attempts')).length, 0); // Approval persists intent; a host dispatcher performs native allocation later.
});
test('S06-T01 preview and apply revalidate template integrity and current source/provider consent', async () => {
  const p = await store.requestTeam(context, randomUUID(), await input());
  assert.equal(p.status, 'ok');
  await admin.query(
    'UPDATE cos.mission_template_versions SET body=body||\'{"instructions":"changed"}\'::jsonb WHERE scope_id=$1 AND id=\'team-writer\'',
    [scope],
  );
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(p.proposal_id),
        String(p.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  const writer = TEAM_TEMPLATES['team-writer'];
  await admin.query('UPDATE cos.mission_template_versions SET body=$2 WHERE scope_id=$1 AND id=$3', [
    scope,
    JSON.stringify(writer),
    writer.id,
  ]);
  enabled = false;
  try {
    assert.equal(
      (
        await store.decide(
          { ...context, ingressId: randomUUID() },
          String(p.proposal_id),
          String(p.confirmation_token),
          'approve',
        )
      ).status,
      'denied',
    );
  } finally {
    enabled = true;
  }
});
test('S06-T01 stale source, foreign session and scheduled origins cannot approve or admit teams', async () => {
  const r = await input(),
    p = await store.requestTeam(context, randomUUID(), r);
  assert.equal(p.status, 'ok');
  assert.equal(
    (
      await store.requestTeam(
        { ...context, origin: { kind: 'schedule', runId: 'fixture', generation: 1 } },
        randomUUID(),
        r,
      )
    ).status,
    'denied',
  );
  assert.equal(
    (
      await store.decide(
        { ...context, sessionId: 'foreign', ingressId: randomUUID() },
        String(p.proposal_id),
        String(p.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  await admin.query("UPDATE cos.sources SET status='revoked',version=version+1 WHERE scope_id=$1 AND id=$2", [
    scope,
    r.sources[0].source_id,
  ]);
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(p.proposal_id),
        String(p.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
});
test('S06-T01 runtime cannot rewrite approved graph or root budget history', async () => {
  for (const table of [
    'mission_team_work_orders',
    'mission_team_dependencies',
    'mission_team_budget_events',
    'mission_team_children',
    'mission_team_reworks',
    'mission_team_calls',
    'mission_team_reviews',
  ]) {
    const p = (
      await store.database.pool.query(
        "SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'UPDATE') AS update,has_table_privilege(current_user,$1,'DELETE') AS delete",
        ['cos.' + table],
      )
    ).rows[0];
    assert.deepEqual(p, { read: true, insert: true, update: false, delete: false });
    await assert.rejects(
      store.database.pool.query(`UPDATE cos.${table} SET scope_id=scope_id WHERE scope_id=$1`, [scope]),
      { code: '42501' },
    );
  }
});
test('S06-T01 a new team-admission revision cannot revive an older unapproved graph', async () => {
  const p = await store.requestTeam(context, randomUUID(), await input());
  assert.equal(p.status, 'ok');
  const previous = authority.teamPolicyDigest;
  authority.teamPolicyDigest = digest('fixture team admission revision two');
  try {
    assert.equal(
      (
        await store.decide(
          { ...context, ingressId: randomUUID() },
          String(p.proposal_id),
          String(p.confirmation_token),
          'approve',
        )
      ).status,
      'denied',
    );
  } finally {
    authority.teamPolicyDigest = previous;
  }
});
test('S06-T02 a corrupt second step cannot commit the first child while reporting denial', async () => {
  const p = await store.requestTeam(context, randomUUID(), await input());
  await approve(p);
  const teams = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 3, maxWorkers: 2 });
  await admin.query(
    "UPDATE cos.mission_team_reservations SET max_turns=1 WHERE scope_id=$1 AND team_id=$2 AND step_id='technical'",
    [scope, p.team_id],
  );
  assert.equal((await teams.claimReady(context, String(p.team_id))).status, 'denied');
  assert.equal((await rows('mission_attempts')).length, 0);
  await admin.query(
    "UPDATE cos.mission_team_reservations SET max_turns=4 WHERE scope_id=$1 AND team_id=$2 AND step_id='technical'",
    [scope, p.team_id],
  );
});
test('S06-T02/T03/PG01 concurrent ready admission creates stable isolated children once and never starts blocked joins', async () => {
  const p = await store.requestTeam(context, randomUUID(), await input());
  assert.equal(p.status, 'ok');
  await approve(p);
  // Fixture host has three native slots, one reserved for the coordinator. Same existing database/pool.
  const teams = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 3, maxWorkers: 2 });
  const [a, b] = await Promise.all([
    teams.claimReady(context, String(p.team_id)),
    teams.claimReady(context, String(p.team_id)),
  ]);
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  const steps = (await rows('mission_team_steps')).filter((s) => s.team_id === p.team_id),
    missions = await rows('missions'),
    attempts = await rows('mission_attempts');
  assert.equal(steps.filter((s) => s.state === 'running').length, 2);
  assert.equal(steps.filter((s) => s.state === 'blocked').length, 2);
  assert.equal(missions.length, 2);
  assert.equal(attempts.length, 2);
  assert.equal(new Set(attempts.map((a) => a.session_id)).size, 2);
  assert.equal(new Set(attempts.map((a) => a.agent_group_id)).size, 2);
  assert.equal(
    missions.every((m) => m.proposal_id === null),
    true,
  ); // Root approval is explicit derivation, not a fabricated child approval.
  const discovery = await store.missionRuns.pendingDispatch(context);
  assert.equal(discovery.status, 'ok');
  assert.equal((discovery.items as unknown[]).length, 2);
  for (const attempt of attempts) {
    const dispatch = new MissionRunStore(
      store.database,
      store.missions,
      knowledge.artifacts,
      {},
      { nativeCapacity: 3, maxWorkers: 2 },
    );
    const claim = await dispatch.claimDispatch(context, attempt.id, 'fixture-host');
    assert.equal(claim.status, 'ok');
    assert.equal((claim.order as TeamChildWorkOrder).body.team.teamId, p.team_id);
    assert.equal((claim.order as TeamChildWorkOrder).context.artifacts.length, 0);
  }
  const before = await rows('mission_budget_reservations');
  assert.equal((await teams.claimReady(context, String(p.team_id))).status, 'ok');
  assert.deepEqual(await rows('mission_budget_reservations'), before);
  // No native allocation or model ran; retain these queued reservations for the capacity test below.
});
test('S06-T02/PG02 shared host admission preserves coordinator capacity across multiple roots', async () => {
  const p = await store.requestTeam(context, randomUUID(), await input());
  await approve(p);
  const teams = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 3, maxWorkers: 2 });
  const result = await teams.claimReady(context, String(p.team_id));
  assert.equal(result.status, 'ok');
  assert.equal(result.capacity_available, 0);
  assert.equal(
    (await rows('mission_team_steps')).filter((s) => s.team_id === p.team_id && s.child_mission_id !== null).length,
    0,
  );
  assert.equal((await rows('mission_attempts')).length, 2);
  const disabled = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 1, maxWorkers: 2 });
  assert.equal((await disabled.claimReady(context, String(p.team_id))).capacity_available, 0);
});
async function singleAttempt() {
  if (
    !(
      await admin.query('SELECT 1 FROM cos.mission_template_versions WHERE scope_id=$1 AND id=$2', [
        scope,
        RESEARCH_TEMPLATE.id,
      ])
    ).rowCount
  )
    await admin.query(
      'INSERT INTO cos.mission_template_versions(scope_id,id,version,body,digest,reviewed_by,provenance) VALUES($1,$2,1,$3,$4,$5,$6)',
      [
        scope,
        RESEARCH_TEMPLATE.id,
        JSON.stringify(RESEARCH_TEMPLATE),
        digest(RESEARCH_TEMPLATE),
        context.ownerId,
        '{}',
      ],
    );
  const { steps: _steps, partial_policy: _partial, ...request } = await input();
  const p = await store.requestMission(context, randomUUID(), { ...request, limits: { ...MISSION_DEFAULT_LIMITS } });
  assert.equal(p.status, 'ok');
  await approve(p);
  return (await rows('mission_attempts')).find((a) => a.mission_id === p.mission_id)!;
}
test('S06-T02/PG02 ordinary single-worker dispatch cannot consume capacity reserved by teams', async () => {
  const attempt = await singleAttempt();
  const dispatch = new MissionRunStore(
    store.database,
    store.missions,
    knowledge.artifacts,
    {},
    { nativeCapacity: 3, maxWorkers: 2 },
  );
  assert.equal((await dispatch.claimDispatch(context, attempt.id, 'fixture-host')).status, 'pending');
  assert.equal((await rows('mission_attempts')).find((a) => a.id === attempt.id)!.state, 'queued');
  // No native workers were launched by this admission fixture; confirm the exact scoped simulated attempts absent.
  await admin.query(
    "UPDATE cos.mission_attempts SET allocation=allocation||'{\"stop_confirmed\":true}'::jsonb,state='failed',lease_owner=NULL,lease_until=NULL WHERE scope_id=$1",
    [scope],
  );
});
test('S06-T02/PG02 already admitted single workers count against team admission; a queued backlog does not', async () => {
  const first = await singleAttempt(),
    second = await singleAttempt();
  const dispatch = new MissionRunStore(
    store.database,
    store.missions,
    knowledge.artifacts,
    {},
    { nativeCapacity: 3, maxWorkers: 2 },
  );
  assert.equal((await dispatch.claimDispatch(context, first.id, 'fixture-host')).status, 'ok');
  const p = await store.requestTeam(context, randomUUID(), await input());
  await approve(p);
  const teams = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 3, maxWorkers: 2 });
  const result = await teams.claimReady(context, String(p.team_id));
  assert.equal(result.status, 'ok');
  assert.equal((result.created as string[]).length, 1);
  assert.equal((await dispatch.claimDispatch(context, second.id, 'fixture-host')).status, 'pending');
  assert.deepEqual((await teams.claimReady(context, String(p.team_id))).created, []);
  assert.equal((await dispatch.claimDispatch(context, first.id, 'fixture-host')).status, 'ok');
});
test('S06-T05/T07 analyst result shape and context are pinned; submitted children never trigger main-context review chatter', async () => {
  await admin.query(
    "UPDATE cos.mission_attempts SET allocation=allocation||'{\"stop_confirmed\":true}'::jsonb,state='failed',lease_owner=NULL,lease_until=NULL WHERE scope_id=$1",
    [scope],
  );
  const r = await input(),
    p = await store.requestTeam(context, randomUUID(), r);
  await approve(p);
  const teams = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 3, maxWorkers: 2 });
  await teams.claimReady(context, String(p.team_id));
  const step = (await rows('mission_team_steps')).find((s) => s.team_id === p.team_id && s.step_id === 'technical')!;
  const attempt = (await rows('mission_attempts')).find((a) => a.mission_id === step.child_mission_id)!;
  const runs = new MissionRunStore(
    store.database,
    store.missions,
    knowledge.artifacts,
    {},
    { nativeCapacity: 3, maxWorkers: 2 },
  );
  const claimed = await runs.claimDispatch(context, attempt.id, 'fixture-host');
  assert.equal(claimed.status, 'ok');
  const identity = claimed.identity as CosMissionIdentity,
    lease = claimed.lease as MissionDispatchLease;
  assert.equal((await runs.markDispatchReady(identity, lease, digest('fixture native receipt'))).status, 'ok');
  assert.equal((await runs.beginExecution(identity, lease)).status, 'ok');
  assert.deepEqual(
    (await runs.readContext(identity, lease, 'fixture-context')).template,
    TEAM_TEMPLATES['team-technical-analyst'],
  );
  assert.equal(
    (
      await runs.submitResult(identity, lease, randomUUID(), 'wrong-schema', {
        format: 'cos-team-review/v1',
        evidence_validity: [],
        factual_gaps: [],
        contradictions: [],
        unmet_criteria: [],
        recommended_revisions: [],
        confidence: 'high',
      })
    ).status,
    'denied',
  );
  const result = {
    format: 'cos-research-result/v1',
    outcome: 'answer',
    claims: [
      {
        id: 'tradeoff',
        kind: 'quote',
        text: 'A costs less.',
        citations: [{ ...r.sources[0], ordinal: 0, start_line: 1, end_line: 1 }],
      },
    ],
    criteria: [{ id: 'tradeoff', claim_ids: ['tradeoff'] }],
    limitations: ['Fixture notes only.'],
  };
  const requestId = randomUUID(),
    submitted = await runs.submitResult(identity, lease, requestId, 'correct-schema', result);
  assert.equal(submitted.status, 'ok');
  assert.deepEqual(await runs.submitResult(identity, lease, requestId, 'correct-schema', result), submitted);
  assert.equal((await runs.confirmStopped(identity)).status, 'ok');
  const pending = await store.missionReviewRuns!.pending({
    ...context,
    provider: 'codex',
    generation: authority.contextGeneration,
  });
  assert.equal(pending.status, 'ok');
  assert.deepEqual(pending.items, []);
  assert.equal((await rows('outbox')).filter((o) => o.kind === 'mission_result_notification').length, 0);
});
test('S06-T02/T05/T07 joins require verified submitted artifacts and exact stops, then dispatch once with declared inputs only', async () => {
  await admin.query(
    "UPDATE cos.mission_attempts SET allocation=allocation||'{\"stop_confirmed\":true}'::jsonb,state='failed',lease_owner=NULL,lease_until=NULL WHERE scope_id=$1 AND state<>'submitted'",
    [scope],
  );
  const r = await input(),
    p = await store.requestTeam(context, randomUUID(), r),
    teamId = String(p.team_id);
  await approve(p);
  const teams = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 3, maxWorkers: 2 });
  const runs = new MissionRunStore(
    store.database,
    store.missions,
    knowledge.artifacts,
    {},
    { nativeCapacity: 3, maxWorkers: 2 },
  );
  await teams.claimReady(context, teamId);
  const children = (await rows('mission_team_steps')).filter((s) => s.team_id === teamId && s.state === 'running');
  const identities: CosMissionIdentity[] = [];
  for (const child of children) {
    const attempt = (await rows('mission_attempts')).find((a) => a.mission_id === child.child_mission_id)!;
    const claim = await runs.claimDispatch(context, attempt.id, 'fixture-host'),
      identity = claim.identity as CosMissionIdentity,
      lease = claim.lease as MissionDispatchLease;
    assert.equal(claim.status, 'ok');
    await runs.markDispatchReady(identity, lease, digest('fixture native receipt'));
    await runs.beginExecution(identity, lease);
    const result = {
      format: 'cos-research-result/v1',
      outcome: 'answer',
      claims: [
        {
          id: child.step_id,
          kind: 'inference',
          text: child.step_id === 'technical' ? 'Prefer B for capacity.' : 'Prefer A for cost.',
          citations: [{ ...r.sources[0], ordinal: 0, start_line: 1, end_line: 1 }],
        },
      ],
      criteria: [{ id: 'tradeoff', claim_ids: [child.step_id] }],
      limitations: ['Fixture notes only.'],
    };
    assert.equal((await runs.submitResult(identity, lease, randomUUID(), 'submission', result)).status, 'ok');
    identities.push(identity);
  }
  assert.equal((await teams.advance(context, teamId)).status, 'ok');
  assert.equal(
    (await rows('mission_team_steps')).find((s) => s.team_id === teamId && s.step_id === 'synthesis')!.state,
    'blocked',
  );
  assert.deepEqual((await teams.claimReady(context, teamId)).created, []);
  for (const identity of identities) assert.equal((await runs.confirmStopped(identity)).status, 'ok');
  const advanced = await Promise.all([teams.advance(context, teamId), teams.advance(context, teamId)]);
  assert.equal(
    advanced.every((a) => a.status === 'ok'),
    true,
  );
  const claimed = await Promise.all([teams.claimReady(context, teamId), teams.claimReady(context, teamId)]);
  assert.deepEqual(
    claimed.map((c) => c.status),
    ['ok', 'ok'],
  );
  assert.equal(claimed.flatMap((c) => c.created as string[]).length, 1);
  const writer = (await rows('mission_team_steps')).find((s) => s.team_id === teamId && s.step_id === 'synthesis')!;
  const attempt = (await rows('mission_attempts')).find((a) => a.mission_id === writer.child_mission_id)!;
  const claim = await runs.claimDispatch(context, attempt.id, 'fixture-host');
  assert.equal(claim.status, 'ok');
  const order = claim.order as TeamChildWorkOrder;
  assert.deepEqual(
    order.context.artifacts.map((a) => a.step_id),
    ['operations', 'technical'],
  );
  assert.equal(JSON.stringify(order.context).includes('Prefer A for cost.'), true);
  assert.equal(JSON.stringify(order.context).includes('Prefer B for capacity.'), true);
  assert.equal(
    (await rows('mission_team_steps')).find((s) => s.team_id === teamId && s.step_id === 'review')!.state,
    'blocked',
  );
  await admin.query("UPDATE cos.sources SET status='revoked',version=version+1 WHERE scope_id=$1 AND id=$2", [
    scope,
    r.sources[0].source_id,
  ]);
  assert.equal(
    (await runs.authorizeDispatch(claim.identity as CosMissionIdentity, claim.lease as MissionDispatchLease)).status,
    'denied',
  );
});
async function stoppedAnalyses(failTechnical = false, configure?: (request: TeamRequest) => void | Promise<void>) {
  // This file exercises trusted admission/storage only, with no native worker or model process.
  await admin.query(
    "UPDATE cos.mission_attempts SET allocation=allocation||'{\"stop_confirmed\":true}'::jsonb,state='failed',lease_owner=NULL,lease_until=NULL WHERE scope_id=$1 AND state<>'submitted'",
    [scope],
  );
  const r = await input();
  await configure?.(r);
  if (failTechnical) r.steps.find((s) => s.step_id === 'technical')!.limits.max_attempts = 1;
  const p = await store.requestTeam(context, randomUUID(), r),
    teamId = String(p.team_id);
  await approve(p);
  const teams = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 3, maxWorkers: 2 });
  const runs = new MissionRunStore(
    store.database,
    store.missions,
    knowledge.artifacts,
    {},
    { nativeCapacity: 3, maxWorkers: 2 },
  );
  await teams.claimReady(context, teamId);
  const children = (await rows('mission_team_steps')).filter((s) => s.team_id === teamId && s.state === 'running');
  const submissions: string[] = [];
  for (const child of children) {
    const attempt = (await rows('mission_attempts')).find((a) => a.mission_id === child.child_mission_id)!;
    const claim = await runs.claimDispatch(context, attempt.id, 'fixture-host'),
      identity = claim.identity as CosMissionIdentity,
      lease = claim.lease as MissionDispatchLease;
    assert.equal(claim.status, 'ok');
    if (failTechnical && child.step_id === 'technical') {
      assert.equal((await runs.fail(identity, 'provider_failed')).status, 'ok');
    } else {
      await runs.markDispatchReady(identity, lease, digest('fixture native receipt'));
      await runs.beginExecution(identity, lease);
      const result = {
        format: 'cos-research-result/v1',
        outcome: 'answer',
        claims: [
          {
            id: child.step_id,
            kind: 'inference',
            text: child.step_id === 'technical' ? 'Prefer B for capacity.' : 'Prefer A for cost.',
            citations: [{ ...r.sources[0], ordinal: 0, start_line: 1, end_line: 1 }],
          },
        ],
        criteria: [{ id: 'tradeoff', claim_ids: [child.step_id] }],
        limitations: ['Fixture notes only.'],
      };
      const submitted = await runs.submitResult(identity, lease, randomUUID(), 'submission', result);
      assert.equal(submitted.status, 'ok');
      submissions.push(String(submitted.submission_id));
    }
    assert.equal((await runs.confirmStopped(identity)).status, 'ok');
  }
  return { teams, runs, teamId, submissions };
}
test('S06-T05/T07 failed provenance checks cannot partially accept another analyst or unblock a writer', async () => {
  const { teams, teamId, submissions } = await stoppedAnalyses();
  const artifact = (
    await admin.query(
      'SELECT a.* FROM cos.artifacts a JOIN cos.mission_result_submissions s ON s.scope_id=a.scope_id AND s.artifact_id=a.id WHERE s.scope_id=$1 AND s.id=$2',
      [scope, submissions.at(-1)],
    )
  ).rows[0];
  for (const patch of [
    { attempt_id: 'foreign' },
    { session_id: 'private-worker' },
    { work_order_digest: digest('forged') },
    { processing_provider: 'foreign' },
  ]) {
    await admin.query('UPDATE cos.artifacts SET provenance=$3 WHERE scope_id=$1 AND id=$2', [
      scope,
      artifact.id,
      { ...artifact.provenance, ...patch },
    ]);
    assert.equal((await teams.advance(context, teamId)).status, 'denied');
    assert.equal(
      (await rows('mission_team_steps')).filter((s) => s.team_id === teamId && s.state === 'submitted').length,
      0,
    );
    assert.equal(
      (await rows('mission_team_steps')).find((s) => s.team_id === teamId && s.step_id === 'synthesis')!.state,
      'blocked',
    );
    await admin.query('UPDATE cos.artifacts SET provenance=$3 WHERE scope_id=$1 AND id=$2', [
      scope,
      artifact.id,
      artifact.provenance,
    ]);
  }
  assert.equal((await teams.advance(context, teamId)).status, 'ok');
  assert.equal((await teams.claimReady(context, teamId)).status, 'ok');
});
test('S06-T04 an exhausted required specialist blocks the root; no apparently complete synthesis is admitted', async () => {
  const { teams, teamId } = await stoppedAnalyses(true);
  const advanced = await teams.advance(context, teamId);
  assert.equal(advanced.status, 'ok');
  assert.equal(advanced.state, 'blocked');
  assert.equal((await teams.claimReady(context, teamId)).status, 'denied');
  const steps = (await rows('mission_team_steps')).filter((s) => s.team_id === teamId);
  assert.equal(steps.find((s) => s.step_id === 'technical')!.state, 'failed');
  assert.equal(steps.find((s) => s.step_id === 'technical')!.provenance.failure_reason, 'worker_failed');
  assert.equal(steps.find((s) => s.step_id === 'synthesis')!.child_mission_id, null);
});
test('S06-T06/T03 cancellation fences the whole generation, retains credit through uncertain stops, and settles once while paused', async () => {
  await admin.query(
    "UPDATE cos.mission_attempts SET allocation=allocation||'{\"stop_confirmed\":true}'::jsonb,state='failed',lease_owner=NULL,lease_until=NULL WHERE scope_id=$1 AND state<>'submitted'",
    [scope],
  );
  const p = await store.requestTeam(context, randomUUID(), await input()),
    teamId = String(p.team_id);
  await approve(p);
  const teams = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 3, maxWorkers: 2 });
  const runs = new MissionRunStore(
    store.database,
    store.missions,
    knowledge.artifacts,
    {},
    { nativeCapacity: 3, maxWorkers: 2 },
  );
  await teams.claimReady(context, teamId);
  const children = (await rows('mission_team_steps')).filter(
    (s) => s.team_id === teamId && s.child_mission_id !== null,
  );
  const identities: CosMissionIdentity[] = [],
    leases: MissionDispatchLease[] = [];
  for (const child of children) {
    const attempt = (await rows('mission_attempts')).find((a) => a.mission_id === child.child_mission_id)!;
    const claim = await runs.claimDispatch(context, attempt.id, 'fixture-host');
    assert.equal(claim.status, 'ok');
    identities.push(claim.identity as CosMissionIdentity);
    leases.push(claim.lease as MissionDispatchLease);
    await runs.markDispatchReady(identities.at(-1)!, leases.at(-1)!, digest('fixture native receipt'));
    await runs.beginExecution(identities.at(-1)!, leases.at(-1)!);
  }
  assert.equal(
    (await runs.reserve(identities[0], 'fixture-turn', 'model', digest('fixture physical reservation'))).status,
    'ok',
  );
  assert.equal((await teams.cancel({ ...context, ownerId: 'foreign' }, teamId)).status, 'denied');
  assert.equal(
    (await teams.cancel({ ...context, origin: { kind: 'schedule', runId: 'foreign', generation: 1 } }, teamId)).status,
    'denied',
  );
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [scope]);
  try {
    const canceled = await Promise.all([teams.cancel(context, teamId), teams.cancel(context, teamId)]);
    assert.deepEqual(
      canceled.map((c) => ({ status: c.status, state: c.state })),
      [
        { status: 'ok', state: 'cancelling' },
        { status: 'ok', state: 'cancelling' },
      ],
    );
    const root = (await rows('mission_team_roots')).find((r) => r.id === teamId)!;
    assert.equal(root.generation, 2);
    assert.equal(
      (await rows('mission_team_budget_events')).filter((e) => e.team_id === teamId && e.kind === 'released').length,
      0,
    );
    for (const [i, identity] of identities.entries()) {
      assert.equal((await runs.authorizeDispatch(identity, leases[i])).status, 'denied');
      assert.equal((await runs.reserve(identity, 'late-call', 'model', digest('late'))).status, 'denied');
      assert.equal((await runs.readContext(identity, leases[i], 'late-context')).status, 'denied');
      assert.equal(
        (
          await runs.submitResult(identity, leases[i], randomUUID(), 'late-result', {
            format: 'cos-research-result/v1',
            outcome: 'blocked',
            claims: [],
            criteria: [{ id: 'tradeoff', claim_ids: [] }],
            limitations: ['Canceled fixture.'],
          })
        ).status,
        'denied',
      );
      assert.equal((await runs.retry(context, identity.attemptId)).status, 'denied');
    }
    assert.equal((await teams.confirmCancellation(context, teamId)).state, 'cancelling');
    assert.equal((await runs.confirmStopped(identities[0])).status, 'ok');
    assert.equal((await teams.confirmCancellation(context, teamId)).state, 'cancelling');
    assert.equal(
      (await rows('mission_team_reservations')).filter((r) => r.team_id === teamId && r.state !== 'reserved').length,
      0,
    );
    assert.equal((await runs.confirmStopped(identities[1])).status, 'ok');
    const done = await Promise.all([
      teams.confirmCancellation(context, teamId),
      teams.confirmCancellation(context, teamId),
    ]);
    assert.equal(
      done.every((d) => d.status === 'ok' && d.state === 'cancelled'),
      true,
    );
    const events = (await rows('mission_team_budget_events')).filter((e) => e.team_id === teamId);
    assert.equal(events.filter((e) => e.kind === 'released').length, 4);
    assert.equal(events.filter((e) => e.kind === 'uncertain').length, 1);
    const released = events.find((e) => e.kind === 'released' && e.step_id === children[0].step_id)!;
    assert.equal(released.body.usage.model, 1);
    assert.equal(released.body.unused.model, 3);
    const before = await rows('mission_team_budget_events');
    assert.equal((await teams.cancel(context, teamId)).state, 'cancelled');
    assert.deepEqual(await rows('mission_team_budget_events'), before);
    assert.equal(
      (await rows('mission_team_steps')).filter((s) => s.team_id === teamId && s.state !== 'cancelled').length,
      0,
    );
  } finally {
    await admin.query("UPDATE cos.scopes SET status='active' WHERE id=$1", [scope]);
  }
});
test('S06-T03/PG01 stopped worker retry uses only original attempt/turn/tool escrow and cannot borrow rework credits through S05', async () => {
  await admin.query(
    "UPDATE cos.mission_attempts SET allocation=allocation||'{\"stop_confirmed\":true}'::jsonb,state='failed',lease_owner=NULL,lease_until=NULL WHERE scope_id=$1 AND state<>'submitted'",
    [scope],
  );
  const p = await store.requestTeam(context, randomUUID(), await input()),
    teamId = String(p.team_id);
  await approve(p);
  const teams = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 3, maxWorkers: 2 });
  const runs = new MissionRunStore(
    store.database,
    store.missions,
    knowledge.artifacts,
    {},
    { nativeCapacity: 3, maxWorkers: 2 },
  );
  await teams.claimReady(context, teamId);
  const step = (await rows('mission_team_steps')).find((s) => s.team_id === teamId && s.step_id === 'technical')!;
  const old = (await rows('mission_attempts')).find((a) => a.mission_id === step.child_mission_id)!;
  const claim = await runs.claimDispatch(context, old.id, 'fixture-host'),
    identity = claim.identity as CosMissionIdentity,
    lease = claim.lease as MissionDispatchLease;
  assert.equal(claim.status, 'ok');
  await runs.markDispatchReady(identity, lease, digest('fixture native receipt'));
  await runs.beginExecution(identity, lease);
  assert.equal((await runs.reserve(identity, 'fixture-first-turn', 'model', digest('first turn'))).status, 'ok');
  await runs.fail(identity, 'provider_failed');
  await runs.confirmStopped(identity);
  assert.equal((await runs.retry(context, old.id)).status, 'denied');
  const before = (await rows('mission_team_budget_events')).filter((e) => e.team_id === teamId);
  const advanced = await Promise.all([teams.advance(context, teamId), teams.advance(context, teamId)]);
  assert.equal(
    advanced.every((a) => a.status === 'ok'),
    true,
  );
  const attempts = (await rows('mission_attempts')).filter((a) => a.mission_id === step.child_mission_id);
  assert.equal(attempts.length, 2);
  const retry = attempts.find((a) => a.id !== old.id)!;
  assert.equal(retry.provenance.retry_of, old.id);
  assert.equal(retry.generation, 2);
  assert.notEqual(retry.agent_group_id, old.agent_group_id);
  assert.notEqual(retry.session_id, old.session_id);
  const next = await runs.claimDispatch(context, retry.id, 'fixture-host');
  assert.equal(next.status, 'ok');
  assert.deepEqual((next.order as TeamChildWorkOrder).body, (claim.order as TeamChildWorkOrder).body);
  assert.deepEqual(
    (await rows('mission_team_budget_events')).filter((e) => e.team_id === teamId),
    before,
  );
  const reservations = (await rows('mission_budget_reservations')).filter(
    (b) => b.mission_id === step.child_mission_id,
  );
  assert.equal(reservations.filter((b) => b.kind === 'attempt').length, 2);
  assert.equal(reservations.filter((b) => b.kind === 'model').length, 1);
  await runs.fail(next.identity as CosMissionIdentity, 'provider_failed');
  await runs.confirmStopped(next.identity as CosMissionIdentity);
  assert.equal((await teams.advance(context, teamId)).state, 'blocked');
  assert.equal((await rows('mission_attempts')).filter((a) => a.mission_id === step.child_mission_id).length, 2);
});
test('S06-T03 a shorter step deadline removes model/tool/context authority while the original root deadline remains current', async () => {
  await admin.query(
    "UPDATE cos.mission_attempts SET allocation=allocation||'{\"stop_confirmed\":true}'::jsonb,state='failed',lease_owner=NULL,lease_until=NULL WHERE scope_id=$1 AND state<>'submitted'",
    [scope],
  );
  const request = await input();
  request.steps.find((s) => s.step_id === 'technical')!.limits.wall_seconds = 30;
  const p = await store.requestTeam(context, randomUUID(), request),
    teamId = String(p.team_id);
  await approve(p);
  const teams = new TeamRunStore(store.database, store.teams, knowledge, { nativeCapacity: 3, maxWorkers: 2 });
  const runs = new MissionRunStore(
    store.database,
    store.missions,
    knowledge.artifacts,
    {},
    { nativeCapacity: 3, maxWorkers: 2 },
  );
  await teams.claimReady(context, teamId);
  const step = (await rows('mission_team_steps')).find((s) => s.team_id === teamId && s.step_id === 'technical')!;
  const attempt = (await rows('mission_attempts')).find((a) => a.mission_id === step.child_mission_id)!;
  const claim = await runs.claimDispatch(context, attempt.id, 'fixture-host'),
    identity = claim.identity as CosMissionIdentity,
    lease = claim.lease as MissionDispatchLease;
  assert.equal(claim.status, 'ok');
  await runs.markDispatchReady(identity, lease, digest('fixture native receipt'));
  await runs.beginExecution(identity, lease);
  assert.equal((await runs.readContext(identity, lease, 'before-deadline')).status, 'ok');
  const order = claim.order as TeamChildWorkOrder;
  const milliseconds = (
    await admin.query('SELECT GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000)::int AS n', [
      order.body.deadlineAt,
    ])
  ).rows[0].n;
  await delay(milliseconds + 250);
  assert.equal(
    (await admin.query('SELECT $1::timestamptz <= clock_timestamp() AS expired', [order.body.deadlineAt])).rows[0]
      .expired,
    true,
  );
  const root = (await rows('mission_team_work_orders')).find((w) => w.id === teamId)!;
  assert.equal(
    (await admin.query('SELECT $1::timestamptz > clock_timestamp() AS current', [root.body.deadlineAt])).rows[0]
      .current,
    true,
  );
  assert.equal((await runs.reserve(identity, 'late-turn', 'model', digest('late physical turn'))).status, 'denied');
  assert.equal((await runs.readContext(identity, lease, 'after-deadline')).status, 'denied');
  assert.equal((await runs.authorizeDispatch(identity, lease)).status, 'denied');
});

async function finishTeamStep(
  f: Awaited<ReturnType<typeof stoppedAnalyses>>,
  stepId: string,
  revisionTarget?: string,
  extraModels = 0,
  expectModelExhausted = false,
) {
  assert.equal((await f.teams.claimReady(context, f.teamId)).status, 'ok');
  const step = (await rows('mission_team_steps')).find((s) => s.team_id === f.teamId && s.step_id === stepId)!;
  const attempt = (await rows('mission_attempts')).find(
    (a) => a.mission_id === step.child_mission_id && a.state === 'queued',
  )!;
  const claim = await f.runs.claimDispatch(context, attempt.id, 'fixture-host');
  assert.equal(claim.status, 'ok');
  const identity = claim.identity as CosMissionIdentity,
    lease = claim.lease as MissionDispatchLease,
    order = claim.order as TeamChildWorkOrder;
  assert.equal((await f.runs.markDispatchReady(identity, lease, digest('fixture native receipt'))).status, 'ok');
  assert.equal((await f.runs.beginExecution(identity, lease)).status, 'ok');
  const research = {
    format: 'cos-research-result/v1',
    outcome: 'answer',
    claims: [
      {
        id: stepId,
        kind: 'inference',
        text: 'Compare both differing perspectives.',
        citations: [
          {
            source_id: order.context.sources[0].source_id,
            revision_id: order.context.sources[0].revision_id,
            ordinal: 0,
            start_line: 1,
            end_line: 1,
          },
        ],
      },
    ],
    criteria: [{ id: 'tradeoff', claim_ids: [stepId] }],
    limitations: ['Supplied fixture notes only.'],
  };
  const result =
    stepId === 'review'
      ? {
          format: 'cos-team-review/v1',
          evidence_validity: order.context.artifacts.flatMap((a) =>
            a.state === 'submitted'
              ? a.result.claims.map((c) => ({
                  step_id: a.step_id,
                  claim_id: c.id,
                  verdict: 'uncertain',
                  reason: 'Advisory fixture judgement.',
                }))
              : [],
          ),
          factual_gaps: [],
          contradictions: [],
          unmet_criteria: revisionTarget ? ['tradeoff'] : [],
          recommended_revisions: revisionTarget
            ? [
                {
                  step_id: revisionTarget,
                  criterion_ids: ['tradeoff'],
                  instructions: 'Preserve both perspectives and clarify uncertainty.',
                },
              ]
            : [],
          confidence: 'low',
        }
      : research;
  assert.equal((await f.runs.readContext(identity, lease, randomUUID())).status, 'ok');
  assert.equal((await f.runs.reserve(identity, randomUUID(), 'model', digest('fixture turn'))).status, 'ok');
  for (let i = 0; i < extraModels; i++)
    assert.equal((await f.runs.reserve(identity, randomUUID(), 'model', digest({ fixtureTurn: i }))).status, 'ok');
  if (expectModelExhausted)
    assert.equal(
      (await f.runs.reserve(identity, randomUUID(), 'model', digest('beyond original credit'))).status,
      'denied',
    );
  const submitted = await f.runs.submitResult(identity, lease, randomUUID(), 'submission', result);
  assert.equal(submitted.status, 'ok');
  assert.equal((await f.runs.confirmStopped(identity)).status, 'ok');
  assert.equal((await f.teams.advance(context, f.teamId)).status, 'ok');
  return { identity, lease, order, submitted };
}

test('S06-T03/T05/T07 bounded reviewer rework retains all immutable children, pinned earlier inputs and aggregate credits', async () => {
  const f = await stoppedAnalyses(false, (r) => {
    r.limits.max_attempts = 9;
    r.steps.find((s) => s.step_id === 'synthesis')!.max_rework_count = 1;
  });
  await f.teams.advance(context, f.teamId);
  const firstWriter = await finishTeamStep(f, 'synthesis', undefined, 2);
  const firstReview = await finishTeamStep(f, 'review', 'synthesis');
  const request = () => f.teams.requestRework(context, f.teamId, String(firstReview.submitted.submission_id));
  const [a, b] = await Promise.all([request(), request()]);
  assert.equal(a.status, 'ok');
  assert.deepEqual(a, b);
  assert.deepEqual(a.revised_steps, ['synthesis', 'review']);
  assert.equal(
    (await f.runs.reserve(firstWriter.identity, randomUUID(), 'model', digest('late old call'))).status,
    'denied',
  );
  const revisedWriter = await finishTeamStep(f, 'synthesis', undefined, 0, true);
  assert.notEqual(revisedWriter.identity.missionId, firstWriter.identity.missionId);
  assert.notEqual(revisedWriter.identity.sessionId, firstWriter.identity.sessionId);
  assert.deepEqual(revisedWriter.order.context.artifacts, firstWriter.order.context.artifacts);
  assert.equal(revisedWriter.order.body.deadlineAt, firstWriter.order.body.deadlineAt);
  assert.match(revisedWriter.order.context.rework!.instructions, /clarify uncertainty/);
  const secondReview = await finishTeamStep(f, 'review', 'synthesis');
  assert.notEqual(secondReview.identity.missionId, firstReview.identity.missionId);
  assert.equal(secondReview.order.context.artifacts[0].state, 'submitted');
  assert.equal(
    (await f.teams.requestRework(context, f.teamId, String(secondReview.submitted.submission_id))).status,
    'denied',
  );
  const children = (await rows('mission_team_children')).filter((c) => c.team_id === f.teamId);
  assert.equal(children.length, 6);
  assert.equal(children.filter((c) => c.step_id === 'synthesis').length, 2);
  assert.equal(children.filter((c) => c.step_id === 'review').length, 2);
  assert.equal((await rows('mission_team_reworks')).filter((c) => c.team_id === f.teamId).length, 1);
  const cancelled = await f.teams.cancel(context, f.teamId);
  assert.equal((cancelled.identities as CosMissionIdentity[]).length, 6);
  assert.equal((await f.teams.confirmCancellation(context, f.teamId)).status, 'ok');
  const settled = (await rows('mission_team_reservations')).filter((c) => c.team_id === f.teamId);
  for (const step of ['synthesis', 'review']) {
    const usage = settled.find((c) => c.step_id === step)!.usage.usage;
    assert.equal(usage.attempt, 2);
    assert.equal(usage.model, step === 'synthesis' ? 4 : 2);
  }
});

test('S06-T03 rework cannot invent downstream rework or reviewer repeat credits, and denial leaves the graph unchanged', async () => {
  for (const limitation of ['writer-rework', 'review-attempt']) {
    const f = await stoppedAnalyses(false, (r) => {
      if (limitation === 'review-attempt') {
        r.steps.find((s) => s.step_id === 'synthesis')!.max_rework_count = 1;
        r.steps.find((s) => s.step_id === 'review')!.limits.max_attempts = 1;
      }
    });
    await f.teams.advance(context, f.teamId);
    await finishTeamStep(f, 'synthesis');
    const reviewer = await finishTeamStep(f, 'review', 'synthesis');
    const before = (await rows('mission_team_steps')).filter((s) => s.team_id === f.teamId);
    assert.equal(
      (await f.teams.requestRework(context, f.teamId, String(reviewer.submitted.submission_id))).status,
      'denied',
    );
    assert.deepEqual(
      (await rows('mission_team_steps')).filter((s) => s.team_id === f.teamId),
      before,
    );
    assert.equal((await rows('mission_team_reworks')).filter((r) => r.team_id === f.teamId).length, 0);
    assert.equal((await rows('mission_team_roots')).find((r) => r.id === f.teamId)!.state, 'awaiting_review');
  }
});

test('S06-T03/T05 upstream analyst rework preserves original review inputs and replays only pre-approved downstream work', async () => {
  const f = await stoppedAnalyses(false, (r) => {
    r.limits.max_attempts = 10;
    for (const step of r.steps.filter((s) => ['technical', 'synthesis'].includes(s.step_id))) step.max_rework_count = 1;
    const reviewer = r.steps.find((s) => s.step_id === 'review')!;
    reviewer.depends_on = ['technical', 'operations', 'synthesis'];
    reviewer.input_artifact_refs = reviewer.depends_on.map((step_id) => ({
      step_id,
      result_schema: 'cos-research-result/v1',
    }));
  });
  await f.teams.advance(context, f.teamId);
  const writer = await finishTeamStep(f, 'synthesis'),
    review = await finishTeamStep(f, 'review', 'technical');
  const requested = await f.teams.requestRework(context, f.teamId, String(review.submitted.submission_id));
  assert.equal(requested.status, 'ok');
  assert.deepEqual(requested.revised_steps, ['technical', 'synthesis', 'review']);
  const analyst = await finishTeamStep(f, 'technical');
  assert.equal(analyst.order.context.artifacts.length, 0);
  const revisedWriter = await finishTeamStep(f, 'synthesis');
  const oldTechnical = writer.order.context.artifacts.find((a) => a.step_id === 'technical')!,
    newTechnical = revisedWriter.order.context.artifacts.find((a) => a.step_id === 'technical')!;
  assert.equal(oldTechnical.state, 'submitted');
  assert.equal(newTechnical.state, 'submitted');
  if (oldTechnical.state === 'submitted' && newTechnical.state === 'submitted')
    assert.notEqual(oldTechnical.mission_id, newTechnical.mission_id);
  assert.deepEqual(
    revisedWriter.order.context.artifacts.find((a) => a.step_id === 'operations'),
    writer.order.context.artifacts.find((a) => a.step_id === 'operations'),
  );
  assert.equal(revisedWriter.order.context.rework!.kind, 'dependency_replay');
  await finishTeamStep(f, 'review');
  assert.equal((await f.teams.cancel(context, f.teamId)).status, 'ok');
  assert.equal((await f.teams.confirmCancellation(context, f.teamId)).status, 'ok');
});

test('S06-T01/T05 reviewer advice cannot carry uncited influence from a source outside the recipient scope', async () => {
  const f = await stoppedAnalyses(false, async (r) => {
    const other = await input();
    r.sources.push(other.sources[0]);
    r.steps.find((s) => s.step_id === 'technical')!.sources = [r.sources[0]];
    r.limits.max_attempts = 10;
    for (const step of r.steps.filter((s) => ['technical', 'synthesis'].includes(s.step_id))) step.max_rework_count = 1;
    const reviewer = r.steps.find((s) => s.step_id === 'review')!;
    reviewer.depends_on = ['technical', 'operations', 'synthesis'];
    reviewer.input_artifact_refs = reviewer.depends_on.map((step_id) => ({
      step_id,
      result_schema: 'cos-research-result/v1',
    }));
  });
  await f.teams.advance(context, f.teamId);
  await finishTeamStep(f, 'synthesis');
  const reviewer = await finishTeamStep(f, 'review', 'technical');
  assert.equal(
    (await f.teams.requestRework(context, f.teamId, String(reviewer.submitted.submission_id))).status,
    'denied',
  );
  assert.equal((await rows('mission_team_reworks')).filter((r) => r.team_id === f.teamId).length, 0);
});

test('S06-T04/T05/T08 final root evidence retains both analyst perspectives despite a writer omission and never completes without coordinator review', async () => {
  const f = await stoppedAnalyses();
  await f.teams.advance(context, f.teamId);
  assert.equal((await f.teams.reviewSnapshot(context, f.teamId)).status, 'pending');
  await finishTeamStep(f, 'synthesis');
  await finishTeamStep(f, 'review');
  const ready = await f.teams.reviewSnapshot(context, f.teamId);
  assert.equal(ready.status, 'ok');
  const brief = ready.brief as {
    format: string;
    outputs: Array<{ step_id: string; state: string; result: { claims?: Array<{ text: string }>; format: string } }>;
  };
  assert.equal(brief.format, 'cos-team-brief/v1');
  assert.equal(brief.outputs.find((s) => s.step_id === 'technical')!.result.claims![0].text, 'Prefer B for capacity.');
  assert.equal(brief.outputs.find((s) => s.step_id === 'operations')!.result.claims![0].text, 'Prefer A for cost.');
  assert.equal(brief.outputs.find((s) => s.step_id === 'review')!.result.format, 'cos-team-review/v1');
  assert.equal(ready.result_digest, digest(brief));
  assert.equal((await rows('mission_team_roots')).find((r) => r.id === f.teamId)!.state, 'awaiting_review');
  assert.equal((await rows('outbox')).filter((o) => o.kind === 'team_review_notification').length, 0);
  assert.equal((await f.teams.reviewSnapshot({ ...context, sessionId: 'foreign' }, f.teamId)).status, 'denied');
  const technical = (await rows('mission_team_steps')).find(
    (s) => s.team_id === f.teamId && s.step_id === 'technical',
  )!;
  const artifact = String(technical.provenance.artifact_id);
  const stored = (await rows('artifacts')).find((a) => a.id === artifact)!;
  await admin.query('UPDATE cos.artifacts SET provenance=provenance||$3::jsonb WHERE scope_id=$1 AND id=$2', [
    scope,
    artifact,
    JSON.stringify({ session_id: 'forged' }),
  ]);
  try {
    assert.equal((await f.teams.reviewSnapshot(context, f.teamId)).status, 'denied');
  } finally {
    await admin.query('UPDATE cos.artifacts SET provenance=$3 WHERE scope_id=$1 AND id=$2', [
      scope,
      artifact,
      stored.provenance,
    ]);
  }
});

test('S06-T04 an approved labelled partial graph permits partial coordinator judgement but cannot become complete', async () => {
  const f = await stoppedAnalyses(true, (r) => {
    r.partial_policy = 'allow_labelled';
  });
  await f.teams.advance(context, f.teamId);
  await finishTeamStep(f, 'synthesis');
  await finishTeamStep(f, 'review');
  const captured = await f.teams.withReviewSnapshot(context, f.teamId, async (_client, current) => ({
    status: 'ok',
    checks: current.checks,
    submission_id: current.anchor.id,
    result_digest: current.resultDigest,
    version: current.root.version,
    limitations: current.brief.limitations,
  }));
  assert.equal(captured.status, 'ok');
  const checks = captured.checks as {
    status: 'review_required';
    outcome: 'answer' | 'partial' | 'blocked';
    criteria: Array<{ id: string; coverage: 'claimed' | 'missing' }>;
  };
  const review = {
    mission_id: f.teamId,
    submission_id: captured.submission_id,
    result_digest: captured.result_digest,
    expected_version: captured.version,
    decision: 'partial',
    criteria: [{ id: 'tradeoff', verdict: 'partial' }],
  };
  assert.equal(checks.outcome, 'partial');
  assert.equal(checkMissionReview(review, checks), 'partial');
  assert.equal(
    checkMissionReview({ ...review, decision: 'accept', criteria: [{ id: 'tradeoff', verdict: 'satisfied' }] }, checks),
    null,
  );
  assert.match((captured.limitations as string[]).join('\n'), /Missing required step technical/);
});

test('S06-T03/T05/T07 final review uses the retained main context, charges root escrow and records one notification intent', async () => {
  const f = await stoppedAnalyses();
  await f.teams.advance(context, f.teamId);
  await finishTeamStep(f, 'synthesis');
  await finishTeamStep(f, 'review');
  const initial = await f.teams.reviewSnapshot(context, f.teamId),
    submissionId = String(initial.submission_id);
  const final = new TeamFinalReviews(f.teams),
    main = { ...context, provider: 'codex', generation: authority.contextGeneration };
  assert.equal((await final.read({ ...main, generation: randomUUID() }, f.teamId, submissionId)).status, 'denied');
  const claimed = await final.claim(main, f.teamId, submissionId, 'fixture-main-review');
  assert.equal(claimed.status, 'ok');
  const identity = claimed.identity as { generation: number; sessionId: string; contextGeneration: string },
    lease = claimed.lease as { owner: string; fence: number };
  assert.equal(identity.sessionId, context.sessionId);
  assert.equal(identity.contextGeneration, authority.contextGeneration);
  const executing = {
    ...main,
    origin: {
      kind: 'mission_review' as const,
      runId: f.teamId,
      generation: identity.generation,
      submissionId,
      owner: lease.owner,
      fence: lease.fence,
    },
  };
  const [a, b] = await Promise.all([
    final.reserve(executing, f.teamId, submissionId, lease, 'same-model-call', 'model'),
    final.reserve(executing, f.teamId, submissionId, lease, 'same-model-call', 'model'),
  ]);
  assert.equal([a, b].filter((r) => r.status === 'ok' && r.reserved === true).length, 1);
  assert.ok([a, b].every((r) => r.status === 'ok' || r.status === 'unavailable' || r.status === 'pending'));
  assert.deepEqual(await final.reserve(executing, f.teamId, submissionId, lease, 'same-model-call', 'model'), {
    status: 'ok',
    reserved: false,
  });
  assert.equal((await final.reserve(executing, f.teamId, submissionId, lease, 'read-result', 'tool')).status, 'ok');
  const read = await final.read(executing, f.teamId, submissionId);
  assert.equal(read.status, 'ok');
  const mission = read.mission as { version: number },
    submission = read.submission as { digest: string };
  const requestId = randomUUID(),
    review = {
      mission_id: f.teamId,
      submission_id: submissionId,
      result_digest: submission.digest,
      expected_version: mission.version,
      decision: 'accept',
      criteria: [{ id: 'tradeoff', verdict: 'satisfied' }],
    };
  assert.equal((await final.review(main, randomUUID(), review)).status, 'denied');
  assert.equal((await final.reserve(executing, f.teamId, submissionId, lease, 'record-review', 'tool')).status, 'ok');
  const [x, y] = await Promise.all([
    final.review(executing, requestId, review),
    final.review(executing, requestId, review),
  ]);
  assert.equal([x, y].filter((r) => r.status === 'ok').length, 1);
  const receipt = [x, y].find((r) => r.status === 'ok')!;
  assert.deepEqual(await final.review(executing, requestId, review), receipt);
  assert.equal(receipt.state, 'completed');
  assert.equal((await final.review(executing, requestId, { ...review, decision: 'partial' })).status, 'conflict');
  assert.equal((await final.reserve(executing, f.teamId, submissionId, lease, 'late-model', 'model')).status, 'denied');
  assert.equal((await rows('mission_team_reviews')).filter((r) => r.team_id === f.teamId).length, 1);
  const notifications = (await rows('outbox')).filter(
    (o) => o.kind === 'team_review_notification' && o.payload.team_id === f.teamId,
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].payload.session_id, context.sessionId);
  assert.equal(notifications[0].payload.context_generation, authority.contextGeneration);
  assert.equal((await rows('mission_team_calls')).filter((r) => r.team_id === f.teamId).length, 3);
  const exposure = (await rows('evidence_refs')).filter(
    (e) => e.session_id === context.sessionId && e.context_generation === authority.contextGeneration,
  );
  assert.ok(exposure.length > 0);
  assert.equal(
    (await rows('mission_team_reservations')).filter((r) => r.team_id === f.teamId && r.state !== 'settled').length,
    0,
  );
});

test('S06-T03/PG01 final coordinator turns cannot exceed aggregate original credits', async () => {
  const f = await stoppedAnalyses();
  await f.teams.advance(context, f.teamId);
  await finishTeamStep(f, 'synthesis');
  await finishTeamStep(f, 'review');
  const initial = await f.teams.reviewSnapshot(context, f.teamId),
    submissionId = String(initial.submission_id),
    final = new TeamFinalReviews(f.teams),
    main = { ...context, provider: 'codex', generation: authority.contextGeneration };
  const claimed = await final.claim(main, f.teamId, submissionId, 'fixture-credit-review');
  assert.equal(claimed.status, 'ok');
  const identity = claimed.identity as { generation: number },
    lease = claimed.lease as { owner: string; fence: number };
  const executing = {
    ...main,
    origin: {
      kind: 'mission_review' as const,
      runId: f.teamId,
      generation: identity.generation,
      submissionId,
      owner: lease.owner,
      fence: lease.fence,
    },
  };
  const allocated = (initial.budgets as Array<{ limits: { model: number }; usage: { model: number } }>).reduce(
    (n, b) => n + b.limits.model - b.usage.model,
    0,
  );
  for (let i = 0; i < allocated; i++)
    assert.deepEqual(await final.reserve(executing, f.teamId, submissionId, lease, 'turn-' + i, 'model'), {
      status: 'ok',
      reserved: true,
    });
  assert.equal(
    (await final.reserve(executing, f.teamId, submissionId, lease, 'excess-turn', 'model')).status,
    'denied',
  );
  assert.deepEqual(await final.reserve(executing, f.teamId, submissionId, lease, 'turn-0', 'model'), {
    status: 'ok',
    reserved: false,
  });
  const calls = (await rows('mission_team_calls')).filter((r) => r.team_id === f.teamId);
  assert.equal(calls.length, allocated);
  const current = await f.teams.reviewSnapshot(context, f.teamId);
  assert.equal(
    (current.budgets as Array<{ limits: { model: number }; usage: { model: number } }>).every(
      (b) => b.limits.model === b.usage.model,
    ),
    true,
  );
  assert.equal(
    (
      await final.reserve(
        { ...executing, generation: randomUUID() },
        f.teamId,
        submissionId,
        lease,
        'foreign-generation',
        'tool',
      )
    ).status,
    'denied',
  );
  assert.equal((await f.teams.cancel(context, f.teamId)).status, 'ok');
  assert.equal((await f.teams.confirmCancellation(context, f.teamId)).status, 'ok');
  assert.equal(
    (await final.reserve(executing, f.teamId, submissionId, lease, 'cancelled-call', 'tool')).status,
    'denied',
  );
});

test('S06-T03 a final main-context grant expires on database time without changing the original root deadline', async () => {
  const f = await stoppedAnalyses();
  await f.teams.advance(context, f.teamId);
  await finishTeamStep(f, 'synthesis');
  await finishTeamStep(f, 'review');
  const initial = await f.teams.reviewSnapshot(context, f.teamId),
    submissionId = String(initial.submission_id),
    final = new TeamFinalReviews(f.teams),
    main = { ...context, provider: 'codex', generation: authority.contextGeneration };
  const claimed = await final.claim(main, f.teamId, submissionId, 'fixture-clock-review');
  assert.equal(claimed.status, 'ok');
  const identity = claimed.identity as { generation: number },
    lease = claimed.lease as { owner: string; fence: number },
    executing = {
      ...main,
      origin: {
        kind: 'mission_review' as const,
        runId: f.teamId,
        generation: identity.generation,
        submissionId,
        owner: lease.owner,
        fence: lease.fence,
      },
    };
  assert.equal((await final.authorize(executing, f.teamId, submissionId, lease)).status, 'ok');
  const remaining = (
    await admin.query('SELECT GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000)::int AS n', [
      claimed.deadline_at,
    ])
  ).rows[0].n;
  await delay(remaining + 80); // No transaction or runtime-pool client remains held during this wait.
  assert.equal((await final.authorize(executing, f.teamId, submissionId, lease)).status, 'denied');
  assert.equal(
    (await final.reserve(executing, f.teamId, submissionId, lease, 'expired-model', 'model')).status,
    'denied',
  );
  const root = (await rows('mission_team_work_orders')).find((w) => w.id === f.teamId)!;
  assert.equal(
    (await admin.query('SELECT $1::timestamptz>clock_timestamp() AS current', [root.body.deadlineAt])).rows[0].current,
    true,
  );
  assert.equal((await f.teams.cancel(context, f.teamId)).status, 'ok');
  assert.equal((await f.teams.confirmCancellation(context, f.teamId)).status, 'ok');
});

test('S06-T05/T06 main-review recovery retires exact retained identity after source loss and cancellation without artifact access', async () => {
  const f = await stoppedAnalyses();
  await f.teams.advance(context, f.teamId);
  await finishTeamStep(f, 'synthesis');
  await finishTeamStep(f, 'review');
  const initial = await f.teams.reviewSnapshot(context, f.teamId),
    submissionId = String(initial.submission_id),
    final = new TeamFinalReviews(f.teams),
    main = { ...context, provider: 'codex', generation: authority.contextGeneration };
  const claimed = await final.claim(main, f.teamId, submissionId, 'fixture-recovery-review');
  assert.equal(claimed.status, 'ok');
  const identity = claimed.identity as { generation: number },
    lease = claimed.lease as { owner: string; fence: number };
  const executing = {
    ...main,
    origin: {
      kind: 'mission_review' as const,
      runId: f.teamId,
      generation: identity.generation,
      submissionId,
      owner: lease.owner,
      fence: lease.fence,
    },
  };
  const root = (await rows('mission_team_work_orders')).find((w) => w.id === f.teamId)!;
  const sourceId = String(root.body.request.sources[0].source_id);
  await admin.query("UPDATE cos.sources SET processing_providers='{}' WHERE scope_id=$1 AND id=$2", [scope, sourceId]);
  const artifacts = knowledge.artifacts,
    read = artifacts.read;
  let artifactReads = 0;
  artifacts.read = () => {
    artifactReads++;
    throw Error('recovery_must_not_read_artifacts');
  };
  try {
    assert.equal(
      (await final.reserve(executing, f.teamId, submissionId, lease, 'revoked-call', 'model')).status,
      'denied',
    );
    const inspected = await final.inspect(main, f.teamId, submissionId);
    assert.equal(inspected.status, 'ok');
    assert.deepEqual(inspected.identity, claimed.identity);
    assert.deepEqual(inspected.lease, claimed.lease);
    await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [scope]);
    assert.equal(
      (await final.retire(main, f.teamId, submissionId, { ...lease, fence: lease.fence + 1 })).status,
      'denied',
    );
    assert.equal((await final.retire(main, f.teamId, submissionId, lease)).status, 'ok');
    assert.equal((await final.retire(main, f.teamId, submissionId, lease)).status, 'ok');
    assert.equal((await f.teams.cancel(context, f.teamId)).status, 'ok');
    const retained = await final.inspect(main, f.teamId, submissionId);
    assert.equal(retained.status, 'ok');
    assert.deepEqual(retained.identity, claimed.identity);
    assert.equal(retained.retired, true);
    assert.equal((await final.inspect({ ...main, generation: randomUUID() }, f.teamId, submissionId)).status, 'denied');
    assert.equal(artifactReads, 0);
  } finally {
    artifacts.read = read;
    await admin.query("UPDATE cos.scopes SET status='active' WHERE id=$1", [scope]);
    await admin.query("UPDATE cos.sources SET processing_providers=ARRAY['codex'] WHERE scope_id=$1 AND id=$2", [
      scope,
      sourceId,
    ]);
  }
  assert.equal((await f.teams.confirmCancellation(context, f.teamId)).status, 'ok');
});

test('S06-T03/T05 retained main review acknowledgement replays after credit use without another invocation grant', async () => {
  const f = await stoppedAnalyses();
  await f.teams.advance(context, f.teamId);
  await finishTeamStep(f, 'synthesis');
  await finishTeamStep(f, 'review');
  const initial = await f.teams.reviewSnapshot(context, f.teamId),
    submissionId = String(initial.submission_id),
    final = new TeamFinalReviews(f.teams),
    main = { ...context, provider: 'codex', generation: authority.contextGeneration };
  assert.ok(
    ((await final.pending(main)).items as Array<{ mission_id: string }>).some((i) => i.mission_id === f.teamId),
  );
  const claimed = await final.claim(main, f.teamId, submissionId, 'fixture-replay-main');
  assert.equal(claimed.status, 'ok');
  const identity = claimed.identity as { generation: number },
    lease = claimed.lease as { owner: string; fence: number };
  const executing = {
    ...main,
    origin: {
      kind: 'mission_review' as const,
      runId: f.teamId,
      generation: identity.generation,
      submissionId,
      owner: lease.owner,
      fence: lease.fence,
    },
  };
  for (let i = 0; i < 20; i++) {
    const r = await final.reserve(executing, f.teamId, submissionId, lease, 'exhaust-main-' + i, 'model');
    if (r.status === 'denied') break;
    assert.equal(r.status, 'ok');
  }
  assert.deepEqual(await final.claim(main, f.teamId, submissionId, 'fixture-replay-main'), claimed);
  assert.equal(
    (await final.reserve(executing, f.teamId, submissionId, lease, 'exhausted-new-call', 'model')).status,
    'denied',
  );
  assert.equal((await final.retire(main, f.teamId, submissionId, lease)).status, 'ok');
  assert.equal((await final.claim(main, f.teamId, submissionId, 'fixture-replay-main')).status, 'denied');
  await f.teams.cancel(context, f.teamId);
  await f.teams.confirmCancellation(context, f.teamId);
});

test('S06-T05/T07 graph rework cannot replace evidence while retained main review is unretired', async () => {
  const f = await stoppedAnalyses(false, (r) => {
    r.limits.max_attempts = 9;
    r.steps.find((s) => s.step_id === 'synthesis')!.max_rework_count = 1;
  });
  await f.teams.advance(context, f.teamId);
  await finishTeamStep(f, 'synthesis');
  const review = await finishTeamStep(f, 'review', 'synthesis');
  const initial = await f.teams.reviewSnapshot(context, f.teamId),
    submissionId = String(initial.submission_id),
    final = new TeamFinalReviews(f.teams),
    main = { ...context, provider: 'codex', generation: authority.contextGeneration };
  const claimed = await final.claim(main, f.teamId, submissionId, 'fixture-rework-fence');
  assert.equal(claimed.status, 'ok');
  const before = (await rows('mission_team_roots')).find((r) => r.id === f.teamId)!;
  assert.equal(
    (await f.teams.requestRework(context, f.teamId, String(review.submitted.submission_id))).status,
    'denied',
  );
  assert.deepEqual(
    (await rows('mission_team_roots')).find((r) => r.id === f.teamId),
    before,
  );
  assert.equal(
    (await final.retire(main, f.teamId, submissionId, claimed.lease as { owner: string; fence: number })).status,
    'ok',
  );
  assert.equal((await f.teams.requestRework(context, f.teamId, String(review.submitted.submission_id))).status, 'ok');
  await f.teams.cancel(context, f.teamId);
  await f.teams.confirmCancellation(context, f.teamId);
});
