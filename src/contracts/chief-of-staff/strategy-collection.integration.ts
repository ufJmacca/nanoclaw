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
});
