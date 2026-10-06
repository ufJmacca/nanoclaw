import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
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
import { ReviewCollector } from '../../modules/chief-of-staff/strategy/collector.js';
import { outcomeStatus, type ReviewSnapshot } from '../../modules/chief-of-staff/strategy/review.js';
import { RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import type { MissionDispatchLease } from '../../modules/chief-of-staff/missions/run-store.js';
import type { MissionResult } from '../../modules/chief-of-staff/contracts/mission-result.js';
import type { CosMissionIdentity } from '../../cos-mission-boundary.js';
import { connectionFault } from './connection-fault.js';
import { MissionReviews } from '../../modules/chief-of-staff/missions/review-store.js';

const scope = 'strategy-mission-' + randomUUID();
const context: KnowledgeContext = {
  scopeId: scope,
  ownerId: 'fixture-owner',
  agentGroupId: scope,
  sessionId: scope,
  ingressId: randomUUID(),
  provider: 'codex',
  generation: randomUUID(),
};
const authority = {
  bindingDigest: digest('fixture reviewed delegation'),
  delegationDigest: digest('fixture revision'),
  contextGeneration: context.generation,
  provider: {
    profile: RESEARCH_TEMPLATE.providerProfile,
    model: 'fixture-codex',
    policyDigest: digest('fixture policy'),
  },
};
const request = { charter_version: 1, previous_review_id: null };
const identity = { review_id: 'review-' + digest(scope), revision: 1, previous: null };
let admin: pg.Client, root: string, store: PriorityStore, knowledge: KnowledgeStore, collector: ReviewCollector;
let selected: string, other: string, project: string, completedId: string;
async function approve(p: Record<string, unknown>) {
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
  const result = await store.apply(scope, String(p.proposal_id));
  assert.equal(result.status, 'ok');
  return result;
}
async function change(value: ProposalChange) {
  return approve(await store.propose(context, randomUUID(), value, context));
}
async function mission(sourceId: string, submit = true) {
  const source = (
    await admin.query('SELECT current_revision_id FROM cos.sources WHERE scope_id=$1 AND id=$2', [scope, sourceId])
  ).rows[0];
  const input = {
    question: 'Compare activity with useful exploration.',
    goal_id: null,
    project_id: project,
    sources: [{ source_id: sourceId, revision_id: source.current_revision_id }],
    acceptance_criteria: [{ id: 'tradeoff', description: 'Identify uncertainty and counterevidence.' }],
    limits: { ...MISSION_DEFAULT_LIMITS, max_turns: 2, max_tool_calls: 2, max_attempts: 1 },
  };
  const proposed = await store.requestMission(context, randomUUID(), input);
  await approve(proposed);
  const a = (
    await admin.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1 AND mission_id=$2', [
      scope,
      proposed.mission_id,
    ])
  ).rows[0];
  const worker: CosMissionIdentity = {
    scopeId: scope,
    missionId: a.mission_id,
    attemptId: a.id,
    generation: a.generation,
    agentGroupId: a.agent_group_id,
    sessionId: a.session_id,
    provider: 'codex',
  };
  if (!submit) return { worker, input };
  const claim = await store.missionRuns.claimDispatch(context, worker.attemptId, 'synthetic-strategy-fixture');
  assert.equal(claim.status, 'ok');
  const lease = claim.lease as MissionDispatchLease;
  assert.equal(
    (await store.missionRuns.markDispatchReady(worker, lease, digest('synthetic native allocation'))).status,
    'ok',
  );
  assert.equal((await store.missionRuns.beginExecution(worker, lease)).status, 'ok');
  const result: MissionResult = {
    format: 'cos-research-result/v1',
    outcome: 'partial',
    claims: [
      {
        id: 'counter',
        kind: 'inference',
        text: sourceId === other ? 'UnselectedMissionPrivateCanary' : 'More tasks may reduce useful exploration.',
        citations: [{ ...input.sources[0], ordinal: 0, start_line: 1, end_line: 1 }],
      },
    ],
    criteria: [{ id: 'tradeoff', claim_ids: ['counter'] }],
    limitations: ['Outside progress is not observed.'],
  };
  const receipt = await store.missionRuns.submitResult(worker, lease, randomUUID(), randomUUID(), result);
  assert.equal(receipt.status, 'ok');
  // This fixture has never launched a native worker; stopping is synthetic, with no model or messaging authority.
  assert.equal((await store.missionRuns.confirmStopped(worker)).status, 'ok');
  return { worker, input, result, receipt };
}
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-strategy-missions-'));
  for (const name of ['staging', 'artifacts']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(root, 'artifacts'), path.join(root, 'staging')),
  );
  store = new PriorityStore(database, knowledge, undefined, undefined, () => authority);
  collector = new ReviewCollector({
    database,
    knowledge,
    work: store.work,
    missionReviews: store.missionReviews,
  });
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture',$1,$1,'active')",
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
  project = String(
    (
      await change({
        kind: 'project',
        title: 'Synthetic exploration initiative',
        description: '',
        lifecycle: 'active',
        reason: 'Fixture approved initiative',
        expected_version: 0,
      })
    ).record_id,
  );
  for (const title of ['Selected comparison', 'UnselectedMissionSourceCanary']) {
    const filename = randomUUID() + '.md';
    fs.writeFileSync(path.join(root, 'staging', filename), 'Synthetic task count does not establish useful results.', {
      mode: 0o600,
    });
    const imported = await knowledge.importSource(context, randomUUID(), {
      sourceKey: randomUUID(),
      filename,
      title,
      processingProviders: ['codex'],
      expectedVersion: 0,
    });
    assert.equal(imported.status, 'ok');
    if (!selected) selected = String(imported.source_id);
    else other = String(imported.source_id);
  }
  const now = Date.now();
  await change({
    kind: 'review_charter',
    expected_version: 0,
    reason: 'Fixture scoped research review',
    definition: {
      title: 'Synthetic mission comparison',
      initiative_ids: [project],
      source_ids: [selected],
      starts_at: new Date(now - 86400000).toISOString(),
      ends_at: new Date(now + 30 * 86400000).toISOString(),
      cadence: 'manual',
      resource_constraints: 'Six hours per week',
      evidence_limits: 'Synthetic connected evidence only',
      exploration_minutes_per_week: 60,
      measures: [
        {
          id: 'useful-result',
          initiative_id: project,
          outcome: 'Useful exploration',
          test: 'Observe a useful decision',
        },
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
        for (const table of [
          'strategy_review_results',
          'strategy_review_snapshots',
          'strategy_observations',
          'review_charters',
          'review_charter_revisions',
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
          'scopes',
        ])
          await admin.query('DELETE FROM cos.' + table + ' WHERE ' + (table === 'scopes' ? 'id' : 'scope_id') + '=$1', [
            scope,
          ]);
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
test('S10 selected mission result preserves claims/limitations through the existing verified store', async () => {
  const m = await mission(selected);
  completedId = m.worker.missionId;
  const result = await collector.collect(context, request, identity);
  assert.equal(result.status, 'ok');
  const snapshot = result.snapshot as ReviewSnapshot;
  assert.deepEqual(snapshot.missions[0].result, m.result);
  assert.equal(snapshot.missions[0].submission_id, m.receipt!.submission_id);
  assert.equal(outcomeStatus(snapshot, project, 'useful-result'), 'unknown');
  assert.equal(store.database.pool.idleCount, store.database.pool.totalCount);
});
test('S10 queued mission without a result is explicit limited coverage', async () => {
  const m = await mission(selected, false);
  const result = await collector.collect(context, request, identity);
  assert.equal(result.status, 'ok');
  const snapshot = result.snapshot as ReviewSnapshot;
  assert.equal(snapshot.coverage, 'limited');
  assert.equal(snapshot.mission_coverage.find((r) => r.mission_id === m.worker.missionId)?.coverage, 'missing');
});
test('S10 unselected mission sources are withheld before any result disclosure', async () => {
  await mission(other);
  const original = store.missionReviews!.read.bind(store.missionReviews);
  let selectedReads = 0;
  const guarded = new ReviewCollector({
    database: store.database,
    knowledge,
    work: store.work,
    missionReviews: {
      reviewAuthorityDigest: (ctx) => store.missionReviews!.reviewAuthorityDigest(ctx),
      read: async (ctx: KnowledgeContext, id: string, submission: string) => {
        assert.equal(id, completedId);
        selectedReads++;
        return original(ctx, id, submission);
      },
    },
  });
  const result = await guarded.collect(context, request, identity);
  assert.equal(result.status, 'ok');
  assert.equal(selectedReads, 1);
  assert.equal((result.snapshot as ReviewSnapshot).coverage, 'limited');
  assert.equal(JSON.stringify(result).includes('UnselectedMission'), false);
});
test('S10 configured mission results require an adapter and never yield a complete empty cache', async () => {
  const result = await new ReviewCollector({ database: store.database, knowledge, work: store.work }).collect(
    context,
    request,
    identity,
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.coverage, 'incomplete');
  assert.equal(result.snapshot, undefined);
});
test('S10 mission evidence readers start after capture releases its connection and a real partition yields no partial snapshot', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig());
  const database = new BoundedDatabase(new pg.Pool(relay.config), 350);
  const remoteKnowledge = new KnowledgeStore(database, knowledge.artifacts);
  let reached = false;
  const remote = new ReviewCollector({
    database,
    knowledge: remoteKnowledge,
    work: store.work,
    missionReviews: new MissionReviews(database, store.missions, remoteKnowledge),
    hooks: {
      afterCollection: async () => {
        reached = true;
        assert.equal(database.pool.idleCount, database.pool.totalCount);
        relay.partition();
      },
    },
  });
  try {
    const result = await remote.collect(context, request, identity);
    assert.equal(reached, true);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.coverage, 'incomplete');
    for (const field of ['snapshot', 'text', 'version_refs', 'mission_projection', 'calendar_locations'])
      assert.equal(Object.hasOwn(result, field), false);
    assert.equal(database.pool.totalCount, 0);
  } finally {
    relay.restore();
    await database.pool.end();
    await relay.close();
  }
  assert.equal((await collector.collect(context, request, identity)).status, 'ok');
});
test('S10 a mission transition during result assembly invalidates the whole captured projection', async () => {
  const before = (
    await admin.query('SELECT version FROM cos.missions WHERE scope_id=$1 AND id=$2', [scope, completedId])
  ).rows[0].version;
  const racing = new ReviewCollector({
    database: store.database,
    knowledge,
    work: store.work,
    missionReviews: store.missionReviews,
    hooks: {
      afterCollection: async () => {
        await admin.query('UPDATE cos.missions SET version=version+1 WHERE scope_id=$1 AND id=$2', [
          scope,
          completedId,
        ]);
      },
    },
  });
  try {
    const result = await racing.collect(context, request, identity);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.snapshot, undefined);
    assert.equal(result.version_refs, undefined);
  } finally {
    await admin.query('UPDATE cos.missions SET version=$3 WHERE scope_id=$1 AND id=$2', [scope, completedId, before]);
  }
});
test('S10 withdrawing mission delegation withholds cached specialist prose', async () => {
  const prior = authority.delegationDigest;
  authority.delegationDigest = digest('withdrawn fixture revision');
  try {
    const result = await collector.collect(context, request, identity);
    assert.equal(result.status, 'ok');
    const snapshot = result.snapshot as ReviewSnapshot;
    assert.equal(snapshot.coverage, 'limited');
    assert.equal(snapshot.missions.length, 0);
    assert.equal(JSON.stringify(result).includes('More tasks may reduce'), false);
  } finally {
    authority.delegationDigest = prior;
  }
});
test('S10 fresh and historical publication fences recheck withdrawn mission delegation', async () => {
  const result = await collector.collect(context, request, identity);
  assert.equal(result.status, 'ok');
  const snapshot = result.snapshot as ReviewSnapshot;
  assert.equal(snapshot.missions.length, 1);
  const before = authority.delegationDigest;
  authority.delegationDigest = digest('withdrawn after strategic capture');
  try {
    for (const historical of [false, true]) {
      const checked = await knowledge.answers.dependencies.transaction(async (client) => ({
        status: 'ok',
        allowed: await collector.validateSnapshot(client, context, snapshot, result.version_refs, historical),
      }));
      assert.equal(checked.allowed, false);
    }
  } finally {
    authority.delegationDigest = before;
  }
});
