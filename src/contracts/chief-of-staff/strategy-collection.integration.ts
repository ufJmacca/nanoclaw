import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { connectionFault } from './connection-fault.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { KnowledgeStore, type Evidence, type KnowledgeContext } from '../../modules/chief-of-staff/knowledge/store.js';
import { digest, type ProposalChange } from '../../modules/chief-of-staff/domain/contracts.js';
import { ReviewCollector } from '../../modules/chief-of-staff/strategy/collector.js';
import { ReviewArtifacts } from '../../modules/chief-of-staff/strategy/artifacts.js';
import type { ReviewDraft } from '../../modules/chief-of-staff/contracts/strategy-protocol.js';
import { outcomeStatus, type ReviewSnapshot } from '../../modules/chief-of-staff/strategy/review.js';

const scope = 'strategy-collect-' + randomUUID(),
  foreign = 'strategy-other-' + randomUUID();
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
let admin: pg.Client, store: PriorityStore, knowledge: KnowledgeStore, collector: ReviewCollector, root: string;
let busy: string, useful: string, unselected: string, source: string;
let reviews: ReviewArtifacts, reviewId: string, reviewRequest: string, reviewText: string, draft: ReviewDraft;
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-strategy-collection-'));
  for (const name of ['staging', 'artifacts']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(root, 'artifacts'), path.join(root, 'staging')),
  );
  store = new PriorityStore(database, knowledge);
  collector = new ReviewCollector({ database, knowledge, work: store.work });
  reviews = new ReviewArtifacts(collector);
  for (const id of [scope, foreign])
    await admin.query(
      "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture',$1,$1,'active')",
      [id],
    );
  const projects: string[] = [];
  for (const title of ['Many tasks, unknown result', 'Few tasks, useful result', 'UnselectedStrategyPrivateCanary'])
    projects.push(
      String(
        (
          await approve({
            kind: 'project',
            title,
            description: 'Synthetic initiative',
            lifecycle: 'active',
            reason: 'Fixture owner direction',
            expected_version: 0,
          })
        ).record_id,
      ),
    );
  [busy, useful, unselected] = projects;
  await admin.query(
    "INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance) VALUES($1,$2,'project','ForeignStrategyPrivateCanary','','active',1,'{}')",
    [randomUUID(), foreign],
  );
  for (const title of ['Observed useful result', 'UnselectedStrategySourceCanary']) {
    const filename = randomUUID() + '.md';
    fs.writeFileSync(path.join(root, 'staging', filename), title + ' with synthetic evidence.', { mode: 0o600 });
    const imported = await knowledge.importSource(context, randomUUID(), {
      sourceKey: randomUUID(),
      filename,
      title,
      processingProviders: ['codex'],
      expectedVersion: 0,
    });
    assert.equal(imported.status, 'ok');
    if (!source) source = String(imported.source_id);
  }
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  await approve({
    kind: 'review_charter',
    expected_version: 0,
    reason: 'Review outcomes',
    definition: {
      title: 'Synthetic outcome comparison',
      initiative_ids: [busy, useful],
      source_ids: [source],
      starts_at: new Date(now.getTime() - 86400000).toISOString(),
      ends_at: new Date(now.getTime() + 30 * 86400000).toISOString(),
      cadence: 'manual',
      resource_constraints: 'Six hours a week',
      evidence_limits: 'Synthetic connected sources only; outside activity is unknown',
      exploration_minutes_per_week: 60,
      measures: [
        { id: 'busy-result', initiative_id: busy, outcome: 'A useful decision', test: 'Observe useful result' },
        { id: 'useful-result', initiative_id: useful, outcome: 'Less repeated effort', test: 'Record a comparison' },
      ],
      assumptions: [{ id: 'more-tasks', initiative_id: busy, statement: 'More tasks produce useful results' }],
    },
  });
  for (const project_id of [busy, busy, busy, useful, unselected]) {
    const change = {
      kind: 'commitment' as const,
      title: project_id === unselected ? 'UnselectedStrategyWorkCanary' : 'Completed synthetic task',
      description: '',
      reason: 'Fixture task',
      state: 'confirmed' as const,
      project_id,
      due: null,
      defer_until: null,
      evidence: [],
      expected_version: 0,
    };
    const work = await approve(change);
    await approve({ ...change, record_id: String(work.record_id), state: 'completed', expected_version: 1 });
  }
  const found = await knowledge.search(context, { query: 'Observed', sourceId: source });
  assert.equal(found.status, 'ok');
  const evidence = (found.items as Evidence[])[0];
  assert.ok(evidence);
  const common = {
    kind: 'strategy_observation' as const,
    charter_version: 1,
    observed_at: new Date(Date.now() - 1000).toISOString(),
    reason: 'Fixture outcome observation',
  };
  await approve({
    ...common,
    initiative_id: busy,
    target: { kind: 'outcome', id: 'busy-result' },
    basis: 'unknown',
    signal: 'unknown',
    statement: 'The result is not yet observed',
    evidence: [],
  });
  await approve({
    ...common,
    initiative_id: useful,
    target: { kind: 'outcome', id: 'useful-result' },
    basis: 'evidence_backed',
    signal: 'supported',
    statement: 'A useful result was observed',
    evidence: [{ kind: 'source', evidence_id: evidence.evidence_id }],
  });
  await approve({
    ...common,
    initiative_id: busy,
    target: { kind: 'assumption', id: 'more-tasks' },
    basis: 'evidence_backed',
    signal: 'challenged',
    statement: 'Task count did not establish a useful result',
    evidence: [{ kind: 'source', evidence_id: evidence.evidence_id }],
  });
});
after(async () => {
  if (admin) {
    await admin.query('BEGIN');
    try {
      await admin.query('SET CONSTRAINTS ALL DEFERRED');
      await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=ANY($1)', [[scope, foreign]]);
      for (const table of [
        'strategy_review_results',
        'strategy_review_snapshots',
        'strategy_observations',
        'review_charters',
        'review_charter_revisions',
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
        await admin.query(
          'DELETE FROM cos.' + table + ' WHERE ' + (table === 'scopes' ? 'id' : 'scope_id') + '=ANY($1)',
          [[scope, foreign]],
        );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  }
  await store?.database.pool.end();
  await admin?.end();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
test('S10 collects a complete approved outcome comparison and returns its released database connection', async () => {
  const result = await collector.collect(context, request, identity);
  assert.equal(result.status, 'ok');
  const snapshot = result.snapshot as ReviewSnapshot;
  assert.equal(snapshot.initiatives.length, 2);
  assert.equal(snapshot.work.filter((w) => w.project_id === busy && w.state === 'completed').length, 3);
  assert.equal(outcomeStatus(snapshot, busy, 'busy-result'), 'unknown');
  assert.equal(outcomeStatus(snapshot, useful, 'useful-result'), 'evidence_backed');
  assert.equal(
    snapshot.observations.some((o) => o.signal === 'challenged'),
    true,
  );
  assert.equal(snapshot.source_coverage.length, 1);
  assert.equal(snapshot.truncated, false);
  assert.equal(store.database.pool.idleCount, store.database.pool.totalCount);
  for (const table of ['strategy_review_snapshots', 'strategy_review_results', 'missions', 'actions'])
    assert.equal(
      (await admin.query('SELECT count(*)::int AS n FROM cos.' + table + ' WHERE scope_id=$1', [scope])).rows[0].n,
      0,
    );
});
test('S10 excludes foreign and unselected records, work and sources from every reviewer snapshot', async () => {
  const result = await collector.collect(context, request, identity);
  assert.equal(result.status, 'ok');
  assert.doesNotMatch(
    JSON.stringify(result),
    /ForeignStrategyPrivateCanary|UnselectedStrategyPrivateCanary|UnselectedStrategySourceCanary|UnselectedStrategyWorkCanary/,
  );
  assert.equal(
    (result.snapshot as ReviewSnapshot).initiatives.some((r) => r.id === unselected),
    false,
  );
  assert.equal((await collector.collect({ ...context, scopeId: foreign }, request, identity)).status, 'denied');
  assert.equal(
    (
      await collector.collect(
        { ...context, origin: { kind: 'schedule', runId: randomUUID(), generation: 1 } },
        request,
        identity,
      )
    ).status,
    'denied',
  );
  assert.equal((await collector.collect(context, { ...request, charter_version: 2 }, identity)).status, 'denied');
});
test('S10-PG01 an actual TCP partition after reading priorities returns incomplete without a partial review or local fallback', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350),
    remoteKnowledge = new KnowledgeStore(database, knowledge.artifacts),
    remoteStore = new PriorityStore(database, remoteKnowledge);
  let reached = false;
  const failing = new ReviewCollector({
    database,
    knowledge: remoteKnowledge,
    work: remoteStore.work,
    hooks: {
      afterRecords: async () => {
        reached = true;
        relay.partition();
      },
    },
  });
  try {
    const result = await failing.collect(context, request, identity);
    assert.equal(reached, true);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.coverage, 'incomplete');
    for (const field of ['snapshot', 'text', 'artifact_id', 'records', 'observations'])
      assert.equal(Object.hasOwn(result, field), false);
    assert.equal(database.pool.totalCount, 0);
  } finally {
    relay.restore();
    await database.pool.end();
    await relay.close();
  }
  assert.equal((await collector.collect(context, request, identity)).status, 'ok');
});
test('S10 review requests keep immutable snapshots in purgeable private artifacts and replay one receipt', async () => {
  reviewRequest = randomUUID();
  const result = await reviews.request(context, reviewRequest, request);
  assert.equal(result.status, 'ok');
  reviewId = String(result.review_id);
  assert.equal(result.revision, 1);
  assert.equal((result.snapshot as ReviewSnapshot).format, 'cos-strategy-snapshot/v1');
  assert.deepEqual(await reviews.request(context, reviewRequest, request), result);
  assert.equal((await reviews.request(context, reviewRequest, { ...request, charter_version: 2 })).status, 'conflict');
  const rows = (await admin.query('SELECT * FROM cos.strategy_review_snapshots WHERE scope_id=$1', [scope])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].snapshot_digest, digest(result.snapshot));
  assert.doesNotMatch(JSON.stringify(rows), /Synthetic outcome comparison|Task count did not|Completed synthetic task/);
  const operations = (
    await admin.query("SELECT result FROM cos.operations WHERE scope_id=$1 AND method='cos_review_request'", [scope])
  ).rows;
  assert.doesNotMatch(JSON.stringify(operations), /Synthetic outcome comparison|Task count did not/);
  const artifact = (
    await admin.query('SELECT * FROM cos.artifacts WHERE scope_id=$1 AND id=$2', [scope, rows[0].artifact_id])
  ).rows[0];
  assert.equal(artifact.kind, 'summary');
  assert.equal(artifact.lifecycle, 'published');
  assert.equal(
    (
      await admin.query('SELECT count(*)::int AS n FROM cos.derivation_links WHERE scope_id=$1 AND artifact_id=$2', [
        scope,
        artifact.id,
      ])
    ).rows[0].n > 0,
    true,
  );
});
test('S10 a bounded typed review publishes once through its exact current-context read ticket', async () => {
  const snapshot = (await reviews.request(context, reviewRequest, request)).snapshot as ReviewSnapshot;
  assert.ok(snapshot);
  const observed = snapshot.observations.find((o) => o.initiative_id === useful && o.basis === 'evidence_backed');
  assert.ok(observed);
  const option = (id: string, initiative_id: string, direction: 'continue' | 'pause') => ({
    id,
    initiative_id,
    direction,
    title: direction === 'continue' ? 'Continue unchanged' : 'Reduce repeated tasks',
    trade_off: 'Preserve useful work while leaving uncertain activity open to review',
    opportunity_cost: 'Repeated tasks consume limited attention',
    next_action: 'Observe a small useful result before expanding activity',
  });
  draft = {
    findings: [
      {
        kind: 'assumption',
        domain: 'outcome',
        initiative_id: busy,
        statement: 'Completed tasks do not establish the desired result',
        evidence: [],
        uncertainty: 'Outside progress is not observed',
      },
      {
        kind: 'fact',
        domain: 'outcome',
        initiative_id: useful,
        statement: 'A useful result was observed',
        evidence: [{ kind: 'observation', observation_id: observed.id }],
        uncertainty: 'Only the approved observation is available',
      },
    ],
    options: [
      option('continue-busy', busy, 'continue'),
      option('continue-useful', useful, 'continue'),
      option('pause-busy', busy, 'pause'),
    ],
    recommended_option_id: 'pause-busy',
    rationale: 'Prioritise observed useful results within the approved resources',
    confidence: 'medium',
    uncertainty: 'The selected sources do not show all outside progress',
    evidence_would_change: 'An observed useful result for the busy initiative',
    forecast_until: new Date(Date.parse(snapshot.as_of) + 7 * 86400000).toISOString(),
  };
  const id = randomUUID(),
    result = await reviews.submit(context, id, reviewId, 1, draft);
  assert.equal(result.status, 'ok');
  reviewText = String(result.text);
  assert.equal((await reviews.get(context, reviewId, 1)).text, reviewText);
  assert.equal((await reviews.submit(context, id, reviewId, 1, draft)).text, reviewText);
  assert.match(reviewText, /Completed tasks do not establish|A useful result was observed/);
  assert.equal((await reviews.authorizePublication(context, reviewText)).status, 'ok');
  assert.equal((await reviews.authorizePublication(context, reviewText + ' Unchecked private text')).status, 'denied');
  assert.equal(
    (await reviews.authorizePublication({ ...context, ingressId: randomUUID() }, reviewText)).status,
    'denied',
  );
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.strategy_review_results WHERE scope_id=$1', [scope])).rows[0]
      .n,
    1,
  );
  const rows = (
    await admin.query("SELECT result FROM cos.operations WHERE scope_id=$1 AND method='cos_review_submit'", [scope])
  ).rows;
  assert.doesNotMatch(JSON.stringify(rows), /Completed tasks do not establish|Prioritise observed useful/);
});
test('S10 result revisions reject forged findings, foreign reads and attempts to rewrite an earlier recommendation', async () => {
  assert.equal((await reviews.get({ ...context, scopeId: foreign }, reviewId, 1)).status, 'denied');
  const bad = structuredClone(draft);
  bad.findings[1].evidence = [{ kind: 'work', work_id: randomUUID(), version: 1 }];
  assert.equal((await reviews.submit(context, randomUUID(), reviewId, 1, bad)).status, 'denied');
  assert.equal(
    (await reviews.submit(context, randomUUID(), reviewId, 1, { ...draft, rationale: 'Rewrite the previous advice' }))
      .status,
    'conflict',
  );
  assert.equal((await reviews.get(context, reviewId, 1)).text, reviewText);
});
test('S10 private review integrity failure withholds both reading and exact-ticket publication', async () => {
  const row = (
    await admin.query('SELECT artifact_id FROM cos.strategy_review_results WHERE scope_id=$1 AND review_id=$2', [
      scope,
      reviewId,
    ])
  ).rows[0];
  const filename = path.join(root, 'artifacts', row.artifact_id + '.blob'),
    bytes = fs.readFileSync(filename);
  fs.writeFileSync(filename, 'CorruptedStrategyPrivateCanary', { mode: 0o600 });
  try {
    const read = await reviews.get(context, reviewId, 1);
    assert.equal(read.status, 'unavailable');
    assert.equal(Object.hasOwn(read, 'text'), false);
    assert.equal((await reviews.authorizePublication(context, reviewText)).status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(read), /CorruptedStrategyPrivateCanary|artifacts\/|\.blob/);
  } finally {
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
  }
  assert.equal((await reviews.get(context, reviewId, 1)).text, reviewText);
});
test('S10 a captured goal changed before publication fails its current-version fence', async () => {
  const captured = await collector.collect(context, request, identity);
  assert.equal(captured.status, 'ok');
  assert.equal(
    await store.database.run((client) =>
      collector.validateSnapshot(client, context, captured.snapshot as ReviewSnapshot, captured.version_refs),
    ),
    true,
  );
  const forged = structuredClone(captured.snapshot) as ReviewSnapshot;
  forged.work[0].state = 'confirmed';
  assert.equal(
    await store.database.run((client) => collector.validateSnapshot(client, context, forged, captured.version_refs)),
    false,
  );
  const old = (await admin.query('SELECT * FROM cos.records WHERE scope_id=$1 AND id=$2', [scope, busy])).rows[0];
  await approve({
    kind: 'project',
    record_id: busy,
    expected_version: old.version,
    title: old.title,
    description: 'Revised priority',
    lifecycle: 'active',
    reason: 'Fixture owner revision',
  });
  const checked = await store.database.run((client) =>
    collector.validateSnapshot(client, context, captured.snapshot as ReviewSnapshot, captured.version_refs),
  );
  assert.equal(checked, false);
  const fresh = await collector.collect(context, request, identity);
  assert.equal((await reviews.get(context, reviewId, 1)).status, 'denied');
  assert.equal((await reviews.authorizePublication(context, reviewText)).status, 'denied');
  assert.equal(fresh.status, 'ok');
  assert.equal((fresh.snapshot as ReviewSnapshot).initiatives.find((r) => r.id === busy)?.version, old.version + 1);
});
test('S10 withdrawn source authority closes review capture and retained snapshot disclosure', async () => {
  const captured = await collector.collect(context, request, identity);
  assert.equal(captured.status, 'ok');
  await approve({ kind: 'source_revoke', source_id: source, expected_version: 1, reason: 'Fixture source withdrawal' });
  const checked = await store.database.run((client) =>
    collector.validateSnapshot(client, context, captured.snapshot as ReviewSnapshot, captured.version_refs),
  );
  assert.equal(checked, false);
  assert.equal((await collector.collect(context, request, identity)).status, 'denied');
  assert.equal((await reviews.get(context, reviewId, 1)).status, 'denied');
  assert.equal((await reviews.request(context, reviewRequest, request)).status, 'denied');
  assert.equal((await reviews.authorizePublication(context, reviewText)).status, 'denied');
  const lifecycles = (
    await admin.query("SELECT lifecycle FROM cos.artifacts WHERE scope_id=$1 AND kind='summary'", [scope])
  ).rows;
  assert.equal(lifecycles.length, 2);
  assert.equal(
    lifecycles.every((r) => r.lifecycle === 'quarantined'),
    true,
  );
});
test('S10 due source retention removes private review bytes while preserving immutable review identities', async () => {
  const rows = (await admin.query("SELECT id FROM cos.artifacts WHERE scope_id=$1 AND kind='summary'", [scope])).rows;
  const current = (await admin.query('SELECT version FROM cos.sources WHERE scope_id=$1 AND id=$2', [scope, source]))
    .rows[0];
  await approve({
    kind: 'source_delete',
    source_id: source,
    expected_version: current.version,
    reason: 'Fixture owner deletion after withdrawal',
  });
  await admin.query(
    "UPDATE cos.revocation_tombstones SET purge_after=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND source_id=$2",
    [scope, source],
  );
  // This fixture has no native model history. Production uses the existing verified retirement consumer.
  knowledge.hooks.purgeContexts = async () => ({ status: 'ok' });
  assert.equal((await knowledge.purgeDue(scope)).status, 'ok');
  for (const row of rows) {
    assert.equal(fs.existsSync(path.join(root, 'artifacts', row.id + '.blob')), false);
    assert.equal(
      (await admin.query('SELECT lifecycle FROM cos.artifacts WHERE scope_id=$1 AND id=$2', [scope, row.id])).rows[0]
        .lifecycle,
      'deleted',
    );
  }
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.strategy_review_snapshots WHERE scope_id=$1', [scope]))
      .rows[0].n,
    1,
  );
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.strategy_review_results WHERE scope_id=$1', [scope])).rows[0]
      .n,
    1,
  );
  assert.equal((await reviews.get(context, reviewId, 1)).status, 'denied');
});
