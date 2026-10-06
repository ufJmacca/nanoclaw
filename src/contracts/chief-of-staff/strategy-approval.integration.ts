import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { KnowledgeStore, type Evidence, type KnowledgeContext } from '../../modules/chief-of-staff/knowledge/store.js';
import { digest, type Result } from '../../modules/chief-of-staff/domain/contracts.js';
import type {
  ReviewCharterChange,
  StrategyObservationChange,
} from '../../modules/chief-of-staff/contracts/strategy-protocol.js';
import type { CosBinding } from '../../cos-boundary.js';

const scope = 'strategy-approval-' + randomUUID(),
  foreign = 'strategy-foreign-' + randomUUID(),
  context = {
    scopeId: scope,
    ownerId: 'fixture-owner',
    agentGroupId: scope,
    sessionId: scope,
    ingressId: randomUUID(),
  },
  retained: KnowledgeContext = { ...context, provider: 'codex', generation: randomUUID() };
let admin: pg.Client, store: PriorityStore, knowledge: KnowledgeStore, root: string, charter: ReviewCharterChange;
let busy: string, useful: string, foreignRecord: string;
let unknownRequest: string;
async function decide(proposal: Result, decision: 'approve' | 'reject' = 'approve', ownerId = context.ownerId) {
  return store.decide(
    { ...context, ownerId, ingressId: randomUUID() },
    String(proposal.proposal_id),
    String(proposal.confirmation_token),
    decision,
  );
}
async function propose(change: ReviewCharterChange | StrategyObservationChange, id = randomUUID()) {
  return store.propose(context, id, change, retained);
}
async function apply(proposal: Result) {
  assert.equal((await decide(proposal)).status, 'ok');
  return store.apply(scope, String(proposal.proposal_id));
}
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-strategy-approval-'));
  for (const name of ['staging', 'artifacts']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(root, 'artifacts'), path.join(root, 'staging')),
  );
  store = new PriorityStore(database, knowledge);
  for (const id of [scope, foreign])
    await admin.query(
      "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture',$1,$1,'active')",
      [id],
    );
  const projects = [];
  for (const title of ['Many tasks; unknown outcome', 'Few tasks; useful outcome']) {
    const p = await store.propose(context, randomUUID(), {
      kind: 'project',
      title,
      description: 'Synthetic desired outcome',
      lifecycle: 'active',
      reason: 'Fixture owner priority',
      expected_version: 0,
    });
    assert.equal(p.status, 'ok');
    projects.push(String((await apply(p)).record_id));
  }
  [busy, useful] = projects;
  foreignRecord = randomUUID();
  await admin.query(
    "INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance) VALUES($1,$2,'project','Foreign private record','','active',1,'{}')",
    [foreignRecord, foreign],
  );
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  charter = {
    kind: 'review_charter',
    expected_version: 0,
    reason: 'Review useful results',
    definition: {
      title: 'Synthetic strategy review',
      initiative_ids: [busy, useful],
      source_ids: [],
      starts_at: new Date(now.getTime() - 86400000).toISOString(),
      ends_at: new Date(now.getTime() + 30 * 86400000).toISOString(),
      cadence: 'manual',
      resource_constraints: 'Six hours a week',
      evidence_limits: 'Fixtures only; outside work is not observed',
      exploration_minutes_per_week: 60,
      measures: [
        { id: 'busy-result', initiative_id: busy, outcome: 'A useful decision', test: 'An observed useful result' },
        { id: 'useful-result', initiative_id: useful, outcome: 'Less repeated effort', test: 'A recorded comparison' },
      ],
      assumptions: [{ id: 'more-tasks', initiative_id: busy, statement: 'More tasks produce useful results' }],
    },
  };
});
after(async () => {
  if (admin) {
    await admin.query('BEGIN');
    try {
      await admin.query('SET CONSTRAINTS ALL DEFERRED');
      await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=ANY($1)', [[scope, foreign]]);
      for (const table of [
        'strategy_direction_revisions',
        'strategy_directions',
        'strategy_decisions',
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
test('S10 an exact owner-approved review charter creates one revision and no automation', async () => {
  const id = randomUUID(),
    proposal = await propose(charter, id);
  assert.equal(proposal.status, 'ok');
  assert.equal((await store.apply(scope, String(proposal.proposal_id))).status, 'denied');
  assert.equal((await decide(proposal, 'approve', 'intruder')).status, 'denied');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.review_charters WHERE scope_id=$1', [scope])).rows[0].n,
    0,
  );
  const applied = await apply(proposal);
  assert.equal(applied.status, 'ok');
  assert.deepEqual(await store.apply(scope, String(proposal.proposal_id)), applied);
  assert.equal((await store.status(context, id)).status, 'ok');
  assert.equal(
    (await admin.query('SELECT version FROM cos.review_charters WHERE scope_id=$1', [scope])).rows[0].version,
    1,
  );
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.review_charter_revisions WHERE scope_id=$1', [scope]))
      .rows[0].n,
    1,
  );
  for (const table of ['mandates', 'missions', 'actions', 'brief_schedules'])
    assert.equal(
      (await admin.query('SELECT count(*)::int AS n FROM cos.' + table + ' WHERE scope_id=$1', [scope])).rows[0].n,
      0,
    );
});
test('S10 rejecting a review charter replacement preserves approved goals and charter history', async () => {
  const original = (
    await admin.query('SELECT id,version,lifecycle,description FROM cos.records WHERE scope_id=$1 ORDER BY id', [scope])
  ).rows;
  const proposed = await propose({
    ...charter,
    expected_version: 1,
    definition: { ...charter.definition, resource_constraints: 'Only two hours' },
  });
  assert.equal(proposed.status, 'ok');
  assert.equal((await decide(proposed, 'reject')).status, 'ok');
  assert.equal((await store.apply(scope, String(proposed.proposal_id))).status, 'denied');
  assert.deepEqual(
    (
      await admin.query('SELECT id,version,lifecycle,description FROM cos.records WHERE scope_id=$1 ORDER BY id', [
        scope,
      ])
    ).rows,
    original,
  );
  assert.equal(
    (await admin.query('SELECT version FROM cos.review_charters WHERE scope_id=$1', [scope])).rows[0].version,
    1,
  );
});
test('S10 a charter changed after preview must be revalidated before another approval', async () => {
  const a = await propose({ ...charter, expected_version: 1 }),
    b = await propose({ ...charter, expected_version: 1 });
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.equal((await apply(a)).status, 'ok');
  assert.equal((await decide(b)).status, 'denied');
  assert.equal(
    (await admin.query('SELECT version FROM cos.review_charters WHERE scope_id=$1', [scope])).rows[0].version,
    2,
  );
});
test('S10 an unknown outcome observation remains an approved observation, not achieved work or an execution grant', async () => {
  const observation: StrategyObservationChange = {
    kind: 'strategy_observation',
    charter_version: 2,
    initiative_id: busy,
    target: { kind: 'outcome', id: 'busy-result' },
    basis: 'unknown',
    signal: 'unknown',
    statement: 'The desired result is not yet observed',
    observed_at: new Date(Date.now() - 1000).toISOString(),
    evidence: [],
    reason: 'Keep uncertainty explicit',
  };
  const id = randomUUID(),
    proposal = await propose(observation, id);
  unknownRequest = id;
  assert.equal(proposal.status, 'ok');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.strategy_observations WHERE scope_id=$1', [scope])).rows[0]
      .n,
    0,
  );
  const applied = await apply(proposal);
  assert.equal(applied.status, 'ok');
  assert.deepEqual(await store.apply(scope, String(proposal.proposal_id)), applied);
  assert.equal((await store.status(context, id)).status, 'ok');
  const rows = (await admin.query('SELECT body FROM cos.strategy_observations WHERE scope_id=$1', [scope])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body.basis, 'unknown');
  assert.equal(rows[0].body.signal, 'unknown');
});
test('S10 review approval cannot admit foreign initiatives, unavailable sources or automatic origins', async () => {
  for (const definition of [
    {
      ...charter.definition,
      initiative_ids: [foreignRecord],
      measures: [{ ...charter.definition.measures[0], initiative_id: foreignRecord }],
      assumptions: [],
    },
    { ...charter.definition, source_ids: ['not-admitted'] },
  ])
    assert.equal((await propose({ ...charter, expected_version: 2, definition })).status, 'denied');
  assert.equal(
    (
      await store.propose(
        { ...context, origin: { kind: 'schedule', runId: randomUUID(), generation: 1 } },
        randomUUID(),
        charter,
        retained,
      )
    ).status,
    'denied',
  );
});
test('S10 a selected goal changed after a charter preview requires a new owner proposal', async () => {
  const pending = await propose({ ...charter, expected_version: 2 });
  assert.equal(pending.status, 'ok');
  const old = (await admin.query('SELECT * FROM cos.records WHERE scope_id=$1 AND id=$2', [scope, busy])).rows[0];
  const edit = await store.propose(context, randomUUID(), {
    kind: 'project',
    record_id: busy,
    expected_version: old.version,
    title: old.title,
    description: 'A revised desired outcome',
    lifecycle: 'active',
    reason: 'Fixture priority revision',
  });
  assert.equal((await apply(edit)).status, 'ok');
  assert.equal((await decide(pending)).status, 'denied');
  assert.equal((await store.status(context, unknownRequest)).status, 'ok');
});
test('S10 competing approval applications preserve one charter revision and reconcile the losing apply as conflict', async () => {
  const a = await propose({ ...charter, expected_version: 2 }),
    b = await propose({ ...charter, expected_version: 2 });
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.equal((await decide(a)).status, 'ok');
  assert.equal((await decide(b)).status, 'ok');
  assert.equal((await store.apply(scope, String(a.proposal_id))).status, 'ok');
  assert.equal((await store.apply(scope, String(b.proposal_id))).status, 'conflict');
  assert.equal((await store.apply(scope, String(b.proposal_id))).status, 'conflict');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.review_charter_revisions WHERE scope_id=$1', [scope]))
      .rows[0].n,
    3,
  );
  assert.equal((await store.status(context, unknownRequest)).status, 'ok');
});
test('S10 observation targets, timestamps and retained private identity are validated before a preview exists', async () => {
  const base: StrategyObservationChange = {
    kind: 'strategy_observation',
    charter_version: 3,
    initiative_id: busy,
    target: { kind: 'outcome', id: 'busy-result' },
    basis: 'self_reported',
    signal: 'supported',
    statement: 'Fixture operator report',
    observed_at: new Date(Date.now() - 1000).toISOString(),
    evidence: [],
    reason: 'Preserve report type',
  };
  for (const change of [
    { ...base, observed_at: new Date(Date.now() + 86400000).toISOString() },
    { ...base, target: { kind: 'outcome' as const, id: 'useful-result' } },
    { ...base, target: { kind: 'actual_effort' as const, id: useful } },
  ])
    assert.equal((await propose(change)).status, 'denied');
  assert.equal((await store.propose(context, randomUUID(), base)).status, 'denied');
  assert.equal((await store.propose(context, randomUUID(), base, { ...retained, scopeId: foreign })).status, 'denied');
  assert.equal(
    (await store.propose(context, randomUUID(), base, { ...retained, provider: 'unsupported' })).status,
    'denied',
  );
});
test('S10 source withdrawal invalidates pending outcome previews, status, replay and owner approval', async () => {
  fs.writeFileSync(path.join(root, 'staging', 'outcome.md'), 'StrategyOutcomeCanary is an observed useful result.', {
    mode: 0o600,
  });
  const imported = await knowledge.importSource(retained, randomUUID(), {
    sourceKey: 'strategy-outcome',
    filename: 'outcome.md',
    title: 'Synthetic outcome',
    processingProviders: ['codex'],
    expectedVersion: 0,
  });
  assert.equal(imported.status, 'ok');
  const source = String(imported.source_id),
    approved = await propose({
      ...charter,
      expected_version: 3,
      definition: { ...charter.definition, source_ids: [source] },
    });
  assert.equal(approved.status, 'ok');
  assert.equal((await apply(approved)).status, 'ok');
  const found = await knowledge.search(retained, { query: 'StrategyOutcomeCanary', sourceId: source });
  assert.equal(found.status, 'ok');
  const evidence = (found.items as Evidence[])[0];
  assert.ok(evidence);
  const observation: StrategyObservationChange = {
    kind: 'strategy_observation',
    charter_version: 4,
    initiative_id: useful,
    target: { kind: 'outcome', id: 'useful-result' },
    basis: 'evidence_backed',
    signal: 'supported',
    statement: 'An observed useful result',
    observed_at: new Date(Date.now() - 1000).toISOString(),
    evidence: [{ kind: 'source', evidence_id: evidence.evidence_id }],
    reason: 'Record the observed result',
  };
  const id = randomUUID(),
    pending = await propose(observation, id);
  assert.equal(pending.status, 'ok');
  const acceptedId = randomUUID(),
    accepted = await propose(observation, acceptedId);
  assert.equal(accepted.status, 'ok');
  const applied = await apply(accepted);
  assert.equal(applied.status, 'ok');
  const stored = (
    await admin.query('SELECT body,digest FROM cos.strategy_observations WHERE scope_id=$1 AND proposal_id=$2', [
      scope,
      accepted.proposal_id,
    ])
  ).rows[0];
  assert.deepEqual(stored.body, observation);
  assert.equal(stored.digest, digest(observation));
  assert.equal((await store.status(context, unknownRequest)).status, 'ok');
  const revoke = await store.propose(context, randomUUID(), {
    kind: 'source_revoke',
    source_id: source,
    expected_version: 1,
    reason: 'Fixture source withdrawal',
  });
  assert.equal(revoke.status, 'ok');
  assert.equal((await apply(revoke)).status, 'ok');
  const binding = {
    ...context,
    provider: 'codex',
    instanceId: 'fixture',
    channelId: scope,
    messagingGroupId: scope,
    botId: 'fixture-bot',
  } as CosBinding;
  assert.equal(await store.previewCurrent(binding, String(pending.proposal_id), observation), false);
  assert.equal((await store.status(context, id)).status, 'denied');
  assert.equal((await propose(observation, id)).status, 'denied');
  assert.equal((await decide(pending)).status, 'denied');
  assert.equal((await store.status(context, acceptedId)).status, 'denied');
  assert.equal((await propose(observation, acceptedId)).status, 'denied');
  assert.equal((await store.apply(scope, String(accepted.proposal_id))).status, 'denied');
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int AS n FROM cos.strategy_observations WHERE scope_id=$1 AND proposal_id=$2',
        [scope, pending.proposal_id],
      )
    ).rows[0].n,
    0,
  );
});
test('S10 replacing an unexposed selected source invalidates its charter preview even in a current main context', async () => {
  const fresh = { ...retained, generation: randomUUID() },
    id = randomUUID();
  fs.writeFileSync(path.join(root, 'staging', 'replacement.md'), 'Initial source for an unexposed charter.', {
    mode: 0o600,
  });
  const first = await knowledge.importSource(fresh, randomUUID(), {
    sourceKey: 'strategy-replacement',
    filename: 'replacement.md',
    title: 'Unexposed source',
    processingProviders: ['codex'],
    expectedVersion: 0,
  });
  assert.equal(first.status, 'ok');
  const source = String(first.source_id),
    change = { ...charter, expected_version: 4, definition: { ...charter.definition, source_ids: [source] } };
  const pending = await store.propose(context, id, change, fresh);
  assert.equal(pending.status, 'ok');
  assert.equal((pending.review_dependencies as { sources: { id: string; version: number }[] }).sources[0].version, 1);
  fs.writeFileSync(path.join(root, 'staging', 'replacement.md'), 'A changed source requires a new preview.', {
    mode: 0o600,
  });
  const second = await knowledge.importSource(fresh, randomUUID(), {
    sourceKey: 'strategy-replacement',
    filename: 'replacement.md',
    title: 'Unexposed source',
    processingProviders: ['codex'],
    expectedVersion: 1,
  });
  assert.equal(second.status, 'ok');
  assert.equal((await knowledge.contextReady(fresh)).status, 'ok');
  assert.equal((await store.status(context, id)).status, 'denied');
  assert.equal((await store.propose(context, id, change, fresh)).status, 'denied');
  assert.equal((await decide(pending)).status, 'denied');
});
