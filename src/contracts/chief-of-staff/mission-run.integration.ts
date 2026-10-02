import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import Database from 'better-sqlite3';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations as migrateNative } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { installCosMissionBoundary } from '../../cos-mission-boundary.js';
import { installCosMissionExecutionHooks } from '../../cos-mission-execution.js';
import { installCosBoundary, permitCosOutbound, type CosBinding } from '../../cos-boundary.js';
import { INBOUND_SCHEMA } from '../../db/schema.js';
import { ensureConversationSchema } from '../../modules/chief-of-staff/bridge/conversation-state.js';
import { createCosRuntime } from '../../modules/chief-of-staff/runtime.js';
import { NativeMissionReviewTasks } from '../../modules/chief-of-staff/missions/review-task.js';
import { NativeBriefTasks } from '../../modules/chief-of-staff/automation/native-tasks.js';
import { reviewContext, readReviewOrigin } from '../../modules/chief-of-staff/missions/review-origin.js';
import { resolveKnowledgeContext } from '../../modules/chief-of-staff/knowledge/context.js';
import { getDeliveryAdapter, setDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';
import { createMissionRpcHandler } from '../../modules/chief-of-staff/missions/rpc.js';
import { createRpcHandler } from '../../modules/chief-of-staff/bridge/rpc.js';
import { createMissionCancellation } from '../../modules/chief-of-staff/missions/cancel.js';
import { isCosMissionStopped } from '../../cos-mission-stop.js';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MISSION_DEFAULT_LIMITS, type MissionLimits } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import type { CosMissionIdentity } from '../../cos-mission-boundary.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { MissionRunStore, type MissionDispatchLease } from '../../modules/chief-of-staff/missions/run-store.js';
import type { MissionResult } from '../../modules/chief-of-staff/contracts/mission-result.js';
import { MissionReviews } from '../../modules/chief-of-staff/missions/review-store.js';
import type { MissionReview } from '../../modules/chief-of-staff/contracts/mission-review.js';
import { MissionNotifications } from '../../modules/chief-of-staff/missions/notifications.js';
import { MissionNotificationDelivery } from '../../modules/chief-of-staff/missions/notification-delivery.js';
import { MissionReviewRuns } from '../../modules/chief-of-staff/missions/review-runs.js';

const scope = 'mission-run-' + randomUUID();
const context = { scopeId: scope, ownerId: 'owner', agentGroupId: scope, sessionId: scope, ingressId: randomUUID() };
const authority = {
  bindingDigest: digest('private owner-approved delegation'),
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
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mission-run-'));
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
  await admin.query(
    'INSERT INTO cos.mission_template_versions(scope_id,id,version,body,digest,reviewed_by,provenance) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      scope,
      RESEARCH_TEMPLATE.id,
      RESEARCH_TEMPLATE.version,
      JSON.stringify(RESEARCH_TEMPLATE),
      digest(RESEARCH_TEMPLATE),
      'fixture-operator',
      '{}',
    ],
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
async function mission(limits: Partial<MissionLimits> = { max_turns: 2, max_tool_calls: 2, max_attempts: 2 }) {
  const input = await request();
  Object.assign(input.limits, limits);
  const p = await store.requestMission(context, randomUUID(), input);
  assert.equal(p.status, 'ok');
  assert.equal((await approve(p)).status, 'ok');
  const a = (await rows('mission_attempts')).find((a) => a.mission_id === p.mission_id);
  const identity: CosMissionIdentity = {
    scopeId: scope,
    missionId: a.mission_id,
    attemptId: a.id,
    generation: a.generation,
    agentGroupId: a.agent_group_id,
    sessionId: a.session_id,
    provider: 'codex',
  };
  return { identity, input };
}
async function running(identity: CosMissionIdentity) {
  // Fixture models successful native admission. No worker launch is implemented or claimed by these store tests.
  await admin.query("UPDATE cos.mission_attempts SET state='running' WHERE scope_id=$1 AND id=$2", [
    scope,
    identity.attemptId,
  ]);
  await admin.query("UPDATE cos.missions SET state='running' WHERE scope_id=$1 AND id=$2", [scope, identity.missionId]);
}
const reserve = (
  i: CosMissionIdentity,
  id = randomUUID(),
  kind: 'model' | 'tool' = 'model',
  payload = digest('fixture-call'),
) => store.missionRuns.reserve(i, id, kind, payload);
test('S05-T05/T07 coordinator RPC proposes without launching, inspects the approved mission and durably cancels', async () => {
  const native = initTestDb();
  migrateNative(native);
  const inbox = new Database(':memory:');
  const main = { id: context.sessionId, agent_group_id: context.agentGroupId } as ReturnType<typeof getSession> &
    object;
  let stopped = 0;
  const handler = createRpcHandler({
    resolveContext: async () => context,
    store,
    cancelMission: createMissionCancellation({
      db: native,
      runs: store.missionRuns,
      stop: () => {
        stopped++;
      },
    }),
  });
  async function call(method: string, params: Record<string, unknown>, requestId = randomUUID()) {
    const request = { protocol: 'cos-rpc/v1', request_id: requestId, method, params },
      delivery_id = randomUUID();
    await handler({ action: 'cos_rpc', request, delivery_id }, main, inbox);
    return JSON.parse(
      (
        inbox
          .prepare('SELECT response FROM cos_rpc_responses WHERE request_id=? AND payload_hash=? AND delivery_id=?')
          .get(requestId, digest(request), delivery_id) as { response: string }
      ).response,
    );
  }
  try {
    const input = await request(),
      requestId = randomUUID();
    const proposed = await call('cos_mission_request', { request: input }, requestId);
    assert.equal(proposed.status, 'ok');
    assert.equal(proposed.result.confirmation_token, undefined);
    const missionId = proposed.result.mission_id;
    assert.equal((await rows('mission_attempts')).filter((r) => r.mission_id === missionId).length, 0);
    const hostPreview = await store.requestMission(context, requestId, input);
    assert.equal((await approve(hostPreview)).status, 'ok');
    assert.equal((await call('cos_mission_get', { mission_id: missionId })).result.mission.state, 'queued');
    const a = (await rows('mission_attempts')).find((r) => r.mission_id === missionId);
    const identity: CosMissionIdentity = {
      scopeId: scope,
      missionId,
      attemptId: a.id,
      generation: a.generation,
      agentGroupId: a.agent_group_id,
      sessionId: a.session_id,
      provider: 'codex',
    };
    installCosMissionBoundary(identity, native);
    const cancelled = await call('cos_mission_cancel', { mission_id: missionId });
    assert.equal(cancelled.status, 'ok');
    assert.equal(cancelled.result.state, 'cancelling');
    assert.equal(isCosMissionStopped(identity, native), true);
    assert.equal(stopped, 1);
    assert.equal((await store.missionRuns.claimDispatch(context, identity.attemptId, 'host')).status, 'denied');
    assert.equal((await call('cos_mission_get', { mission_id: missionId })).result.mission.state, 'cancelling');
  } finally {
    inbox.close();
    closeDb();
  }
});
const blockedResult = (): MissionResult => ({
  format: 'cos-research-result/v1',
  outcome: 'blocked',
  claims: [],
  criteria: [{ id: 'tradeoff', claim_ids: [] }],
  limitations: ['RESULT_CANARY: insufficient cost evidence.'],
});
async function submitted(
  outcome: 'answer' | 'partial' | 'blocked' = 'answer',
  stop = true,
  wallSeconds = 600,
  limits: Partial<MissionLimits> = {},
  workerModelCalls = 0,
) {
  authority.contextGeneration = randomUUID();
  const { identity, input } = await mission({
    max_turns: 2,
    max_tool_calls: 2,
    max_attempts: 2,
    wall_seconds: wallSeconds,
    ...limits,
  });
  const lease = await dispatched(identity);
  for (let n = 0; n < workerModelCalls; n++) {
    assert.deepEqual(
      await store.missionRuns.reserve(identity, randomUUID(), 'model', digest('fixture specialist turn')),
      { status: 'ok', reserved: true },
    );
  }
  const result: MissionResult =
    outcome === 'blocked'
      ? blockedResult()
      : {
          format: 'cos-research-result/v1',
          outcome,
          claims: [
            {
              id: 'comparison',
              kind: 'quote',
              text: 'A costs less; B has more capacity.',
              citations: [{ ...input.sources[0], ordinal: 0, start_line: 2, end_line: 2 }],
            },
          ],
          criteria: [{ id: 'tradeoff', claim_ids: ['comparison'] }],
          limitations: outcome === 'partial' ? ['Only cost and capacity were compared.'] : [],
        };
  const receipt = await store.missionRuns.submitResult(identity, lease, randomUUID(), randomUUID(), result);
  assert.equal(receipt.status, 'ok');
  if (stop) assert.equal((await store.missionRuns.confirmStopped(identity)).status, 'ok');
  const k = { ...context, provider: 'codex', generation: authority.contextGeneration };
  const reviews = new MissionReviews(store.database, store.missions, knowledge);
  const m = (await rows('missions')).find((r) => r.id === identity.missionId);
  const review: MissionReview = {
    mission_id: identity.missionId,
    submission_id: String(receipt.submission_id),
    result_digest: digest(result),
    expected_version: m.version,
    decision: 'accept',
    criteria: [{ id: 'tradeoff', verdict: 'satisfied' }],
  };
  return { identity, input, result, k, reviews, review };
}
test('S05-T08 coordinator reads the exact artifact and records review with one atomic notification command', async () => {
  const f = await submitted();
  const read = await f.reviews.read(f.k, f.identity.missionId, f.review.submission_id);
  assert.equal(read.status, 'ok');
  assert.deepEqual(read.result, f.result);
  const status = await store.missionRuns.inspect(context, f.identity.missionId);
  assert.deepEqual((status.mission as any).submission, {
    id: f.review.submission_id,
    digest: f.review.result_digest,
    review_id: null,
    notification_state: null,
  });
  assert.equal((await rows('missions')).find((r) => r.id === f.identity.missionId).state, 'awaiting_review');
  assert.equal(
    (await rows('evidence_refs')).some(
      (r) =>
        r.session_id === context.sessionId &&
        r.context_generation === f.k.generation &&
        r.source_id === f.input.sources[0].source_id,
    ),
    true,
  );
  const requestId = randomUUID(),
    accepted = await f.reviews.review(f.k, requestId, f.review);
  assert.equal(accepted.status, 'ok');
  assert.equal(accepted.state, 'completed');
  assert.deepEqual(await f.reviews.review(f.k, requestId, f.review), accepted);
  assert.equal((await f.reviews.review(f.k, requestId, { ...f.review, decision: 'partial' })).status, 'conflict');
  const recorded = (await rows('mission_reviews')).filter((r) => r.mission_id === f.identity.missionId);
  assert.equal(recorded.length, 1);
  assert.equal(JSON.stringify(recorded).includes('A costs less'), false);
  const commands = (await rows('outbox')).filter(
    (r) => r.kind === 'mission_review_notification' && r.payload.mission_id === f.identity.missionId,
  );
  assert.equal(commands.length, 1);
  assert.equal(JSON.stringify(commands).includes('A costs less'), false);
  assert.equal(commands[0].delivered_at, null);
});
test('S05-T08 a saved result can be reviewed after the original execution deadline without reopening the worker', async () => {
  const f = await submitted('answer', true, 30, { max_tool_calls: 6 });
  const automatic = new MissionReviewRuns(f.reviews);
  const claim = await automatic.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host');
  assert.equal(claim.status, 'ok');
  const order = (await rows('mission_work_orders')).find((r) => r.id === f.identity.missionId);
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Date.parse(order.body.deadlineAt) - Date.now() + 150)),
  );
  assert.equal((await reserve(f.identity)).status, 'denied');
  assert.equal((await store.missionRuns.claimDispatch(context, f.identity.attemptId, 'host')).status, 'denied');
  assert.equal(
    (await automatic.authorize(f.k, f.identity.missionId, f.review.submission_id, claim.lease as any)).status,
    'denied',
  );
  assert.equal(
    (await automatic.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host')).status,
    'denied',
  );
  assert.equal((await f.reviews.read(f.k, f.identity.missionId, f.review.submission_id)).status, 'ok');
  assert.equal((await f.reviews.review(f.k, randomUUID(), f.review)).state, 'completed');
  assert.equal((await rows('mission_work_orders')).find((r) => r.id === f.identity.missionId).digest, order.digest);
});
test('S05-T05 automatic review claims a stable main-context task only after the specialist is stopped', async () => {
  const f = await submitted('answer', false, 600, { max_tool_calls: 6 });
  const runs = new MissionReviewRuns(f.reviews);
  const claim = () => runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host');
  assert.equal((await claim()).status, 'denied');
  await store.missionRuns.confirmStopped(f.identity);
  assert.equal(
    (await runs.claim({ ...f.k, ownerId: 'foreign' }, f.identity.missionId, f.review.submission_id, 'review-host'))
      .status,
    'denied',
  );
  const first = await claim();
  assert.equal(first.status, 'ok');
  assert.deepEqual(await claim(), first);
  assert.equal((first.identity as any).sessionId, context.sessionId);
  assert.notEqual((first.identity as any).sessionId, f.identity.sessionId);
  assert.equal((await runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'other-host')).status, 'pending');
  assert.equal(
    (await runs.authorize(f.k, f.identity.missionId, f.review.submission_id, first.lease as any)).status,
    'ok',
  );
  const renewed = await runs.renew(f.k, f.identity.missionId, f.review.submission_id, first.lease as any);
  assert.equal(renewed.status, 'ok');
  assert.ok(
    Date.parse(String(renewed.deadline_at)) <=
      Date.parse((await rows('mission_work_orders')).find((r) => r.id === f.identity.missionId).body.deadlineAt),
  );
  await admin.query(
    "UPDATE cos.mission_attempts SET allocation=jsonb_set(allocation,'{coordinator_review,deadlineAt}',to_jsonb((clock_timestamp()-interval '1 second')::text)) WHERE scope_id=$1 AND id=$2",
    [scope, f.identity.attemptId],
  );
  assert.equal(
    (await runs.authorize(f.k, f.identity.missionId, f.review.submission_id, first.lease as any)).status,
    'denied',
  );
  assert.equal(
    (await runs.renew(f.k, f.identity.missionId, f.review.submission_id, first.lease as any)).status,
    'denied',
  );
  const next = await runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'other-host');
  assert.equal(next.status, 'ok');
  assert.equal(next.input_id, first.input_id);
  assert.deepEqual(next.identity, first.identity);
  assert.equal((next.lease as any).fence, (first.lease as any).fence + 1);
  assert.equal(
    (await runs.retire(f.k, f.identity.missionId, f.review.submission_id, first.lease as any)).status,
    'denied',
  );
  assert.equal(
    (await runs.authorize(f.k, f.identity.missionId, f.review.submission_id, next.lease as any)).status,
    'ok',
  );
  assert.equal(
    (await runs.authorize(f.k, f.identity.missionId, f.review.submission_id, first.lease as any)).status,
    'denied',
  );
});
test('S05-T06/T07 review recovery reads only metadata and durably retires an exact lease after source revocation', async () => {
  const f = await submitted('answer', true, 600, { max_tool_calls: 6 }),
    runs = new MissionReviewRuns(f.reviews);
  const pending = await runs.pending(f.k);
  assert.deepEqual(pending, {
    status: 'ok',
    items: [{ mission_id: f.identity.missionId, submission_id: f.review.submission_id }],
  });
  const claim = await runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host'),
    lease = claim.lease as any;
  assert.equal(claim.status, 'ok');
  await admin.query("UPDATE cos.sources SET status='revoked' WHERE id=$1", [f.input.sources[0].source_id]);
  const inspected = await runs.inspect(f.k, f.identity.missionId, f.review.submission_id);
  assert.equal(inspected.status, 'ok');
  assert.equal(JSON.stringify(inspected).includes('A costs less'), false);
  assert.deepEqual(inspected.identity, claim.identity);
  assert.equal((inspected.task as any).inputId, claim.input_id);
  assert.equal(
    (await runs.inspect({ ...f.k, ownerId: 'foreign' }, f.identity.missionId, f.review.submission_id)).status,
    'denied',
  );
  assert.equal(
    (await runs.retire(f.k, f.identity.missionId, f.review.submission_id, { ...lease, fence: lease.fence + 1 })).status,
    'denied',
  );
  assert.equal((await runs.retire(f.k, f.identity.missionId, f.review.submission_id, lease)).status, 'ok');
  assert.equal((await runs.retire(f.k, f.identity.missionId, f.review.submission_id, lease)).status, 'ok');
  assert.equal((await runs.inspect(f.k, f.identity.missionId, f.review.submission_id)).retired, true);
  assert.deepEqual(await runs.pending(f.k), { status: 'ok', items: [] });
  await admin.query("UPDATE cos.sources SET status='current' WHERE id=$1", [f.input.sources[0].source_id]);
  assert.equal((await runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host')).status, 'denied');
  assert.equal((await runs.authorize(f.k, f.identity.missionId, f.review.submission_id, lease, true)).status, 'denied');
  assert.equal((await f.reviews.review(f.k, randomUUID(), f.review)).state, 'completed');
});
test('S05-T06/T07 metadata recovery denies foreign identities and closes expired grants after cancellation', async () => {
  const f = await submitted('answer', true, 600, { max_tool_calls: 6 }),
    runs = new MissionReviewRuns(f.reviews);
  const claim = await runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host'),
    lease = claim.lease as any;
  assert.equal(claim.status, 'ok');
  for (const changed of [
    { ownerId: 'foreign' },
    { sessionId: 'foreign' },
    { agentGroupId: 'foreign' },
    { generation: randomUUID() },
    { provider: 'other' },
    { origin: { kind: 'schedule' as const, runId: randomUUID(), generation: 1 } },
  ]) {
    assert.equal(
      (await runs.inspect({ ...f.k, ...changed }, f.identity.missionId, f.review.submission_id)).status,
      'denied',
    );
    assert.equal(
      (await runs.retire({ ...f.k, ...changed }, f.identity.missionId, f.review.submission_id, lease)).status,
      'denied',
    );
  }
  assert.deepEqual(await runs.pending({ ...f.k, generation: randomUUID() }), { status: 'ok', items: [] });
  await admin.query(
    "UPDATE cos.mission_attempts SET allocation=jsonb_set(allocation,'{coordinator_review,deadlineAt}',to_jsonb((clock_timestamp()-interval '1 second')::text)) WHERE scope_id=$1 AND id=$2",
    [scope, f.identity.attemptId],
  );
  await store.missionRuns.cancel(context, f.identity.missionId);
  assert.equal((await runs.inspect(f.k, f.identity.missionId, f.review.submission_id)).status, 'ok');
  assert.equal((await runs.retire(f.k, f.identity.missionId, f.review.submission_id, lease)).status, 'ok');
  assert.equal((await runs.renew(f.k, f.identity.missionId, f.review.submission_id, lease)).status, 'denied');
  assert.equal(
    (await runs.reserve(f.k, f.identity.missionId, f.review.submission_id, lease, randomUUID(), 'model')).status,
    'denied',
  );
  assert.deepEqual(await runs.pending(f.k), { status: 'ok', items: [] });
});
test('S05-T09 coordinator review spends the original root budgets and replay cannot authorize another invocation', async () => {
  const f = await submitted('answer', true, 600, { max_turns: 3, max_tool_calls: 3 }, 1);
  const runs = new MissionReviewRuns(f.reviews),
    claimed = await runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host');
  assert.equal(claimed.status, 'ok');
  const callId = randomUUID(),
    lease = claimed.lease as any;
  const reserve = (kind: 'model' | 'tool', call = randomUUID()) =>
    runs.reserve(f.k, f.identity.missionId, f.review.submission_id, lease, call, kind);
  assert.deepEqual(await reserve('model', callId), { status: 'ok', reserved: true });
  assert.deepEqual(await reserve('model', callId), { status: 'ok', reserved: false });
  assert.equal((await reserve('tool', callId)).status, 'conflict');
  const calls = await Promise.all(Array.from({ length: 4 }, () => reserve('model')));
  assert.equal(calls.filter((r) => r.reserved === true).length, 1);
  assert.deepEqual(await reserve('tool'), { status: 'ok', reserved: true });
  assert.deepEqual(await reserve('tool'), { status: 'ok', reserved: true });
  assert.equal((await reserve('tool')).status, 'denied');
  assert.deepEqual(((await store.missionRuns.inspect(context, f.identity.missionId)).mission as any).usage, {
    attempt: 1,
    model: 3,
    tool: 3,
  });
  assert.equal((await runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host')).status, 'denied');
});
test('S05-T07 revoked evidence, cancellation and completed review close automatic review authority', async () => {
  for (const change of ['revoke', 'cancel', 'review']) {
    const f = await submitted('answer', true, 600, { max_tool_calls: 6 });
    const runs = new MissionReviewRuns(f.reviews),
      claimed = await runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host');
    assert.equal(claimed.status, 'ok');
    if (change === 'revoke')
      await admin.query("UPDATE cos.sources SET status='revoked' WHERE id=$1", [f.input.sources[0].source_id]);
    if (change === 'cancel') await store.missionRuns.cancel(context, f.identity.missionId);
    if (change === 'review') assert.equal((await f.reviews.review(f.k, randomUUID(), f.review)).status, 'ok');
    assert.equal(
      (await runs.authorize(f.k, f.identity.missionId, f.review.submission_id, claimed.lease as any)).status,
      'denied',
    );
    assert.equal(
      (
        await runs.reserve(
          f.k,
          f.identity.missionId,
          f.review.submission_id,
          claimed.lease as any,
          randomUUID(),
          'model',
        )
      ).status,
      'denied',
    );
  }
});
test('S05-T08 requires exact review version, criteria, digest and an independently confirmed worker stop', async () => {
  const f = await submitted('answer', false);
  assert.equal((await f.reviews.review(f.k, randomUUID(), f.review)).status, 'pending');
  await store.missionRuns.confirmStopped(f.identity);
  for (const review of [
    { ...f.review, expected_version: f.review.expected_version + 1 },
    { ...f.review, result_digest: '0'.repeat(64) },
    { ...f.review, criteria: [{ id: 'foreign', verdict: 'satisfied' }] },
  ])
    assert.notEqual((await f.reviews.review(f.k, randomUUID(), review)).status, 'ok');
  assert.equal(
    (await f.reviews.read({ ...f.k, ownerId: 'foreign' }, f.identity.missionId, f.review.submission_id)).status,
    'denied',
  );
  assert.equal((await f.reviews.review({ ...f.k, sessionId: 'specialist' }, randomUUID(), f.review)).status, 'denied');
  assert.equal((await rows('mission_reviews')).filter((r) => r.mission_id === f.identity.missionId).length, 0);
});
test('S05-T05/T06/T08 host pump dispatches and retires review in the existing conversation before delivering its result', async () => {
  const native = initTestDb(),
    inbox = new Database(':memory:');
  inbox.exec(INBOUND_SCHEMA);
  const binding: CosBinding = {
    scopeId: scope,
    ownerId: context.ownerId,
    agentGroupId: scope,
    sessionId: scope,
    messagingGroupId: 'mg',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: scope,
    botId: 'bot',
  };
  const main = {
    id: scope,
    agent_group_id: scope,
    messaging_group_id: 'mg',
    agent_provider: 'codex',
    status: 'active',
    thread_id: null,
  } as Session;
  const previousAuthority = { ...authority },
    previousAdapter = getDeliveryAdapter();
  authority.bindingDigest = digest(binding);
  authority.contextGeneration = randomUUID();
  let runtime: ReturnType<typeof createCosRuntime> | undefined,
    running = false,
    wakes = 0;
  const sent: string[] = [];
  try {
    const f = await submitted('answer', true, 600, { max_turns: 3, max_tool_calls: 8 }, 1);
    installCosBoundary(binding, native);
    ensureConversationSchema(native);
    native
      .prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?')
      .run(context.ingressId, new Date(Date.now() - 600000).toISOString());
    native
      .prepare(
        "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
      )
      .run(scope, digest(binding), 'a'.repeat(64), authority.contextGeneration, new Date().toISOString());
    setDeliveryAdapter({
      deliver: async (_channel, destination, _thread, _kind, content) => {
        assert.equal(destination, `mattermost:fixture:${scope}`);
        sent.push(content);
        return 'fixture-post';
      },
    });
    runtime = createCosRuntime({
      db: native,
      enabled: true,
      store,
      facts: async () => ({ id: scope, type: 'P', delete_at: 0, members: ['owner', 'bot'], activeSubscription: true }),
      session: () => main,
      destination: () => undefined,
      stop: () => {},
      running: () => running,
      wake: async () => {
        wakes++;
        return false;
      },
      launcher: { ready: () => true } as any,
      withBriefTasks: (_s, operation) => operation(new NativeBriefTasks(inbox)),
      withReviewTasks: (_s, operation) => operation(new NativeMissionReviewTasks(inbox)),
    });
    await runtime.pump(binding);
    assert.equal(wakes, 1);
    const grant = readReviewOrigin(native, binding)!;
    assert.equal(grant.identity.missionId, f.identity.missionId);
    const task = {
      identity: grant.identity,
      inputId: 'cos-mission-review-' + digest({ scope, identity: grant.identity }),
      issuedAt: String((await rows('mission_work_orders')).find((r) => r.id === f.identity.missionId).body.issuedAt),
    };
    assert.equal(new NativeMissionReviewTasks(inbox).state(binding, task), 'pending');
    const automatic = reviewContext(main, native)!;
    const k = resolveKnowledgeContext(main, automatic, native)!;
    assert.equal(
      (
        await store.missionReviewRuns!.reserve(
          k,
          f.identity.missionId,
          f.review.submission_id,
          grant.lease,
          randomUUID(),
          'model',
        )
      ).status,
      'ok',
    );
    assert.equal((await f.reviews.review(k, randomUUID(), f.review)).state, 'completed');
    running = true;
    await runtime.pump(binding);
    assert.equal(sent.length, 0); // stop request alone is insufficient
    assert.equal(reviewContext(main, native), null);
    running = false;
    await runtime.pump(binding);
    assert.equal(readReviewOrigin(native, binding), null);
    assert.equal(new NativeMissionReviewTasks(inbox).state(binding, task), 'completed');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Research result/);
    await runtime.pump(binding);
    assert.equal(sent.length, 1);
    assert.equal(runtime.controller.localContext(main), null); // old ingress never became model authority
    assert.equal(
      (native.prepare('SELECT generation FROM cos_conversation_states').get() as any).generation,
      authority.contextGeneration,
    );
  } finally {
    runtime?.dispose();
    Object.assign(authority, previousAuthority);
    setDeliveryAdapter(previousAdapter ?? { deliver: async () => undefined, isAvailable: () => false });
    inbox.close();
    closeDb();
  }
});
test('S05-T03/T08 automatic coordinator RPC is limited to its exact leased result and spends root tool reservations', async () => {
  const f = await submitted('answer', true, 600, { max_turns: 3, max_tool_calls: 8 }, 1);
  const runs = new MissionReviewRuns(f.reviews),
    claimed = await runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host');
  assert.equal(claimed.status, 'ok');
  const lease = claimed.lease as any;
  const automaticContext = {
    ...context,
    ingressId: 'fixture-host-review',
    origin: {
      kind: 'mission_review' as const,
      runId: f.identity.missionId,
      generation: f.identity.generation,
      submissionId: f.review.submission_id,
      owner: lease.owner,
      fence: lease.fence,
    },
  };
  const automaticKnowledge = { ...f.k, ...automaticContext },
    inbox = new Database(':memory:');
  for (const patch of [
    { fence: lease.fence + 1 },
    { owner: 'foreign' },
    { generation: f.identity.generation + 1 },
    { submissionId: randomUUID() },
  ]) {
    assert.equal(
      (
        await f.reviews.read(
          { ...automaticKnowledge, origin: { ...automaticContext.origin, ...patch } },
          f.identity.missionId,
          f.review.submission_id,
        )
      ).status,
      'denied',
    );
  }
  const reserve = async (callId: string, kind: 'model' | 'tool') => {
    const result = await runs.reserve(
      automaticKnowledge,
      f.identity.missionId,
      f.review.submission_id,
      lease,
      callId,
      kind,
    );
    return result.status === 'ok' && result.reserved !== true ? { status: 'pending' as const } : result;
  };
  const handler = createRpcHandler({
    store,
    knowledge,
    resolveContext: async () =>
      (await runs.authorize(automaticKnowledge, f.identity.missionId, f.review.submission_id, lease, true)).status ===
      'ok'
        ? automaticContext
        : null,
    resolveKnowledgeContext: async () => automaticKnowledge,
    reserveTool: async (_context, callId) => reserve(callId, 'tool'),
  });
  const main = { id: context.sessionId, agent_group_id: context.agentGroupId } as NonNullable<
    ReturnType<typeof getSession>
  >;
  try {
    const call = async (method: string, params: Record<string, unknown>) => {
      const request = { protocol: 'cos-rpc/v1', request_id: randomUUID(), method, params },
        delivery_id = randomUUID();
      await handler({ action: 'cos_rpc', request, delivery_id }, main, inbox);
      return JSON.parse(
        (
          inbox
            .prepare('SELECT response FROM cos_rpc_responses WHERE request_id=? AND payload_hash=? AND delivery_id=?')
            .get(request.request_id, digest(request), delivery_id) as { response: string }
        ).response,
      );
    };
    assert.equal((await reserve(randomUUID(), 'model')).status, 'ok');
    assert.equal((await call('cos_context_get', { view: 'today' })).status, 'denied');
    assert.equal(
      (await call('cos_mission_result_get', { mission_id: 'foreign', submission_id: f.review.submission_id })).status,
      'denied',
    );
    const result = await call('cos_mission_result_get', {
      mission_id: f.identity.missionId,
      submission_id: f.review.submission_id,
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.result.result, f.result);
    const reviewed = await call('cos_mission_review', { review: f.review });
    assert.equal(reviewed.status, 'ok');
    assert.equal(reviewed.result.state, 'completed');
    assert.equal(
      (await runs.authorize(automaticKnowledge, f.identity.missionId, f.review.submission_id, lease)).status,
      'denied',
    );
    assert.equal(
      (
        await call('cos_mission_result_get', {
          mission_id: f.identity.missionId,
          submission_id: f.review.submission_id,
        })
      ).status,
      'denied',
    );
    assert.deepEqual(((await store.missionRuns.inspect(context, f.identity.missionId)).mission as any).usage, {
      attempt: 1,
      model: 2,
      tool: 5,
    });
  } finally {
    inbox.close();
  }
});
test('S05-PG03 lost coordinator-call acknowledgement stays charged and cannot authorize a second invocation', async () => {
  const f = await submitted('answer', true, 600, { max_tool_calls: 6 });
  const runs = new MissionReviewRuns(f.reviews),
    claimed = await runs.claim(f.k, f.identity.missionId, f.review.submission_id, 'review-host');
  assert.equal(claimed.status, 'ok');
  const pool = new pg.Pool(await fixtureDatabaseConfig()),
    connection = await pool.connect(),
    original = connection.query.bind(connection);
  let dropped = false;
  connection.query = (async (...args: unknown[]) => {
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    if (args[0] === 'COMMIT' && !dropped) {
      dropped = true;
      throw Error('fixture_lost_ack');
    }
    return result;
  }) as typeof connection.query;
  connection.release();
  const faulty = new MissionReviewRuns(new MissionReviews(new BoundedDatabase(pool), store.missions, knowledge));
  const callId = randomUUID(),
    lease = claimed.lease as any;
  try {
    assert.equal(
      (await faulty.reserve(f.k, f.identity.missionId, f.review.submission_id, lease, callId, 'model')).status,
      'pending',
    );
  } finally {
    await pool.end();
  }
  assert.deepEqual(await runs.reserve(f.k, f.identity.missionId, f.review.submission_id, lease, callId, 'model'), {
    status: 'ok',
    reserved: false,
  });
  assert.equal(((await store.missionRuns.inspect(context, f.identity.missionId)).mission as any).usage.model, 1);
});
test('S05-T08 the coordinator RPC reads current result bytes and persists an advisory review rather than chat output', async () => {
  const f = await submitted(),
    inbox = new Database(':memory:');
  const handler = createRpcHandler({
    store,
    knowledge,
    resolveContext: async () => context,
    resolveKnowledgeContext: async () => f.k,
  });
  const main = { id: context.sessionId, agent_group_id: context.agentGroupId } as NonNullable<
    ReturnType<typeof getSession>
  >;
  try {
    async function call(method: string, params: Record<string, unknown>) {
      const request = { protocol: 'cos-rpc/v1', request_id: randomUUID(), method, params },
        delivery_id = randomUUID();
      await handler({ action: 'cos_rpc', request, delivery_id }, main, inbox);
      return JSON.parse(
        (
          inbox
            .prepare('SELECT response FROM cos_rpc_responses WHERE request_id=? AND payload_hash=? AND delivery_id=?')
            .get(request.request_id, digest(request), delivery_id) as { response: string }
        ).response,
      );
    }
    const read = await call('cos_mission_result_get', {
      mission_id: f.identity.missionId,
      submission_id: f.review.submission_id,
    });
    assert.equal(read.status, 'ok');
    assert.deepEqual(read.result.result, f.result);
    const reviewed = await call('cos_mission_review', { review: f.review });
    assert.equal(reviewed.status, 'ok');
    assert.equal(reviewed.result.state, 'completed');
    assert.equal(inbox.prepare("SELECT name FROM sqlite_master WHERE name='messages_in'").get(), undefined);
    assert.equal(
      (await rows('outbox')).find((r) => r.payload.review_id === reviewed.result.review_id).delivered_at,
      null,
    );
  } finally {
    inbox.close();
  }
});
test('S05-T08 artifact corruption, changed provider authority and review replay after revocation cannot disclose results', async () => {
  const f = await submitted();
  const previous = authority.provider.policyDigest;
  authority.provider.policyDigest = digest('different reviewed provider consent');
  assert.equal((await f.reviews.read(f.k, f.identity.missionId, f.review.submission_id)).status, 'denied');
  authority.provider.policyDigest = previous;
  const row = (await rows('mission_result_submissions')).find((r) => r.id === f.review.submission_id);
  const blob = path.join(knowledge.artifacts.root, row.artifact_id + '.blob');
  const bytes = fs.readFileSync(blob);
  fs.writeFileSync(blob, 'tampered fixture result');
  try {
    // A failed transaction is conservatively pending and opens the bounded database cooldown.
    assert.deepEqual(await f.reviews.read(f.k, f.identity.missionId, f.review.submission_id), { status: 'pending' });
  } finally {
    fs.writeFileSync(blob, bytes);
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  assert.equal((await rows('mission_reviews')).filter((r) => r.mission_id === f.identity.missionId).length, 0);
  const requestId = randomUUID();
  assert.equal((await f.reviews.review(f.k, requestId, f.review)).status, 'ok');
  await admin.query("UPDATE cos.sources SET status='revoked' WHERE id=$1", [f.input.sources[0].source_id]);
  assert.equal((await f.reviews.review(f.k, requestId, f.review)).status, 'denied');
  assert.equal((await f.reviews.read(f.k, f.identity.missionId, f.review.submission_id)).status, 'denied');
});
test('S05-T08 notification reserves one send and records metadata-only receipts without retrying unknown outcomes', async () => {
  const f = await submitted();
  const review = await f.reviews.review(f.k, randomUUID(), f.review);
  const notifications = new MissionNotifications(store.database, f.reviews);
  const reviewId = String(review.review_id),
    attemptId = randomUUID();
  assert.deepEqual(await notifications.pending(f.k), { status: 'ok', review_ids: [reviewId] });
  assert.deepEqual(await notifications.begin({ ...f.k, ownerId: 'foreign' }, reviewId, attemptId), {
    status: 'denied',
  });
  const started = await notifications.begin(f.k, reviewId, attemptId);
  assert.equal(started.status, 'ok');
  assert.notEqual((await notifications.begin(f.k, reviewId, attemptId)).status, 'ok');
  assert.notEqual((await notifications.begin(f.k, reviewId, randomUUID())).status, 'ok');
  const output = await notifications.read(f.k, reviewId, attemptId);
  assert.equal(output.status, 'ok');
  assert.match(String(output.text), /coordinator review/i);
  assert.match(String(output.text), new RegExp('L' + f.result.claims[0].citations[0].start_line));
  assert.equal(
    (await notifications.finish(f.k, reviewId, randomUUID(), { state: 'delivered', platform_receipt: 'wrong' })).status,
    'denied',
  );
  assert.equal((await notifications.finish(f.k, reviewId, attemptId, { state: 'uncertain' })).state, 'uncertain');
  assert.notEqual((await notifications.begin(f.k, reviewId, randomUUID())).status, 'ok');
  assert.equal((await notifications.read(f.k, reviewId, attemptId)).status, 'denied');
  const receipt = { state: 'delivered' as const, platform_receipt: 'verified-fixture-post' };
  assert.equal((await notifications.finish(f.k, reviewId, attemptId, receipt)).state, 'delivered');
  assert.equal((await notifications.finish(f.k, reviewId, attemptId, receipt)).state, 'delivered');
  const command = (await rows('outbox')).find((r) => r.id === started.notification_id);
  assert.equal(command.attempts, 1);
  assert.deepEqual(await notifications.pending(f.k), { status: 'ok', review_ids: [] });
  assert.equal(
    ((await store.missionRuns.inspect(context, f.identity.missionId)).mission as any).submission.notification_state,
    'delivered',
  );
  assert.ok(command.delivered_at);
  assert.equal(JSON.stringify(command.payload).includes('RESULT_CANARY'), false);
});
test('S05-T07 notification rechecks evidence and context after reservation but can retain an already-sent receipt', async () => {
  const f = await submitted();
  const review = await f.reviews.review(f.k, randomUUID(), f.review);
  const notifications = new MissionNotifications(store.database, f.reviews),
    attempt = randomUUID(),
    reviewId = String(review.review_id);
  assert.equal((await notifications.begin(f.k, reviewId, attempt)).status, 'ok');
  assert.equal((await notifications.read({ ...f.k, generation: randomUUID() }, reviewId, attempt)).status, 'denied');
  await admin.query("UPDATE cos.sources SET status='revoked' WHERE id=$1", [f.input.sources[0].source_id]);
  assert.equal((await notifications.read(f.k, reviewId, attempt)).status, 'denied');
  assert.equal(
    (
      await notifications.finish(f.k, reviewId, attempt, {
        state: 'delivered',
        platform_receipt: 'previously-sent-fixture',
      })
    ).state,
    'delivered',
  );
});
test('S05-T05/T06 concurrent notification pumps with a real durable intent invoke the fixture transport once', async () => {
  const f = await submitted('partial');
  const review = await f.reviews.review(f.k, randomUUID(), {
    ...f.review,
    decision: 'partial',
    criteria: [{ id: 'tradeoff', verdict: 'partial' }],
  });
  assert.equal(review.status, 'ok');
  const notifications = new MissionNotifications(store.database, f.reviews);
  const sent: string[] = [];
  const delivery = new MissionNotificationDelivery({
    notifications,
    admitted: async () => true,
    current: () => f.k,
    send: async (_context, text, notificationId) => {
      sent.push(text);
      assert.equal(notificationId, 'mission-review-' + review.review_id);
      return 'fixture-post';
    },
  });
  const results = await Promise.all([
    delivery.deliver(f.k, String(review.review_id)),
    delivery.deliver(f.k, String(review.review_id)),
  ]);
  assert.equal(results.filter((r) => r.state === 'delivered').length, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Research result — partial/);
  const restarted = new MissionNotificationDelivery({
    notifications: new MissionNotifications(store.database, f.reviews),
    admitted: async () => true,
    current: () => f.k,
    send: async () => {
      throw Error('must not resend');
    },
  });
  assert.equal((await restarted.deliver(f.k, String(review.review_id))).status, 'denied');
});
test('S05-PG03 lost notification-reservation acknowledgement cannot grant a later send', async () => {
  const f = await submitted();
  const reviewed = await f.reviews.review(f.k, randomUUID(), f.review),
    reviewId = String(reviewed.review_id);
  const pool = new pg.Pool(await fixtureDatabaseConfig()),
    connection = await pool.connect(),
    original = connection.query.bind(connection);
  let dropped = false;
  connection.query = (async (...args: unknown[]) => {
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    if (args[0] === 'COMMIT' && !dropped) {
      dropped = true;
      throw Error('fixture_lost_ack');
    }
    return result;
  }) as typeof connection.query;
  connection.release();
  const faulty = new MissionNotifications(new BoundedDatabase(pool), f.reviews);
  try {
    assert.equal((await faulty.begin(f.k, reviewId, randomUUID())).status, 'pending');
  } finally {
    await pool.end();
  }
  const recovered = new MissionNotifications(store.database, f.reviews);
  assert.equal((await recovered.begin(f.k, reviewId, randomUUID())).status, 'denied');
  assert.deepEqual(await recovered.pending(f.k), { status: 'ok', review_ids: [] });
  const row = (await rows('outbox')).find((r) => r.id === 'mission-review-' + reviewId);
  assert.equal(row.attempts, 1);
  assert.equal(row.payload.delivery.state, 'delivering');
  assert.equal(row.delivered_at, null);
});
test('S05-T08 review rejects mismatched result provider and attempt provenance', async () => {
  const f = await submitted();
  const row = (await rows('mission_result_submissions')).find((r) => r.id === f.review.submission_id);
  const artifact = (await rows('artifacts')).find((r) => r.id === row.artifact_id);
  try {
    for (const patch of [{ processing_provider: 'claude' }, { generation: f.identity.generation + 1 }]) {
      await admin.query('UPDATE cos.artifacts SET provenance=$3 WHERE scope_id=$1 AND id=$2', [
        scope,
        row.artifact_id,
        JSON.stringify({ ...artifact.provenance, ...patch }),
      ]);
      assert.equal((await f.reviews.read(f.k, f.identity.missionId, f.review.submission_id)).status, 'denied');
      assert.equal((await f.reviews.review(f.k, randomUUID(), f.review)).status, 'denied');
    }
  } finally {
    await admin.query('UPDATE cos.artifacts SET provenance=$3 WHERE scope_id=$1 AND id=$2', [
      scope,
      row.artifact_id,
      JSON.stringify(artifact.provenance),
    ]);
  }
  assert.equal((await f.reviews.read(f.k, f.identity.missionId, f.review.submission_id)).status, 'ok');
});
test('S05-T07 cancellation and source revocation deny coordinator result reuse and late completion', async () => {
  for (const action of ['cancel', 'revoke']) {
    const f = await submitted();
    if (action === 'cancel') await store.missionRuns.cancel(context, f.identity.missionId);
    else await admin.query("UPDATE cos.sources SET status='revoked' WHERE id=$1", [f.input.sources[0].source_id]);
    assert.equal((await f.reviews.read(f.k, f.identity.missionId, f.review.submission_id)).status, 'denied');
    assert.equal((await f.reviews.review(f.k, randomUUID(), f.review)).status, 'denied');
    assert.equal((await rows('mission_reviews')).filter((r) => r.mission_id === f.identity.missionId).length, 0);
  }
});
test('S05-T08 partial and blocked specialist results keep honest terminal states', async () => {
  for (const outcome of ['partial', 'blocked'] as const) {
    const f = await submitted(outcome);
    assert.equal((await f.reviews.review(f.k, randomUUID(), f.review)).status, 'denied');
    const review = {
      ...f.review,
      decision: outcome === 'partial' ? 'partial' : 'reject',
      criteria: [{ id: 'tradeoff', verdict: outcome === 'partial' ? 'partial' : 'not_met' }],
    };
    assert.equal((await f.reviews.review(f.k, randomUUID(), review)).state, outcome);
  }
});
test('S05-T03/T08 actual native RPC and external PostgreSQL deliver context then an unreviewed receipt', async () => {
  const { identity } = await mission();
  const lease = await dispatched(identity),
    native = initTestDb();
  migrateNative(native);
  createAgentGroup({
    id: identity.agentGroupId,
    name: 'research fixture',
    folder: identity.agentGroupId,
    agent_provider: 'codex',
    created_at: new Date().toISOString(),
  });
  createSession({
    id: identity.sessionId,
    agent_group_id: identity.agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: 'codex',
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  });
  installCosMissionBoundary(identity, native);
  const inbox = new Database(':memory:'),
    session = getSession(identity.sessionId)!;
  const allowed = async () => (await store.missionRuns.authorizeWorker(identity, lease)).status === 'ok';
  const remove = installCosMissionExecutionHooks({
    ready: () => true,
    launch: async () => {
      throw new Error('fixture does not launch models');
    },
    rpc: allowed,
  });
  const handler = createMissionRpcHandler({
    resolve: async () => ((await allowed()) ? { identity, lease } : null),
    runs: store.missionRuns,
    submit: (...args) => store.missionRuns.submitResult(...args),
  });
  try {
    async function call(method: string, params: unknown) {
      const request = { protocol: 'cos-mission-rpc/v1', request_id: randomUUID(), method, params },
        delivery_id = randomUUID();
      const content = { action: 'cos_mission_rpc', request, delivery_id };
      assert.equal(
        await permitCosOutbound(session, {
          kind: 'system',
          channel_type: null,
          platform_id: null,
          thread_id: null,
          content: JSON.stringify(content),
        }),
        true,
      );
      await handler(content, session, inbox);
      return JSON.parse(
        (
          inbox
            .prepare('SELECT response FROM cos_rpc_responses WHERE request_id=? AND payload_hash=? AND delivery_id=?')
            .get(request.request_id, digest(request), delivery_id) as { response: string }
        ).response,
      );
    }
    const read = await call('cos_mission_context_get', {});
    assert.equal(read.status, 'ok');
    assert.equal(read.result.work_order.missionId, identity.missionId);
    assert.equal(read.result.context.sources.length, 1);
    const submitted = await call('cos_result_submit', { result: blockedResult() });
    assert.equal(submitted.status, 'ok');
    assert.equal(submitted.result.state, 'awaiting_review');
    assert.equal((await call('cos_mission_context_get', {})).status, 'denied');
    assert.equal(
      (await rows('mission_budget_reservations')).filter(
        (r) => r.attempt_id === identity.attemptId && r.kind === 'tool',
      ).length,
      2,
    );
    assert.equal(
      await permitCosOutbound(session, {
        kind: 'chat',
        channel_type: 'mattermost',
        platform_id: 'private',
        thread_id: null,
        content: JSON.stringify({ text: 'Must not publish directly' }),
      }),
      false,
    );
  } finally {
    remove();
    inbox.close();
    closeDb();
  }
});
test('S05-T06/T07 interrupted or revoked publication leaves no accepted result and its orphan is reclaimable', async () => {
  for (const change of ['crash', 'revoked']) {
    const { identity, input } = await mission();
    const lease = await dispatched(identity);
    const submissions = new MissionRunStore(store.database, store.missions, knowledge.artifacts, {
      afterPublication: async () => {
        if (change === 'crash') throw new Error('fixture crash after publication');
        await admin.query("UPDATE cos.sources SET status='revoked' WHERE id=$1", [input.sources[0].source_id]);
      },
    });
    const before = new Set(fs.readdirSync(knowledge.artifacts.root));
    const submit = submissions.submitResult(identity, lease, randomUUID(), randomUUID(), blockedResult());
    if (change === 'crash') await assert.rejects(submit, /fixture crash/);
    else assert.equal((await submit).status, 'denied');
    const orphans = fs
      .readdirSync(knowledge.artifacts.root)
      .filter((name) => name.endsWith('.blob') && !before.has(name));
    assert.equal(orphans.length, 1);
    assert.equal(
      (await rows('mission_result_submissions')).filter((r) => r.attempt_id === identity.attemptId).length,
      0,
    );
    assert.equal((await rows('missions')).find((r) => r.id === identity.missionId).state, 'running');
    fs.utimesSync(path.join(knowledge.artifacts.root, orphans[0]), new Date(0), new Date(0));
    assert.equal((await knowledge.reconcileArtifacts(0)).status, 'ok');
    assert.equal(fs.existsSync(path.join(knowledge.artifacts.root, orphans[0])), false);
    assert.equal(
      (await rows('mission_budget_reservations')).filter(
        (r) => r.attempt_id === identity.attemptId && r.kind === 'tool',
      ).length,
      1,
    );
  }
});
test('S05-T08 checked quotations remain candidates and accepted-result replay still requires current source authority', async () => {
  const { identity, input } = await mission();
  const lease = await dispatched(identity);
  const result: MissionResult = {
    format: 'cos-research-result/v1',
    outcome: 'answer',
    claims: [
      {
        id: 'comparison',
        kind: 'quote',
        text: 'A costs less; B has more capacity.',
        citations: [{ ...input.sources[0], ordinal: 0, start_line: 2, end_line: 2 }],
      },
    ],
    criteria: [{ id: 'tradeoff', claim_ids: ['comparison'] }],
    limitations: [],
  };
  const requestId = randomUUID(),
    callId = randomUUID();
  const accepted = await store.missionRuns.submitResult(identity, lease, requestId, callId, result);
  assert.equal(accepted.status, 'ok');
  assert.equal(accepted.state, 'awaiting_review');
  const revoke = await store.propose(context, randomUUID(), {
    kind: 'source_revoke',
    source_id: input.sources[0].source_id,
    expected_version: 1,
    reason: 'Fixture owner withdrew this note.',
  });
  assert.equal(revoke.status, 'ok');
  assert.equal((await approve(revoke)).status, 'ok');
  const submission = (await rows('mission_result_submissions')).find((r) => r.id === accepted.submission_id);
  assert.equal((await rows('artifacts')).find((r) => r.id === submission.artifact_id).lifecycle, 'quarantined');
  assert.equal((await store.missionRuns.submitResult(identity, lease, requestId, callId, result)).status, 'denied');
  assert.equal((await store.missionRuns.authorizeWorker(identity, lease)).status, 'denied');
  assert.equal((await rows('mission_reviews')).filter((r) => r.mission_id === identity.missionId).length, 0);
});
test('S05-T08 accepts a bounded result only as purgeable evidence awaiting coordinator review', async () => {
  const { identity } = await mission();
  const lease = await dispatched(identity),
    requestId = randomUUID(),
    callId = randomUUID();
  const result = blockedResult();
  const receipt = await store.missionRuns.submitResult(identity, lease, requestId, callId, result);
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.state, 'awaiting_review');
  const submission = (await rows('mission_result_submissions')).find((r) => r.attempt_id === identity.attemptId);
  assert.ok(submission);
  assert.equal(JSON.stringify(submission).includes('RESULT_CANARY'), false);
  const artifact = (await rows('artifacts')).find((r) => r.id === submission.artifact_id);
  assert.equal(artifact.kind, 'mission_result');
  assert.deepEqual(JSON.parse(knowledge.artifacts.read(artifact.id, artifact.digest)), result);
  assert.equal((await rows('derivation_links')).filter((r) => r.artifact_id === artifact.id).length > 0, true);
  assert.equal((await rows('mission_reviews')).filter((r) => r.mission_id === identity.missionId).length, 0);
  assert.equal((await rows('missions')).find((r) => r.id === identity.missionId).state, 'awaiting_review');
  assert.equal((await reserve(identity)).status, 'denied');
  assert.equal((await store.missionRuns.readContext(identity, lease, randomUUID())).status, 'denied');
  assert.equal((await store.missionRuns.authorizeDispatch(identity, lease)).status, 'denied');
  assert.equal((await store.missionRuns.authorizeWorker(identity, lease)).status, 'ok');
  assert.deepEqual(await store.missionRuns.submitResult(identity, lease, requestId, callId, result), receipt);
  assert.equal(
    (
      await store.missionRuns.submitResult(identity, lease, requestId, randomUUID(), {
        ...result,
        limitations: ['Different result.'],
      })
    ).status,
    'conflict',
  );
  assert.equal((await store.missionRuns.inspect(context, identity.missionId)).status, 'ok');
  assert.equal((await store.missionRuns.confirmStopped(identity)).status, 'ok');
  assert.equal((await store.missionRuns.authorizeWorker(identity, lease)).status, 'denied');
  assert.equal((await rows('missions')).find((r) => r.id === identity.missionId).state, 'awaiting_review');
});
test('S05-T07/T08 refuses invalid, stale or cancelled result submissions before artifact publication', async () => {
  for (const change of ['criteria', 'citation', 'revoked', 'cancelled', 'lease']) {
    const { identity, input } = await mission();
    const lease = await dispatched(identity);
    let result: unknown = blockedResult();
    if (change === 'criteria') result = { ...blockedResult(), criteria: [{ id: 'invented', claim_ids: [] }] };
    if (change === 'citation')
      result = {
        format: 'cos-research-result/v1',
        outcome: 'answer',
        claims: [
          {
            id: 'claim',
            kind: 'inference',
            text: 'Other mission canary',
            citations: [{ source_id: 'foreign', revision_id: 'foreign', ordinal: 0, start_line: 1, end_line: 1 }],
          },
        ],
        criteria: [{ id: 'tradeoff', claim_ids: ['claim'] }],
        limitations: [],
      };
    if (change === 'revoked')
      await admin.query("UPDATE cos.sources SET status='revoked' WHERE id=$1", [input.sources[0].source_id]);
    if (change === 'cancelled') await store.missionRuns.cancel(context, identity.missionId);
    if (change === 'lease') lease.fence++;
    const before = fs.readdirSync(knowledge.artifacts.root).filter((name) => name.endsWith('.blob')).length;
    assert.equal(
      (await store.missionRuns.submitResult(identity, lease, randomUUID(), randomUUID(), result)).status,
      'denied',
    );
    assert.equal(fs.readdirSync(knowledge.artifacts.root).filter((name) => name.endsWith('.blob')).length, before);
    assert.equal(
      (await rows('mission_result_submissions')).filter((r) => r.attempt_id === identity.attemptId).length,
      0,
    );
  }
});
test('S05-T09 root tool exhaustion denies result submission and concurrent submissions retain one result', async () => {
  const first = await mission({ max_turns: 2, max_tool_calls: 1, max_attempts: 2 });
  const firstLease = await dispatched(first.identity);
  await store.missionRuns.readContext(first.identity, firstLease, randomUUID());
  assert.equal(
    (await store.missionRuns.submitResult(first.identity, firstLease, randomUUID(), randomUUID(), blockedResult()))
      .status,
    'denied',
  );
  const { identity } = await mission();
  const lease = await dispatched(identity);
  const receipts = await Promise.all(
    Array.from({ length: 3 }, () =>
      store.missionRuns.submitResult(identity, lease, randomUUID(), randomUUID(), blockedResult()),
    ),
  );
  assert.equal(receipts.filter((r) => r.status === 'ok').length, 1);
  assert.equal((await rows('mission_result_submissions')).filter((r) => r.attempt_id === identity.attemptId).length, 1);
});
test('S05-T09 atomic root reservations bound concurrent calls and exact replay is not permission to invoke again', async () => {
  const { identity } = await mission();
  assert.equal((await reserve(identity)).status, 'denied');
  await running(identity);
  const ids = Array.from({ length: 8 }, () => randomUUID());
  const results = await Promise.all(ids.map((id) => reserve(identity, id)));
  assert.equal(results.filter((r) => r.status === 'ok' && r.reserved === true).length, 2);
  const accepted = results.findIndex((r) => r.status === 'ok');
  assert.deepEqual(await reserve(identity, ids[accepted]), { status: 'ok', reserved: false });
  assert.equal((await reserve(identity, ids[accepted], 'model', digest('different'))).status, 'conflict');
  assert.equal((await reserve(identity, ids[accepted], 'tool')).status, 'conflict');
  assert.equal((await reserve(identity, randomUUID(), 'tool')).reserved, true);
  assert.equal((await reserve(identity, randomUUID(), 'tool')).reserved, true);
  assert.equal((await reserve(identity, randomUUID(), 'tool')).status, 'denied');
  const result = await store.missionRuns.inspect(context, identity.missionId);
  assert.equal(result.status, 'ok');
  assert.deepEqual((result.mission as any).usage, { attempt: 1, model: 2, tool: 2 });
});
test('S05-T05/T09 retry requires a stopped old attempt, creates fresh identities and keeps root usage', async () => {
  const { identity } = await mission();
  await running(identity);
  assert.equal((await reserve(identity)).reserved, true);
  assert.equal((await store.missionRuns.fail(identity, 'provider_failed')).status, 'ok');
  assert.equal((await reserve(identity)).status, 'denied');
  assert.equal((await store.missionRuns.retry(context, identity.attemptId)).status, 'denied');
  assert.equal((await store.missionRuns.confirmStopped(identity)).status, 'ok');
  const retry = await store.missionRuns.retry(context, identity.attemptId);
  assert.equal(retry.status, 'ok');
  const next = retry.identity as CosMissionIdentity;
  assert.equal(next.generation, identity.generation + 1);
  for (const field of ['attemptId', 'agentGroupId', 'sessionId'] as const)
    assert.notEqual(next[field], identity[field]);
  assert.deepEqual(await store.missionRuns.retry(context, identity.attemptId), retry);
  await running(next);
  assert.equal((await reserve(next)).reserved, true);
  assert.equal((await reserve(next)).status, 'denied');
  assert.equal((await reserve(identity)).status, 'denied');
  assert.equal((await store.missionRuns.fail(next, 'provider_failed')).status, 'ok');
  await store.missionRuns.confirmStopped(next);
  assert.equal((await store.missionRuns.retry(context, next.attemptId)).status, 'denied');
  const info = (await store.missionRuns.inspect(context, identity.missionId)).mission as any;
  assert.deepEqual(info.usage, { attempt: 2, model: 2, tool: 0 });
});
test('S05-T07 cancellation fences the generation before native stop and settles only after stop confirmation', async () => {
  const { identity } = await mission();
  await running(identity);
  const call = randomUUID();
  await reserve(identity, call);
  const cancelled = await store.missionRuns.cancel(context, identity.missionId);
  assert.equal(cancelled.status, 'ok');
  assert.equal(cancelled.state, 'cancelling');
  assert.equal((await reserve(identity, call)).status, 'denied');
  assert.equal((await store.missionRuns.retry(context, identity.attemptId)).status, 'denied');
  const before = (await store.missionRuns.inspect(context, identity.missionId)).mission as any;
  assert.equal(before.generation, identity.generation + 1);
  assert.deepEqual(await store.missionRuns.cancel(context, identity.missionId), cancelled);
  assert.equal((await store.missionRuns.confirmStopped(identity)).status, 'ok');
  assert.equal((await store.missionRuns.cancel(context, identity.missionId)).state, 'cancelled');
  assert.equal(
    ((await store.missionRuns.inspect(context, identity.missionId)).mission as any).generation,
    before.generation,
  );
});
test('S05-T07 cancelling an unapproved proposal prevents later application and withdraws its preview', async () => {
  const p = await store.requestMission(context, randomUUID(), await request());
  assert.equal(p.status, 'ok');
  assert.equal((await store.missionRuns.cancel(context, String(p.mission_id))).state, 'cancelled');
  assert.equal((await store.apply(scope, String(p.proposal_id))).status, 'denied');
  assert.ok(!((await store.pendingOutbox(scope)).items as any[]).some((i) => i.payload.proposal_id === p.proposal_id));
});
test('S05-T03 forged attempt identities and foreign owners cannot consume, inspect or cancel a mission', async () => {
  const { identity } = await mission();
  await running(identity);
  for (const patch of [
    { scopeId: 'other' },
    { missionId: 'mission-' + digest('other') },
    { attemptId: randomUUID() },
    { generation: 99 },
    { agentGroupId: 'other' },
    { sessionId: 'other' },
    { provider: 'claude' },
  ])
    assert.equal((await reserve({ ...identity, ...patch } as CosMissionIdentity)).status, 'denied');
  for (const patch of [{ ownerId: 'other' }, { agentGroupId: 'other' }, { sessionId: 'other' }, { scopeId: 'other' }]) {
    assert.equal((await store.missionRuns.inspect({ ...context, ...patch }, identity.missionId)).status, 'denied');
    assert.equal((await store.missionRuns.cancel({ ...context, ...patch }, identity.missionId)).status, 'denied');
  }
});
test('S05-T07 revoked source and unavailable host authority deny new usage but still permit owner cancellation', async () => {
  const { identity, input } = await mission();
  await running(identity);
  await admin.query("UPDATE cos.sources SET status='revoked' WHERE scope_id=$1 AND id=$2", [
    scope,
    input.sources[0].source_id,
  ]);
  assert.equal((await reserve(identity)).status, 'denied');
  enabled = false;
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [scope]);
  try {
    assert.equal((await store.missionRuns.cancel(context, identity.missionId)).state, 'cancelling');
  } finally {
    enabled = true;
    await admin.query("UPDATE cos.scopes SET status='active' WHERE id=$1", [scope]);
  }
  await store.missionRuns.confirmStopped(identity);
});
test('S05-PG03 a lost usage-commit acknowledgement consumes the reservation without granting a second invocation', async () => {
  const { identity } = await mission();
  await running(identity);
  const pool = new pg.Pool(await fixtureDatabaseConfig()),
    connection = await pool.connect(),
    original = connection.query.bind(connection);
  let dropped = false;
  connection.query = (async (...args: unknown[]) => {
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    if (args[0] === 'COMMIT' && !dropped) {
      dropped = true;
      throw new Error('fixture_lost_ack');
    }
    return result;
  }) as typeof connection.query;
  connection.release();
  const faulty = new PriorityStore(new BoundedDatabase(pool), knowledge, undefined, undefined, () => authority);
  const call = randomUUID();
  try {
    assert.equal((await faulty.missionRuns.reserve(identity, call, 'model', digest('fixture-call'))).status, 'pending');
  } finally {
    await pool.end();
  }
  assert.deepEqual(await reserve(identity, call), { status: 'ok', reserved: false });
  assert.equal(((await store.missionRuns.inspect(context, identity.missionId)).mission as any).usage.model, 1);
});
test('S05-T07 cancellation and retry racing under the parent lock cannot leave a runnable generation', async () => {
  const { identity } = await mission();
  await running(identity);
  await store.missionRuns.fail(identity, 'provider_failed');
  await store.missionRuns.confirmStopped(identity);
  const results = await Promise.all([
    store.missionRuns.retry(context, identity.attemptId),
    store.missionRuns.cancel(context, identity.missionId),
  ]);
  assert.equal(results[1].status, 'ok');
  const m = (await store.missionRuns.inspect(context, identity.missionId)).mission as any;
  assert.ok(['cancelling', 'cancelled'].includes(m.state));
  assert.ok(m.attempts.every((a: any) => a.state === 'cancelled'));
  if (results[0].status === 'ok')
    assert.equal((await reserve(results[0].identity as CosMissionIdentity)).status, 'denied');
});
test('S05-T09 invalid call identities and expired work orders cannot consume a reservation', async () => {
  const { identity } = await mission();
  await running(identity);
  for (const args of [
    ['', 'model', digest('x')],
    ['call', 'attempt', digest('x')],
    ['call', 'model', 'invalid'],
  ] as const)
    assert.equal((await store.missionRuns.reserve(identity, args[0], args[1] as 'model', args[2])).status, 'denied');
  const w = (await rows('mission_work_orders')).find((w) => w.id === identity.missionId);
  const body = { ...w.body, issuedAt: '2020-01-01T00:00:00.000Z', deadlineAt: '2020-01-01T00:10:00.000Z' };
  await admin.query('UPDATE cos.mission_work_orders SET body=$3,digest=$4 WHERE scope_id=$1 AND id=$2', [
    scope,
    identity.missionId,
    JSON.stringify(body),
    digest(body),
  ]);
  assert.equal((await reserve(identity)).status, 'denied');
  assert.equal(((await store.missionRuns.inspect(context, identity.missionId)).mission as any).usage.model, 0);
});
test('S05-T05/T06 allocation leases preserve dispatch identity and fence expired dispatchers', async () => {
  const { identity } = await mission();
  const first = await store.missionRuns.claimDispatch(context, identity.attemptId, 'dispatcher-a');
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.identity, identity);
  assert.match(JSON.stringify(first.order), /SOURCE_CANARY/);
  assert.ok(
    (await rows('evidence_refs')).some(
      (e) => e.session_id === identity.sessionId && e.context_generation === identity.attemptId,
    ),
  );
  assert.equal((await store.missionRuns.claimDispatch(context, identity.attemptId, 'dispatcher-b')).status, 'pending');
  assert.equal((await store.missionRuns.authorizeDispatch(identity, first.lease as any)).status, 'ok');
  assert.equal((await store.missionRuns.renewDispatch(identity, first.lease as any)).status, 'ok');
  await admin.query(
    "UPDATE cos.mission_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND id=$2",
    [scope, identity.attemptId],
  );
  assert.equal((await store.missionRuns.authorizeDispatch(identity, first.lease as any)).status, 'denied');
  assert.equal((await store.missionRuns.renewDispatch(identity, first.lease as any)).status, 'denied');
  const second = await store.missionRuns.claimDispatch(context, identity.attemptId, 'dispatcher-b');
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.identity, identity);
  assert.equal(second.inputId, first.inputId);
  assert.ok((second.lease as any).fence > (first.lease as any).fence);
  assert.equal(
    (await store.missionRuns.markDispatchReady(identity, first.lease as any, digest('native allocation'))).status,
    'denied',
  );
  assert.equal(
    (await store.missionRuns.markDispatchReady(identity, second.lease as any, digest('native allocation'))).status,
    'ok',
  );
  assert.equal(
    (await store.missionRuns.markDispatchReady(identity, second.lease as any, digest('changed allocation'))).status,
    'conflict',
  );
  // Ready is still pending execution. A false/deferred native wake must leave this state and budget unchanged.
  assert.equal((await reserve(identity)).status, 'denied');
  const prepared = (await store.missionRuns.inspect(context, identity.missionId)).mission as any;
  assert.equal(prepared.state, 'queued');
  assert.equal(prepared.attempts[0].state, 'ready');
  assert.deepEqual(prepared.usage, { attempt: 1, model: 0, tool: 0 });
  assert.equal((await store.missionRuns.beginExecution(identity, second.lease as any)).status, 'ok');
  assert.equal((await reserve(identity)).reserved, true);
});
test('S05-T07 current source access and cancellation override a previously acquired allocation lease', async () => {
  const { identity, input } = await mission();
  const claimed = await store.missionRuns.claimDispatch(context, identity.attemptId, 'dispatcher');
  assert.equal(claimed.status, 'ok');
  await admin.query("UPDATE cos.sources SET status='revoked' WHERE scope_id=$1 AND id=$2", [
    scope,
    input.sources[0].source_id,
  ]);
  assert.equal((await store.missionRuns.authorizeDispatch(identity, claimed.lease as any)).status, 'denied');
  assert.equal(
    (await store.missionRuns.markDispatchReady(identity, claimed.lease as any, digest('native'))).status,
    'denied',
  );
  await store.missionRuns.cancel(context, identity.missionId);
  assert.equal((await store.missionRuns.beginExecution(identity, claimed.lease as any)).status, 'denied');
  assert.equal((await store.missionRuns.claimDispatch(context, identity.attemptId, 'dispatcher')).status, 'denied');
});
async function dispatched(identity: CosMissionIdentity) {
  const claim = await store.missionRuns.claimDispatch(context, identity.attemptId, 'read-dispatcher');
  assert.equal(claim.status, 'ok');
  const lease = claim.lease as MissionDispatchLease;
  assert.equal((await store.missionRuns.markDispatchReady(identity, lease, digest('native-fixture'))).status, 'ok');
  assert.equal((await store.missionRuns.beginExecution(identity, lease)).status, 'ok');
  return lease;
}
test('S05-T02/T03 specialist context returns only the assigned exact revision after a fresh root tool reservation', async () => {
  const a = await mission(),
    b = await mission(),
    lease = await dispatched(a.identity),
    call = randomUUID();
  const read = await store.missionRuns.readContext(a.identity, lease, call);
  assert.equal(read.status, 'ok');
  const captured = read.context as {
    sources: Array<{ source_id: string; revision_id: string; chunks: Array<{ text: string }> }>;
  };
  assert.deepEqual(
    captured.sources.map((s) => ({ source_id: s.source_id, revision_id: s.revision_id })),
    a.input.sources,
  );
  assert.ok(captured.sources[0].chunks[0].text.includes('SOURCE_CANARY_'));
  assert.ok(!JSON.stringify(read).includes(b.input.sources[0].source_id));
  assert.deepEqual(read.template, RESEARCH_TEMPLATE);
  const exposed = (await rows('evidence_refs')).filter((e) => e.session_id === a.identity.sessionId);
  assert.ok(exposed.length > 0);
  assert.ok(
    exposed.every(
      (e) =>
        e.context_generation === a.identity.attemptId &&
        e.source_id === a.input.sources[0].source_id &&
        e.processing_provider === 'codex',
    ),
  );
  assert.equal(((await store.missionRuns.inspect(context, a.identity.missionId)).mission as any).usage.tool, 1);
  assert.deepEqual(await store.missionRuns.readContext(a.identity, lease, call), { status: 'pending' });
  assert.equal(((await store.missionRuns.inspect(context, a.identity.missionId)).mission as any).usage.tool, 1);
});
test('S05-T09 concurrent context reads consume the root tool cap without uncharged disclosure', async () => {
  const { identity } = await mission(),
    lease = await dispatched(identity);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => store.missionRuns.readContext(identity, lease, randomUUID())),
  );
  assert.equal(results.filter((r) => r.status === 'ok').length, 2);
  assert.ok(results.filter((r) => r.status !== 'ok').every((r) => r.context === undefined));
  assert.equal(((await store.missionRuns.inspect(context, identity.missionId)).mission as any).usage.tool, 2);
});
test('S05-T07 context read refuses stale dispatch fences, altered child identities and cancellation', async () => {
  const { identity } = await mission(),
    lease = await dispatched(identity);
  for (const [i, l] of [
    [{ ...identity, sessionId: 'foreign' }, lease],
    [{ ...identity, generation: 2 }, lease],
    [identity, { ...lease, fence: lease.fence + 1 }],
    [identity, { ...lease, owner: 'foreign' }],
  ] as Array<[CosMissionIdentity, MissionDispatchLease]>)
    assert.equal((await store.missionRuns.readContext(i, l, randomUUID())).status, 'denied');
  assert.equal(((await store.missionRuns.inspect(context, identity.missionId)).mission as any).usage.tool, 0);
  await store.missionRuns.cancel(context, identity.missionId);
  assert.equal((await store.missionRuns.readContext(identity, lease, randomUUID())).status, 'denied');
});
test('S05-T03/T10 context source revocation and lease expiry deny disclosure before reserving another tool call', async () => {
  for (const failure of ['source', 'lease']) {
    const { identity, input } = await mission(),
      lease = await dispatched(identity);
    if (failure === 'source')
      await admin.query("UPDATE cos.sources SET status='revoked' WHERE scope_id=$1 AND id=$2", [
        scope,
        input.sources[0].source_id,
      ]);
    else
      await admin.query(
        "UPDATE cos.mission_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND id=$2",
        [scope, identity.attemptId],
      );
    assert.deepEqual(await store.missionRuns.readContext(identity, lease, randomUUID()), { status: 'denied' });
    assert.equal(((await store.missionRuns.inspect(context, identity.missionId)).mission as any).usage.tool, 0);
  }
});
