import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  for (const table of ['mission_team_work_orders', 'mission_team_dependencies', 'mission_team_budget_events']) {
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
    const claim = await store.missionRuns.claimDispatch(context, attempt.id, 'fixture-host');
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
