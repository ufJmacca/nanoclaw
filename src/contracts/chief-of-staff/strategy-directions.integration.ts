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
import { type ReviewSnapshot } from '../../modules/chief-of-staff/strategy/review.js';
import { RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import { connectionFault } from './connection-fault.js';

const scope = 'strategy-direction-' + randomUUID();
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
let admin: pg.Client, root: string, store: PriorityStore, knowledge: KnowledgeStore;
let selected: string, other: string, project: string, reviewId: string;
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
async function mission(sourceId: string) {
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
}
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-strategy-directions-'));
  for (const name of ['staging', 'artifacts']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(root, 'artifacts'), path.join(root, 'staging')),
  );
  store = new PriorityStore(database, knowledge, undefined, undefined, () => authority);

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
  await mission(selected);
  await change({
    kind: 'commitment',
    title: 'Retained approved obligation',
    description: '',
    state: 'confirmed',
    project_id: project,
    due: null,
    defer_until: null,
    evidence: [],
    reason: 'Fixture work preservation',
    expected_version: 0,
  });
  reviewId = await publishReview();
});
after(async () => {
  try {
    if (admin) {
      await admin.query('BEGIN');
      try {
        await admin.query('SET CONSTRAINTS ALL DEFERRED');
        await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
        for (const table of [
          'strategy_directions',
          'strategy_direction_revisions',
          'strategy_decisions',
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
          'work_revisions',
          'work_items',
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

async function publishReview() {
  const prepared = await store.reviewArtifacts!.request(context, randomUUID(), request);
  assert.equal(prepared.status, 'ok');
  const snapshot = prepared.snapshot as ReviewSnapshot;
  assert.equal(
    snapshot.source_coverage.some((source) => source.source_id === other),
    false,
  );
  const option = (id: string, direction: 'continue' | 'pause') => ({
    id,
    initiative_id: project,
    direction,
    title: direction === 'continue' ? 'Continue unchanged' : 'Pause expansion',
    trade_off: 'Observe useful results before expanding',
    opportunity_cost: 'Less capacity for exploration',
    next_action: 'Ask for separate changes to any existing obligations',
  });
  const draft = {
    findings: [
      {
        kind: 'assumption' as const,
        domain: 'outcome' as const,
        initiative_id: project,
        statement: 'The desired outcome is not yet observed',
        evidence: [],
        uncertainty: 'Connected sources are incomplete',
      },
    ],
    options: [option('continue', 'continue'), option('pause', 'pause')],
    recommended_option_id: 'pause',
    rationale: 'Protect exploration while measuring useful results',
    confidence: 'low' as const,
    uncertainty: 'Outside progress is unknown',
    evidence_would_change: 'An observed useful result',
    forecast_until: new Date(Date.parse(snapshot.as_of) + 86400000).toISOString(),
  };
  const result = await store.reviewArtifacts!.submit(context, randomUUID(), String(prepared.review_id), 1, draft);
  assert.equal(result.status, 'ok');
  return String(prepared.review_id);
}
async function direction(reason: string, expectedRecord = 1, expectedDirection = 0, option_id = 'pause') {
  return store.requestDirection(context, randomUUID(), {
    review_id: reviewId,
    revision: 1,
    option_id,
    expected_record_version: expectedRecord,
    expected_direction_version: expectedDirection,
    reason,
  });
}
async function protectedState() {
  const state: Record<string, unknown> = {};
  for (const table of ['records', 'work_items', 'missions', 'mission_attempts', 'mission_budget_reservations'])
    state[table] = (
      await admin.query(
        'SELECT * FROM cos.' +
          table +
          ' WHERE scope_id=$1 ORDER BY ' +
          (table === 'mission_budget_reservations' ? 'mission_id,call_id' : 'id'),
        [scope],
      )
    ).rows;
  return state;
}
async function decision(p: Record<string, unknown>, verdict: 'approve' | 'reject') {
  return store.decide(
    { ...context, ingressId: randomUUID() },
    String(p.proposal_id),
    String(p.confirmation_token),
    verdict,
  );
}
async function priorityRevision() {
  const record = (await admin.query('SELECT * FROM cos.records WHERE scope_id=$1 AND id=$2', [scope, project])).rows[0];
  await change({
    kind: 'project',
    record_id: project,
    title: record.title,
    description: 'Revised fixture priorities',
    lifecycle: 'active',
    expected_version: record.version,
    reason: 'Fixture owner priority revision',
  });
  return record.version + 1;
}
test('S10-T04 rejecting an exact direction records the choice and changes no approved work or missions', async () => {
  const before = await protectedState();
  const proposed = await direction('Keep current direction while gathering outcome evidence');
  assert.equal(proposed.status, 'ok');
  assert.equal((await decision(proposed, 'reject')).status, 'ok');
  assert.equal((await store.apply(scope, String(proposed.proposal_id))).status, 'denied');
  assert.deepEqual(await protectedState(), before);
  const rows = (
    await admin.query('SELECT decision,direction,rationale FROM cos.strategy_decisions WHERE scope_id=$1', [scope])
  ).rows;
  assert.deepEqual(rows, [
    { decision: 'rejected', direction: 'pause', rationale: 'Keep current direction while gathering outcome evidence' },
  ]);
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.strategy_directions WHERE scope_id=$1', [scope])).rows[0].n,
    0,
  );
});
test('S10-T10 a revised approved direction records one revision without silently cancelling obligations', async () => {
  const before = await protectedState();
  const proposed = await direction('Pause expansion; retain every existing approved obligation');
  assert.equal(proposed.status, 'ok');
  assert.equal((await decision(proposed, 'approve')).status, 'ok');
  const captured = await store.reviewArtifacts!.collector.collect(context, request, {
    review_id: 'review-' + digest(randomUUID()),
    revision: 1,
    previous: null,
  });
  assert.equal(captured.status, 'ok');
  const applied = await store.apply(scope, String(proposed.proposal_id));
  assert.equal(applied.status, 'ok');
  const stillCurrent = await knowledge.answers.dependencies.transaction(async (client) => ({
    status: 'ok',
    valid: await store.reviewArtifacts!.collector.validateSnapshot(
      client,
      context,
      captured.snapshot as ReviewSnapshot,
      captured.version_refs,
    ),
  }));
  assert.equal(stillCurrent.valid, false, 'applying direction invalidates a captured pre-application review');
  assert.deepEqual(await store.apply(scope, String(proposed.proposal_id)), applied);
  assert.deepEqual(await protectedState(), before);
  const head = (
    await admin.query(
      'SELECT version,direction,rationale FROM cos.strategy_directions WHERE scope_id=$1 AND initiative_id=$2',
      [scope, project],
    )
  ).rows[0];
  assert.deepEqual(head, {
    version: 1,
    direction: 'pause',
    rationale: 'Pause expansion; retain every existing approved obligation',
  });
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.strategy_direction_revisions WHERE scope_id=$1', [scope]))
      .rows[0].n,
    1,
  );
  const fresh = await store.reviewArtifacts!.collector.collect(context, request, {
    review_id: 'review-' + digest(randomUUID()),
    revision: 1,
    previous: null,
  });
  assert.equal(fresh.status, 'ok');
  const snapshot = fresh.snapshot as ReviewSnapshot;
  assert.equal(snapshot.directions[0].version, 1);
  assert.equal(snapshot.directions[0].direction, 'pause');
  assert.equal(snapshot.decisions.find((row) => row.proposal_id === proposed.proposal_id)?.application, 'applied');
});
test('S10-T05 accepting a stale direction triggers revalidation without overwriting newer priorities', async () => {
  const proposed = await direction('A stale proposal must not overwrite newer priorities', 1, 1);
  assert.equal(proposed.status, 'ok');
  await priorityRevision();
  const before = await protectedState();
  assert.equal((await decision(proposed, 'approve')).status, 'conflict');
  assert.deepEqual(await protectedState(), before);
  assert.equal((await decision(proposed, 'reject')).status, 'ok');
});
test('S10 direction apply revalidates approved core versions and preserves the historical owner choice on conflict', async () => {
  reviewId = await publishReview();
  const proposed = await direction('Measure before expanding the initiative', 2, 1);
  assert.equal(proposed.status, 'ok');
  assert.equal((await decision(proposed, 'approve')).status, 'ok');
  await priorityRevision();
  const before = await protectedState();
  assert.equal((await store.apply(scope, String(proposed.proposal_id))).status, 'conflict');
  assert.deepEqual(await protectedState(), before);
  const historical = (
    await admin.query('SELECT decision FROM cos.strategy_decisions WHERE scope_id=$1 AND proposal_id=$2', [
      scope,
      proposed.proposal_id,
    ])
  ).rows;
  assert.deepEqual(historical, [{ decision: 'approved' }]);
  const fresh = await store.reviewArtifacts!.collector.collect(context, request, {
    review_id: 'review-' + digest(randomUUID()),
    revision: 1,
    previous: null,
  });
  assert.equal(fresh.status, 'ok');
  const snapshot = fresh.snapshot as ReviewSnapshot;
  assert.equal(snapshot.directions[0].version, 1);
  assert.equal(snapshot.decisions.find((row) => row.proposal_id === proposed.proposal_id)?.application, 'not_applied');
  assert.equal(
    (
      await admin.query('SELECT version FROM cos.strategy_directions WHERE scope_id=$1 AND initiative_id=$2', [
        scope,
        project,
      ])
    ).rows[0].version,
    1,
  );
});
test('S10 superseded direction revisions remain intact and the next choice is not an outcome label', async () => {
  reviewId = await publishReview();
  const before = await protectedState();
  const proposed = await direction(
    'Continue with a smaller outcome experiment; the earlier advice remains uncertain',
    3,
    1,
    'continue',
  );
  assert.equal(proposed.status, 'ok');
  assert.equal((await decision(proposed, 'approve')).status, 'ok');
  assert.equal((await store.apply(scope, String(proposed.proposal_id))).status, 'ok');
  assert.deepEqual(await protectedState(), before);
  const rows = (
    await admin.query('SELECT version,body FROM cos.strategy_direction_revisions WHERE scope_id=$1 ORDER BY version', [
      scope,
    ])
  ).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].body.change.option.direction, 'pause');
  assert.equal(rows[1].body.change.option.direction, 'continue');
  assert.equal(rows[1].body.superseded_version, 1);
  assert.equal(
    (await admin.query('SELECT direction,version FROM cos.strategy_directions WHERE scope_id=$1', [scope])).rows[0]
      .version,
    2,
  );
});
test('S10-PG02 losing the real accepted-decision commit reply preserves one choice and cannot reapply mission effects', async () => {
  reviewId = await publishReview();
  const proposed = await direction('A reply loss must preserve the exact historical choice', 3, 2);
  assert.equal(proposed.status, 'ok');
  const before = await protectedState();
  const ownerContext = { ...context, ingressId: randomUUID() };
  const relay = await connectionFault(await fixtureDatabaseConfig());
  const pool = new pg.Pool(relay.config);
  let armed = true,
    reached = false;
  pool.on('connect', (client) => {
    const original = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      if (args[0] === 'COMMIT' && armed) {
        armed = false;
        reached = true;
        relay.withholdReplies();
      }
      return (original as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as typeof client.query;
  });
  const database = new BoundedDatabase(pool, 350);
  const remoteKnowledge = new KnowledgeStore(database, knowledge.artifacts);
  const faulty = new PriorityStore(database, remoteKnowledge, undefined, undefined, () => authority);
  try {
    const result = await faulty.decide(
      ownerContext,
      String(proposed.proposal_id),
      String(proposed.confirmation_token),
      'approve',
    );
    assert.equal(reached, true);
    assert.equal(result.status, 'pending');
    assert.ok(relay.withheldReplyBytes() > 0, 'the real encrypted commit response was withheld');
    const committed = (
      await admin.query('SELECT decision FROM cos.strategy_decisions WHERE scope_id=$1 AND proposal_id=$2', [
        scope,
        proposed.proposal_id,
      ])
    ).rows;
    assert.deepEqual(committed, [{ decision: 'approved' }]);
    assert.equal(
      (await admin.query('SELECT state FROM cos.proposals WHERE scope_id=$1 AND id=$2', [scope, proposed.proposal_id]))
        .rows[0].state,
      'approved',
    );
  } finally {
    relay.restore();
    await pool.end();
    await relay.close();
  }
  for (let n = 0; n < 2; n++)
    assert.equal(
      (await store.decide(ownerContext, String(proposed.proposal_id), String(proposed.confirmation_token), 'approve'))
        .status,
      'ok',
    );
  for (let n = 0; n < 2; n++) assert.equal((await store.apply(scope, String(proposed.proposal_id))).status, 'ok');
  assert.deepEqual(await protectedState(), before);
  assert.equal(
    (
      await admin.query('SELECT count(*)::int AS n FROM cos.strategy_decisions WHERE scope_id=$1 AND proposal_id=$2', [
        scope,
        proposed.proposal_id,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int AS n FROM cos.strategy_direction_revisions WHERE scope_id=$1 AND proposal_id=$2',
        [scope, proposed.proposal_id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await admin.query('SELECT count(*)::int AS n FROM cos.outbox WHERE scope_id=$1 AND id=$2', [
        scope,
        'apply-' + proposed.proposal_id,
      ])
    ).rows[0].n,
    1,
  );
});
test('S10 host-derived direction values cannot bypass the dedicated route or owner identity', async () => {
  reviewId = await publishReview();
  const proposed = await direction('Preserve the exact owner-only direction boundary', 3, 3);
  assert.equal(proposed.status, 'ok');
  const before = await protectedState();
  assert.equal(
    (await store.propose(context, randomUUID(), proposed.change as ProposalChange, context)).status,
    'denied',
  );
  assert.equal(
    (
      await store.decide(
        { ...context, ownerId: 'foreign-owner', ingressId: randomUUID() },
        String(proposed.proposal_id),
        String(proposed.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  assert.deepEqual(await protectedState(), before);
  assert.equal((await decision(proposed, 'reject')).status, 'ok');
});
test('S10 a new charter excludes source-derived historical rationale before model disclosure', async () => {
  const definition = (await admin.query('SELECT definition FROM cos.review_charters WHERE scope_id=$1', [scope]))
    .rows[0].definition;
  await change({
    kind: 'review_charter',
    expected_version: 1,
    reason: 'Fixture source-free review',
    definition: { ...definition, source_ids: [] },
  });
  request.charter_version = 2;
  let captured;
  try {
    captured = await store.reviewArtifacts!.collector.collect(context, request, {
      review_id: 'review-' + digest(randomUUID()),
      revision: 1,
      previous: null,
    });
  } finally {
    await change({
      kind: 'review_charter',
      expected_version: 2,
      reason: 'Fixture restore selected source review',
      definition,
    });
    request.charter_version = 3;
    reviewId = await publishReview();
  }
  assert.equal(captured.status, 'ok');
  const snapshot = captured.snapshot as ReviewSnapshot;
  assert.deepEqual(snapshot.decisions, []);
  assert.deepEqual(snapshot.directions, []);
  assert.equal(snapshot.coverage, 'limited');
  assert.equal(JSON.stringify(snapshot).includes('A reply loss must preserve the exact historical choice'), false);
  const admitted = await store.reviewArtifacts!.collector.collect(context, request, {
    review_id: 'review-' + digest(randomUUID()),
    revision: 1,
    previous: null,
  });
  assert.equal(admitted.status, 'ok');
  assert.equal((admitted.snapshot as ReviewSnapshot).directions[0].version, 3);
});
test('S10 withdrawal of a source hides pending direction previews and keeps the approved direction history', async () => {
  const proposed = await direction('Source withdrawal must close this pending direction', 3, 3);
  assert.equal(proposed.status, 'ok');
  const pending = await store.pendingOutbox(scope);
  assert.equal(
    (pending.items as Array<{ payload: { proposal_id: string } }>).some(
      (p) => p.payload.proposal_id === proposed.proposal_id,
    ),
    true,
  );
  await change({
    kind: 'source_revoke',
    source_id: selected,
    expected_version: 1,
    reason: 'Fixture owner source withdrawal',
  });
  assert.equal((await decision(proposed, 'approve')).status, 'denied');
  assert.equal((await decision(proposed, 'reject')).status, 'denied');
  const closed = await store.pendingOutbox(scope);
  assert.equal(
    (closed.items as Array<{ payload: { proposal_id: string } }>).some(
      (p) => p.payload.proposal_id === proposed.proposal_id,
    ),
    false,
  );
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.strategy_direction_revisions WHERE scope_id=$1', [scope]))
      .rows[0].n,
    3,
  );
  assert.equal(
    (await admin.query('SELECT version FROM cos.strategy_directions WHERE scope_id=$1', [scope])).rows[0].version,
    3,
  );
});
