import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { KnowledgeStore, type KnowledgeContext, type Evidence } from '../../modules/chief-of-staff/knowledge/store.js';
import type { CosBinding } from '../../cos-boundary.js';
import { fixtureDatabaseConfig, connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import type { WorkChange } from '../../modules/chief-of-staff/contracts/protocol.js';

const scope = 'work-' + randomUUID(),
  context = {
    scopeId: scope,
    ownerId: 'fixture-owner',
    agentGroupId: scope,
    sessionId: scope,
    ingressId: randomUUID(),
  };
const change: WorkChange = {
  kind: 'commitment',
  title: 'Prepare pilot review',
  description: 'Bring the agreed evidence.',
  reason: 'Suggested follow-up',
  state: 'confirmed',
  project_id: null,
  due: { kind: 'date', date: '2026-10-05', time_zone: 'Australia/Sydney' },
  defer_until: null,
  evidence: [],
  expected_version: 0,
};
let admin: pg.Client, pool: pg.Pool, store: PriorityStore, knowledge: KnowledgeStore, base: string;
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  pool = new pg.Pool(await fixtureDatabaseConfig());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-work-fixture-'));
  for (const dir of ['artifacts', 'staging']) fs.mkdirSync(path.join(base, dir), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(base, 'artifacts'), path.join(base, 'staging')),
  );
  store = new PriorityStore(database, knowledge);
  await pool.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,$2,'fixture-instance',$1,$1,'active')",
    [scope, context.ownerId],
  );
});
after(async () => {
  if (admin) {
    await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
    for (const table of [
      'work_revisions',
      'work_items',
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
      if ((await admin.query('SELECT to_regclass($1) AS t', ['cos.' + table])).rows[0].t)
        await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    }
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
  }
  await pool?.end();
  await store?.database.pool.end();
  await admin?.end();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});
async function approve(c: WorkChange) {
  const p = await store.propose({ ...context, ingressId: randomUUID() }, randomUUID(), c);
  assert.equal(p.status, 'ok');
  const decisionContext = { ...context, ingressId: randomUUID() };
  assert.equal(
    (await store.decide(decisionContext, String(p.proposal_id), String(p.confirmation_token), 'approve')).status,
    'ok',
  );
  return store.apply(scope, String(p.proposal_id));
}
test('S04-T04 extraction is a proposal until the exact owner decision is durably applied', async () => {
  const requestId = randomUUID(),
    p = await store.propose(context, requestId, change);
  assert.equal(p.status, 'ok');
  const operation = (
    await pool.query('SELECT method FROM cos.operations WHERE session_id=$1 AND request_id=$2', [scope, requestId])
  ).rows[0];
  assert.equal(operation.method, 'cos_work_change_propose');
  assert.deepEqual((await store.context(context)).work, []);
  assert.equal((await store.apply(scope, String(p.proposal_id))).status, 'denied');
  assert.equal(
    (
      await store.decide(
        { ...context, ownerId: 'intruder' },
        String(p.proposal_id),
        String(p.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  const owner = { ...context, ingressId: randomUUID() };
  assert.equal(
    (await store.decide(owner, String(p.proposal_id), String(p.confirmation_token), 'approve')).status,
    'ok',
  );
  const applied = await store.apply(scope, String(p.proposal_id));
  assert.equal(applied.status, 'ok');
  assert.deepEqual(await store.apply(scope, String(p.proposal_id)), applied);
  const rows = (await store.context(context)).work as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'confirmed');
  assert.equal(rows[0].owner_id, context.ownerId);
  assert.deepEqual(rows[0].due, change.due);
  assert.equal(rows[0].provenance.proposal_id, p.proposal_id);
});
test('S04-T03 confirmed, completed, deferred and dismissed revisions retain exact version history', async () => {
  const created = await approve(change);
  assert.equal(created.status, 'ok');
  const id = String(created.record_id);
  const deferred = await approve({
    ...change,
    record_id: id,
    expected_version: 1,
    state: 'deferred',
    defer_until: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  assert.equal(deferred.status, 'ok');
  assert.ok(!((await store.readWork(context, { view: 'open' })).items as any[]).some((r) => r.id === id));
  assert.equal(
    (await approve({ ...change, record_id: id, expected_version: 1, state: 'completed' })).status,
    'conflict',
  );
  assert.equal((await approve({ ...change, record_id: id, expected_version: 2, state: 'completed' })).status, 'ok');
  const revisions = (
    await pool.query('SELECT version,body FROM cos.work_revisions WHERE scope_id=$1 AND work_id=$2 ORDER BY version', [
      scope,
      id,
    ])
  ).rows;
  assert.deepEqual(
    revisions.map((r) => r.version),
    [1, 2, 3],
  );
  assert.deepEqual(
    revisions.map((r) => r.body.state),
    ['confirmed', 'deferred', 'completed'],
  );
  assert.equal(((await store.readWork(context, { record_id: id })).item as any).state, 'completed');
  assert.equal(((await store.readWork(context, { record_id: id, version: 2 })).item as any).state, 'deferred');
  assert.equal((await store.readWork({ ...context, ownerId: 'intruder' }, { record_id: id })).status, 'denied');
  assert(
    !(await store.context(context)).work || !((await store.context(context)).work as any[]).some((r) => r.id === id),
  );
  const decision = await approve({ ...change, kind: 'decision', state: 'needed' });
  assert.equal(decision.status, 'ok');
  assert.equal(
    (
      await approve({
        ...change,
        kind: 'decision',
        state: 'decided',
        record_id: String(decision.record_id),
        expected_version: 1,
      })
    ).status,
    'ok',
  );
  const dismissed = await approve(change);
  assert.equal(
    (await approve({ ...change, state: 'dismissed', record_id: String(dismissed.record_id), expected_version: 1 }))
      .status,
    'ok',
  );
});
test('S04-T03 scope, project identity and rejected proposals cannot create work', async () => {
  assert.equal(
    (await store.propose(context, randomUUID(), { ...change, project_id: 'unknown-project' })).status,
    'denied',
  );
  const p = await store.propose(context, randomUUID(), change);
  assert.equal(p.status, 'ok');
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(p.proposal_id),
        String(p.confirmation_token),
        'reject',
      )
    ).status,
    'ok',
  );
  assert.equal((await store.apply(scope, String(p.proposal_id))).status, 'denied');
  assert.equal((await store.context({ ...context, ownerId: 'intruder' })).status, 'denied');
});
test('S04-T03 approval rechecks project state and keeps historical revisions append-only', async () => {
  const project = await store.propose(context, randomUUID(), {
    kind: 'project',
    title: 'Pilot',
    description: 'Fixture project',
    lifecycle: 'active',
    reason: 'Owner direction',
    expected_version: 0,
  });
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(project.proposal_id),
        String(project.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  const applied = await store.apply(scope, String(project.proposal_id));
  assert.equal(applied.status, 'ok');
  const p = await store.propose(context, randomUUID(), { ...change, project_id: String(applied.record_id) });
  assert.equal(p.status, 'ok');
  const pendingId = randomUUID();
  const preview = await store.propose(context, pendingId, { ...change, project_id: String(applied.record_id) });
  assert.equal(preview.status, 'ok');
  assert.ok(
    ((await store.pendingOutbox(scope)).items as any[]).some((i) => i.payload.proposal_id === preview.proposal_id),
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
    'ok',
  );
  await pool.query("UPDATE cos.records SET lifecycle='inactive',version=version+1 WHERE scope_id=$1 AND id=$2", [
    scope,
    applied.record_id,
  ]);
  assert.ok(
    !((await store.pendingOutbox(scope)).items as any[]).some((i) => i.payload.proposal_id === preview.proposal_id),
  );
  assert.equal((await store.status(context, pendingId)).status, 'denied');
  assert.equal(
    (await store.propose(context, pendingId, { ...change, project_id: String(applied.record_id) })).status,
    'denied',
  );
  assert.equal((await store.apply(scope, String(p.proposal_id))).status, 'conflict');
  await assert.rejects(
    pool.query("UPDATE cos.work_revisions SET body='{}' WHERE scope_id=$1", [scope]),
    (e: any) => e.code === '42501',
  );
  assert.equal(
    (
      await store.propose(context, randomUUID(), {
        ...change,
        evidence: [{ kind: 'source', evidence_id: randomUUID() }],
      })
    ).status,
    'denied',
  );
});
test('S04-PG02 lost apply-commit acknowledgement reconciles the original confirmed revision', async () => {
  const p = await store.propose(context, randomUUID(), change);
  assert.equal(p.status, 'ok');
  const owner = { ...context, ingressId: randomUUID() };
  assert.equal(
    (await store.decide(owner, String(p.proposal_id), String(p.confirmation_token), 'approve')).status,
    'ok',
  );
  const faultyPool = new pg.Pool(await fixtureDatabaseConfig()),
    connection = await faultyPool.connect(),
    original = connection.query.bind(connection);
  let dropped = false;
  connection.query = (async (...args: unknown[]) => {
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    if (args[0] === 'COMMIT' && !dropped) {
      dropped = true;
      throw new Error('fixture_lost_commit_ack');
    }
    return result;
  }) as typeof connection.query;
  connection.release();
  try {
    const faulty = new PriorityStore(new BoundedDatabase(faultyPool));
    assert.equal((await faulty.apply(scope, String(p.proposal_id))).status, 'pending');
    const result = await store.apply(scope, String(p.proposal_id));
    assert.equal(result.status, 'ok');
    assert.deepEqual(await store.apply(scope, String(p.proposal_id)), result);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM cos.work_revisions WHERE scope_id=$1 AND work_id=$2', [
          scope,
          result.record_id,
        ])
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await store.decide(owner, String(p.proposal_id), String(p.confirmation_token), 'approve')).status,
      'ok',
    );
  } finally {
    await faultyPool.end();
  }
});
test('S04 evidence revocation withholds saved work, previews and operation replay across a new model context', async () => {
  const ctx: KnowledgeContext = { ...context, provider: 'codex', generation: randomUUID() };
  fs.writeFileSync(path.join(base, 'staging', 'work.md'), 'WorkEvidenceCanary is the agreed follow-up.', {
    mode: 0o600,
  });
  const imported = await knowledge.importSource(ctx, randomUUID(), {
    sourceKey: 'work-note',
    filename: 'work.md',
    title: 'Work note',
    processingProviders: ['codex'],
    expectedVersion: 0,
  });
  assert.equal(imported.status, 'ok');
  const found = await knowledge.search(ctx, { query: 'WorkEvidenceCanary' });
  assert.equal(found.status, 'ok');
  const evidence = (found.items as Evidence[])[0];
  const linked: WorkChange = {
    ...change,
    title: 'WorkEvidenceCanary',
    evidence: [{ kind: 'source', evidence_id: evidence.evidence_id }],
  };
  const id = randomUUID(),
    p = await store.propose(context, id, linked, ctx);
  assert.equal(p.status, 'ok');
  const binding = {
    ...context,
    provider: 'codex',
    instanceId: 'fixture-instance',
    channelId: scope,
    messagingGroupId: scope,
    botId: 'fixture-bot',
  } as CosBinding;
  assert.equal(await store.previewCurrent(binding, String(p.proposal_id), linked), true);
  assert.equal(await store.previewCurrent({ ...binding, ownerId: 'intruder' }, String(p.proposal_id), linked), false);
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
  const pending = await store.propose(context, randomUUID(), linked, ctx);
  assert.equal(pending.status, 'ok');
  const next = { ...ctx, generation: randomUUID() };
  assert.ok(JSON.stringify(await store.context(context, next)).includes('WorkEvidenceCanary'));
  const revoke = await store.propose(context, randomUUID(), {
    kind: 'source_revoke',
    source_id: String(imported.source_id),
    expected_version: 1,
    reason: 'Owner withdrew this source',
  });
  assert.equal(revoke.status, 'ok');
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(revoke.proposal_id),
        String(revoke.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  assert.equal((await store.apply(scope, String(revoke.proposal_id))).status, 'ok');
  assert.equal((await knowledge.contextReady(next)).status, 'denied');
  const view = await store.context(context, { ...next, generation: randomUUID() });
  assert.equal(view.status, 'ok');
  assert.equal(JSON.stringify(view).includes('WorkEvidenceCanary'), false);
  assert.ok(Number(view.work_withheld) > 0);
  assert.equal(await store.previewCurrent(binding, String(pending.proposal_id), linked), false);
  assert.equal(JSON.stringify(await store.pendingOutbox(scope)).includes('WorkEvidenceCanary'), false);
  assert.equal((await store.status(context, id)).status, 'denied');
  assert.equal((await store.propose(context, id, linked, ctx)).status, 'denied');
  assert.equal(
    (
      await store.readWork(
        context,
        { record_id: String(applied.record_id), version: 1 },
        { ...next, generation: randomUUID() },
      )
    ).status,
    'denied',
  );
});
test('S04 work inventory pages remain bounded with long Unicode descriptions and disclose complete details only by exact ID', async () => {
  const description = '漢'.repeat(8000);
  for (let i = 0; i < 7; i++)
    assert.equal((await approve({ ...change, title: 'Unicode inventory ' + i, description })).status, 'ok');
  const ids = new Set<string>();
  let offset: number | null = 0;
  do {
    const page = await store.readWork(context, { view: 'all', offset });
    assert.equal(page.status, 'ok');
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16000);
    const items = page.items as any[];
    assert.ok(items.length <= 5);
    for (const item of items) {
      assert.ok(!ids.has(item.id));
      ids.add(item.id);
      if (item.title.startsWith('Unicode inventory')) {
        assert.equal(item.description_truncated, true);
        const exact = await store.readWork(context, { record_id: item.id });
        assert.equal((exact.item as any).description, description);
        assert.equal('evidence_context' in (exact.item as any), false);
      }
    }
    offset = page.next_offset as number | null;
  } while (offset !== null);
  const count = (await pool.query('SELECT count(*)::int AS n FROM cos.work_items WHERE scope_id=$1', [scope])).rows[0]
    .n;
  assert.equal(ids.size, count - 1); // The revoked source-backed item remains withheld.
});
