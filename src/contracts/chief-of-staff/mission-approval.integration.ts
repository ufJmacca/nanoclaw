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
import { RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { installReviewedMissionTemplate } from '../../modules/chief-of-staff/missions/template-admin.js';
import type { CosBinding } from '../../cos-boundary.js';

const scope = 'mission-approval-' + randomUUID();
const context = { scopeId: scope, ownerId: 'owner', agentGroupId: scope, sessionId: scope, ingressId: randomUUID() };
const binding: CosBinding = {
  scopeId: scope,
  ownerId: 'owner',
  agentGroupId: scope,
  sessionId: scope,
  instanceId: 'fixture',
  channelId: scope,
  messagingGroupId: 'fixture-messaging',
  botId: 'fixture-bot',
  provider: 'codex',
};
const delegation = {
  expectedRevision: 0,
  enabled: true,
  templateDigest: digest(RESEARCH_TEMPLATE),
  reviewRef: 'fixture-operator-review',
};
let authority = {
  bindingDigest: digest('private owner-approved delegation'),
  delegationDigest: digest('operator delegation revision one'),
  contextGeneration: randomUUID(),
  provider: {
    profile: RESEARCH_TEMPLATE.providerProfile,
    model: 'fixture-codex',
    policyDigest: digest('fixture policy'),
  },
};
let enabled = true;
let admin: pg.Client, store: PriorityStore, knowledge: KnowledgeStore, base: string;
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mission-approval-'));
  for (const dir of ['artifacts', 'staging']) fs.mkdirSync(path.join(base, dir), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(base, 'artifacts'), path.join(base, 'staging')),
  );
  store = new PriorityStore(database, knowledge, undefined, undefined, () => (enabled ? authority : null));
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'owner','fixture',$1,$1,'active')",
    [scope],
  );
});
after(async () => {
  if (admin) {
    await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
    for (const table of [
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
    ])
      await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
  }
  await store?.database.pool.end();
  await admin?.end();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});
async function request() {
  const id = randomUUID();
  fs.writeFileSync(
    path.join(base, 'staging', id + '.md'),
    'SOURCE_CANARY_' + id + '\nA costs less; B has more capacity.',
    { mode: 0o600 },
  );
  const source = await knowledge.importSource(context, randomUUID(), {
    sourceKey: id,
    filename: id + '.md',
    title: 'Admitted comparison note',
    processingProviders: ['codex'],
    expectedVersion: 0,
  });
  assert.equal(source.status, 'ok');
  return {
    question: 'Compare A and B.',
    goal_id: null,
    project_id: null,
    sources: [{ source_id: String(source.source_id), revision_id: String(source.revision_id) }],
    acceptance_criteria: [{ id: 'tradeoff', description: 'Explain the cost and capacity tradeoff.' }],
    limits: { ...MISSION_DEFAULT_LIMITS },
  };
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
async function rows(table: string) {
  return (await admin.query(`SELECT * FROM cos.${table} WHERE scope_id=$1 ORDER BY created_at`, [scope])).rows;
}
test('S05-T03 no mission proposal without an operator-reviewed template and explicit current delegation authority', async () => {
  const input = await request();
  assert.equal((await store.requestMission(context, randomUUID(), input)).status, 'denied');
  await admin.query('BEGIN');
  await installReviewedMissionTemplate(admin, binding, randomUUID(), delegation);
  await admin.query('COMMIT');
  enabled = false;
  try {
    assert.equal((await store.requestMission(context, randomUUID(), input)).status, 'denied');
  } finally {
    enabled = true;
  }
  const unconfigured = new PriorityStore(store.database, knowledge);
  assert.equal((await unconfigured.requestMission(context, randomUUID(), input)).status, 'denied');
  assert.equal((await rows('mission_attempts')).length, 0);
});
test('S05-T03 operator template installation replays exact bytes and never overwrites altered review or scope', async () => {
  const before = await rows('mission_template_versions');
  await admin.query('BEGIN');
  try {
    await installReviewedMissionTemplate(admin, binding, randomUUID(), delegation);
    assert.deepEqual(await rows('mission_template_versions'), before);
    for (const patch of [{ ownerId: 'foreign' }, { channelId: 'foreign' }, { agentGroupId: 'foreign' }]) {
      await assert.rejects(
        installReviewedMissionTemplate(admin, { ...binding, ...patch }, randomUUID(), delegation),
        /context_binding_changed/,
      );
    }
    await admin.query("UPDATE cos.mission_template_versions SET reviewed_by='foreign' WHERE scope_id=$1", [scope]);
    await assert.rejects(
      installReviewedMissionTemplate(admin, binding, randomUUID(), delegation),
      /mission_template_conflict/,
    );
    await admin.query('UPDATE cos.mission_template_versions SET reviewed_by=$2,body=$3 WHERE scope_id=$1', [
      scope,
      binding.ownerId,
      JSON.stringify({ ...RESEARCH_TEMPLATE, instructions: 'changed' }),
    ]);
    await assert.rejects(
      installReviewedMissionTemplate(admin, binding, randomUUID(), delegation),
      /mission_template_conflict/,
    );
  } finally {
    await admin.query('ROLLBACK');
  }
  assert.deepEqual(await rows('mission_template_versions'), before);
  const runtime = await connectFixtureDatabase(process.env, 'runtime');
  try {
    await assert.rejects(
      runtime.query('UPDATE cos.mission_template_versions SET reviewed_by=$2 WHERE scope_id=$1', [scope, 'model']),
      (error: any) => error.code === '42501',
    );
  } finally {
    await runtime.end();
  }
});
test('S05-T05 request returns a stable ID and full exact approval preview without launching or reserving attempts', async () => {
  const input = await request(),
    id = randomUUID();
  const proposal = await store.requestMission(context, id, input);
  assert.equal(proposal.status, 'ok');
  assert.match(String(proposal.mission_id), /^mission-/);
  assert.deepEqual(await store.requestMission(context, id, input), proposal);
  assert.equal(
    (await store.requestMission(context, id, { ...input, question: 'Changed question' })).status,
    'conflict',
  );
  assert.equal((await rows('mission_attempts')).length, 0);
  assert.equal((await rows('mission_budget_reservations')).length, 0);
  const change = proposal.change as any;
  assert.equal(change.work_order.request.question, input.question);
  assert.equal(change.work_order_digest, digest(change.work_order));
  assert.equal((await store.apply(scope, String(proposal.proposal_id))).status, 'denied');
  assert.equal(
    (
      await store.decide(
        { ...context, ownerId: 'intruder' },
        String(proposal.proposal_id),
        String(proposal.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  const applied = await approve(proposal);
  assert.equal(applied.status, 'ok');
  assert.equal(applied.record_id, proposal.mission_id);
  assert.deepEqual(await store.apply(scope, String(proposal.proposal_id)), applied);
  const attempts = await rows('mission_attempts'),
    budgets = await rows('mission_budget_reservations');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, 'queued');
  assert.equal(attempts[0].generation, 1);
  assert.equal(budgets.length, 1);
  assert.equal(budgets[0].kind, 'attempt');
  assert.equal(budgets[0].attempt_id, attempts[0].id);
  const stored = await rows('mission_context_manifests');
  assert.doesNotMatch(JSON.stringify(stored), /SOURCE_CANARY/);
});
test('S05-T05 concurrent identical requests create one proposal and concurrent application queues one identity', async () => {
  const input = await request(),
    id = randomUUID();
  const all = await Promise.all(Array.from({ length: 4 }, () => store.requestMission(context, id, input)));
  all.forEach((p) => assert.deepEqual(p, all[0]));
  assert.equal(all[0].status, 'ok');
  await approve(all[0]);
  await Promise.all(Array.from({ length: 4 }, () => store.apply(scope, String(all[0].proposal_id))));
  assert.equal((await rows('mission_attempts')).filter((a) => a.mission_id === all[0].mission_id).length, 1);
});
test('S05-T07 revoked sources suppress preview, request replay and approved application', async () => {
  const input = await request(),
    id = randomUUID(),
    p = await store.requestMission(context, id, input);
  assert.equal(p.status, 'ok');
  await admin.query("UPDATE cos.sources SET status='revoked' WHERE scope_id=$1 AND id=$2", [
    scope,
    input.sources[0].source_id,
  ]);
  assert.equal((await store.requestMission(context, id, input)).status, 'denied');
  assert.equal((await store.status(context, id)).status, 'denied');
  const pending = await store.pendingOutbox(scope);
  assert.ok(!(pending.items as any[]).some((item) => item.payload.proposal_id === p.proposal_id));
  assert.equal((await approve(p)).status, 'conflict');
  assert.ok(!(await rows('mission_attempts')).some((a) => a.mission_id === p.mission_id));
});
test('S05-T07 changed native context or private binding cannot inherit an existing approval', async () => {
  for (const field of ['contextGeneration', 'bindingDigest'] as const) {
    const p = await store.requestMission(context, randomUUID(), await request());
    assert.equal(p.status, 'ok');
    const saved = authority;
    authority = { ...authority, [field]: field === 'bindingDigest' ? digest(randomUUID()) : randomUUID() };
    try {
      assert.equal((await approve(p)).status, 'conflict');
    } finally {
      authority = saved;
    }
  }
});
test('S05-T07 re-enabling delegation cannot resurrect a previously approved mission', async () => {
  const saved = authority;
  try {
    const input = await request(),
      id = randomUUID();
    const proposal = await store.requestMission(context, id, input);
    assert.equal(proposal.status, 'ok');
    enabled = false;
    assert.equal((await store.requestMission(context, id, input)).status, 'denied');
    authority = { ...authority, delegationDigest: digest('operator delegation revision three') };
    enabled = true;
    assert.equal((await store.requestMission(context, id, input)).status, 'denied');
    assert.equal((await approve(proposal)).status, 'conflict');
    assert.ok(!(await rows('mission_attempts')).some((a) => a.mission_id === proposal.mission_id));
    const fresh = await store.requestMission(context, randomUUID(), input);
    assert.equal(fresh.status, 'ok');
    assert.equal((await approve(fresh)).status, 'ok');
  } finally {
    enabled = true;
    authority = saved;
  }
});
test('S05-T03 model cannot bypass admission with a forged work order or attach it to another origin', async () => {
  const p = await store.requestMission(context, randomUUID(), await request());
  assert.equal(p.status, 'ok');
  const change = p.change as any;
  assert.equal(
    (
      await store.propose(context, randomUUID(), {
        ...change,
        work_order: { ...change.work_order, question: 'forged' },
      })
    ).status,
    'denied',
  );
  assert.equal((await store.propose(context, randomUUID(), change)).status, 'denied');
  assert.equal(
    (await store.requestMission({ ...context, ownerId: 'other' }, randomUUID(), await request())).status,
    'denied',
  );
});
test('S05-T03 changed related-record version or provider policy invalidates the exact work order', async () => {
  const projectId = randomUUID();
  await admin.query(
    "INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance) VALUES($1,$2,'project','Pilot','Fixture','active',1,'{}')",
    [projectId, scope],
  );
  const input = { ...(await request()), project_id: projectId };
  const p = await store.requestMission(context, randomUUID(), input);
  assert.equal(p.status, 'ok');
  assert.equal((p.change as any).work_order.related.project.version, 1);
  await admin.query('UPDATE cos.records SET version=version+1 WHERE scope_id=$1 AND id=$2', [scope, projectId]);
  assert.equal((await approve(p)).status, 'conflict');
  const next = await store.requestMission(context, randomUUID(), input);
  assert.equal(next.status, 'ok');
  const saved = authority;
  authority = { ...authority, provider: { ...authority.provider, policyDigest: digest('changed provider policy') } };
  try {
    assert.equal((await approve(next)).status, 'conflict');
  } finally {
    authority = saved;
  }
});
test('S05-T03 operator review must match the installed template bytes and schedules cannot delegate', async () => {
  const input = await request();
  await admin.query('UPDATE cos.mission_template_versions SET body=$2 WHERE scope_id=$1', [
    scope,
    JSON.stringify({ ...RESEARCH_TEMPLATE, instructions: 'Changed without review' }),
  ]);
  try {
    assert.equal((await store.requestMission(context, randomUUID(), input)).status, 'denied');
  } finally {
    await admin.query('UPDATE cos.mission_template_versions SET body=$2 WHERE scope_id=$1', [
      scope,
      JSON.stringify(RESEARCH_TEMPLATE),
    ]);
  }
  assert.equal(
    (
      await store.requestMission(
        { ...context, origin: { kind: 'schedule', runId: randomUUID(), generation: 1 } },
        randomUUID(),
        input,
      )
    ).status,
    'denied',
  );
});
test('S05-T09 an elapsed sealed deadline cannot be extended through replay or approval', async () => {
  const input = await request(),
    id = randomUUID();
  const p = await store.requestMission(context, id, input);
  assert.equal(p.status, 'ok');
  // Trusted fixture administration models an old, consistently sealed request without sleeping for its budget.
  const change = p.change as any,
    body = { ...change.work_order, issuedAt: '2020-01-01T00:00:00.000Z', deadlineAt: '2020-01-01T00:10:00.000Z' };
  const updated = { ...change, work_order: body, work_order_digest: digest(body) };
  await admin.query('UPDATE cos.mission_work_orders SET body=$3,digest=$4 WHERE scope_id=$1 AND id=$2', [
    scope,
    p.mission_id,
    JSON.stringify(body),
    digest(body),
  ]);
  await admin.query('UPDATE cos.proposals SET change=$3,payload_hash=$4 WHERE scope_id=$1 AND id=$2', [
    scope,
    p.proposal_id,
    JSON.stringify(updated),
    digest(updated),
  ]);
  assert.equal((await approve(p)).status, 'conflict');
  assert.equal((await store.requestMission(context, id, input)).status, 'denied');
  assert.ok(!(await rows('mission_attempts')).some((a) => a.mission_id === p.mission_id));
});
async function faultStore(fail: (sql: string, after: boolean) => boolean) {
  const pool = new pg.Pool(await fixtureDatabaseConfig()),
    connection = await pool.connect();
  const original = connection.query.bind(connection);
  let fired = false;
  connection.query = (async (...args: unknown[]) => {
    const sql = String(args[0]);
    if (!fired && fail(sql, false)) {
      fired = true;
      throw new Error('fixture_before_commit');
    }
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    if (!fired && fail(sql, true)) {
      fired = true;
      throw new Error('fixture_lost_ack');
    }
    return result;
  }) as typeof connection.query;
  connection.release();
  return {
    pool,
    store: new PriorityStore(new BoundedDatabase(pool), knowledge, undefined, undefined, () =>
      enabled ? authority : null,
    ),
  };
}
test('S05-T05/T06 lost request and apply acknowledgements recover one proposal, attempt and budget', async () => {
  const input = await request(),
    id = randomUUID();
  const first = await faultStore((sql, after) => sql === 'COMMIT' && after);
  try {
    assert.equal((await first.store.requestMission(context, id, input)).status, 'pending');
  } finally {
    await first.pool.end();
  }
  const p = await store.requestMission(context, id, input);
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
  const second = await faultStore((sql, after) => sql === 'COMMIT' && after);
  try {
    assert.equal((await second.store.apply(scope, String(p.proposal_id))).status, 'pending');
  } finally {
    await second.pool.end();
  }
  assert.equal((await store.apply(scope, String(p.proposal_id))).status, 'ok');
  assert.equal((await rows('missions')).filter((m) => m.id === p.mission_id).length, 1);
  assert.equal((await rows('mission_attempts')).filter((a) => a.mission_id === p.mission_id).length, 1);
  assert.equal((await rows('mission_budget_reservations')).filter((b) => b.mission_id === p.mission_id).length, 1);
});
test('S05-T06 failed proposal publication rolls back work order, manifest and mission together', async () => {
  const input = await request(),
    id = randomUUID();
  const faulty = await faultStore((sql, after) => !after && sql.startsWith('INSERT INTO cos.outbox'));
  try {
    assert.equal((await faulty.store.requestMission(context, id, input)).status, 'pending');
  } finally {
    await faulty.pool.end();
  }
  const missionId = 'mission-' + digest({ scopeId: scope, sessionId: context.sessionId, requestId: id });
  assert.ok(!(await rows('missions')).some((m) => m.id === missionId));
  assert.ok(!(await rows('mission_work_orders')).some((w) => w.id === missionId));
  assert.ok(!(await rows('mission_context_manifests')).some((m) => m.provenance.request_id === id));
  const recovered = await store.requestMission(context, id, input);
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.mission_id, missionId);
});
