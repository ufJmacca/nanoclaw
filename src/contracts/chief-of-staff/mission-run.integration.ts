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
import { permitCosOutbound } from '../../cos-boundary.js';
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
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import type { CosMissionIdentity } from '../../cos-mission-boundary.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { MissionRunStore, type MissionDispatchLease } from '../../modules/chief-of-staff/missions/run-store.js';
import type { MissionResult } from '../../modules/chief-of-staff/contracts/mission-result.js';

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
async function mission(limits = { max_turns: 2, max_tool_calls: 2, max_attempts: 2 }) {
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
