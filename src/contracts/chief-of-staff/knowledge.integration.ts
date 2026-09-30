import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { fixtureDatabaseConfig, connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import {
  KnowledgeStore,
  type KnowledgeContext,
  type ImportSource,
  type Evidence,
} from '../../modules/chief-of-staff/knowledge/store.js';
import { connectionFault } from './connection-fault.js';

const scope = 'knowledge-' + randomUUID(),
  other = scope + '-other';
const context: KnowledgeContext = {
  scopeId: scope,
  ownerId: 'fixture-owner',
  agentGroupId: scope,
  sessionId: scope,
  ingressId: randomUUID(),
  provider: 'codex',
  generation: randomUUID(),
};
let admin: pg.Client, pool: pg.Pool, store: KnowledgeStore, artifacts: KnowledgeArtifacts, base: string;
const note = (key: string, text: string, overrides: Partial<ImportSource> = {}): ImportSource => {
  const filename = key + '.md';
  fs.writeFileSync(path.join(base, 'staging', filename), text, { mode: 0o600 });
  return { sourceKey: key, filename, title: key, processingProviders: ['codex'], expectedVersion: 0, ...overrides };
};
const imported = async (input: ImportSource, ctx = context) => {
  const result = await store.importSource(ctx, randomUUID(), input);
  assert.equal(result.status, 'ok');
  return result;
};
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  assert.equal(await migrate(admin, fixtureRuntimeUser()), 2);
  pool = new pg.Pool(await fixtureDatabaseConfig());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-knowledge-integration-'));
  for (const directory of ['artifacts', 'staging']) fs.mkdirSync(path.join(base, directory), { mode: 0o700 });
  artifacts = new KnowledgeArtifacts(path.join(base, 'artifacts'), path.join(base, 'staging'));
  store = new KnowledgeStore(BoundedDatabase.fromConfig(await fixtureDatabaseConfig()), artifacts);
  for (const id of [scope, other])
    await pool.query(
      "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture-instance',$1,$1,'active')",
      [id],
    );
});
after(async () => {
  if (pool) {
    await pool.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=ANY($1)', [[scope, other]]);
    for (const table of [
      'derivation_links',
      'evidence_refs',
      'chunks',
      'revocation_tombstones',
      'source_revisions',
      'sources',
      'artifacts',
      'outbox',
      'operations',
      'events',
    ])
      await pool.query(`DELETE FROM cos.${table} WHERE scope_id=ANY($1)`, [[scope, other]]);
    await pool.query('DELETE FROM cos.scopes WHERE id=ANY($1)', [[scope, other]]);
    await pool.end();
  }
  await store?.database.pool.end();
  await admin?.end();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

test('S02-T01: scope filters exclude foreign text, scores and citations before retrieval', async () => {
  const a = await imported(note('alpha', 'Pilot Alpha blocked on supplier approval.'));
  await imported(note('foreign', 'Pilot Alpha FOREIGN_CANARY never disclose.'), {
    ...context,
    scopeId: other,
    agentGroupId: other,
    sessionId: other,
  });
  const result = await store.search(context, { query: 'Pilot Alpha' });
  assert.equal(result.status, 'ok');
  assert.equal(JSON.stringify(result).includes('FOREIGN_CANARY'), false);
  const rows = result.items as Evidence[];
  assert.ok(rows.some((row) => row.source_id === a.source_id));
  assert.equal((await store.search({ ...context, scopeId: other }, { query: 'Pilot' })).status, 'denied');
});
test('S02-T02: evidence resolves exact revision digest and actual normalized line locator', async () => {
  const text = '# Citation\nCafé approval blocks the pilot.\n',
    a = await imported(note('citation', text));
  const found = await store.search(
    { ...context, generation: randomUUID() },
    { query: 'Café', sourceId: String(a.source_id) },
  );
  assert.equal(found.status, 'ok');
  const row = (found.items as Evidence[])[0];
  assert.ok(row.evidence_id);
  assert.equal(row.revision_digest, a.digest);
  assert.equal(
    text
      .split('\n')
      .slice(row.start_line - 1, row.end_line)
      .join('\n'),
    row.text,
  );
  const exact = await store.get(context, String(a.source_id), String(a.revision_id), row.ordinal);
  assert.equal(exact.status, 'ok');
  assert.equal((exact.items as Evidence[])[0].text, row.text);
  assert.equal(JSON.stringify(exact).includes(base), false);
});
test('S02-T03: retries reconcile one immutable revision and changed content retains history', async () => {
  const input = note('revisions', 'The dependency is blocked.'),
    request = randomUUID();
  const a = await store.importSource(context, request, input);
  assert.equal(a.status, 'ok');
  assert.deepEqual(await store.importSource(context, request, input), a);
  const duplicate = await imported(input);
  assert.equal(duplicate.revision_id, a.revision_id);
  const b = await imported(note('revisions', 'The dependency is approved.', { expectedVersion: Number(a.version) }));
  assert.notEqual(b.revision_id, a.revision_id);
  assert.equal(b.version, 2);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE source_id=$1', [a.source_id])).rows[0]
      .n,
    2,
  );
  assert.equal((await store.importSource(context, request, input)).status, 'conflict');
});
test('S02-T07: contradictory independent sources remain visible without changing approved priorities', async () => {
  const ctx = { ...context, generation: randomUUID() };
  await imported(note('conflict-old', 'ContradictionCanary pilot supplier is blocked.'));
  await imported(note('conflict-new', 'ContradictionCanary pilot supplier is approved.'));
  const result = await store.search(ctx, { query: 'ContradictionCanary' });
  assert.equal(result.status, 'ok');
  assert.equal((result.items as Evidence[]).length, 2);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.records WHERE scope_id=$1', [scope])).rows[0].n,
    0,
  );
});
test('S02-T09: processing policy excludes a readable source from disallowed model contexts', async () => {
  const a = await imported(
    note('policy', 'ProviderPolicyCanary confidential text.', { processingProviders: ['claude'] }),
  );
  const result = await store.search({ ...context, generation: randomUUID() }, { query: 'ProviderPolicyCanary' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items, []);
  assert.equal((await store.get(context, String(a.source_id), String(a.revision_id), 0)).status, 'denied');
});
test('S02-T10: correction fences exposed context; a new context retrieves only the current revision', async () => {
  const ctx = { ...context, generation: randomUUID() },
    a = await imported(note('correction', 'CorrectionCanary the launch is blocked.'));
  assert.equal((await store.search(ctx, { query: 'CorrectionCanary' })).status, 'ok');
  const b = await imported(note('correction', 'CorrectionCanary the launch is ready.', { expectedVersion: 1 }));
  assert.equal((await store.search(ctx, { query: 'CorrectionCanary' })).status, 'denied');
  const fresh = await store.search({ ...ctx, generation: randomUUID() }, { query: 'CorrectionCanary' });
  assert.equal(fresh.status, 'ok');
  assert.equal((fresh.items as Evidence[])[0].revision_id, b.revision_id);
  assert.notEqual(b.revision_id, a.revision_id);
});
test('S02-PG01: real connection loss after byte publication admits nothing and retries one revision', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350);
  let fail = true;
  const fault = new KnowledgeStore(database, artifacts, {
    afterPublication: async () => {
      if (fail) relay.partition();
    },
  });
  try {
    await database.run((client) => client.query('SELECT 1'));
    const input = note('partition-import', 'PartitionImportCanary source.'),
      request = randomUUID();
    assert.ok(['pending', 'unavailable'].includes((await fault.importSource(context, request, input)).status));
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM cos.sources WHERE scope_id=$1 AND source_key=$2', [
          scope,
          input.sourceKey,
        ])
      ).rows[0].n,
      0,
    );
    assert.ok(fs.readdirSync(artifacts.root).some((name) => name.endsWith('.blob')));
    fail = false;
    relay.restore();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const retry = await fault.importSource(context, request, input);
    assert.equal(retry.status, 'ok');
    assert.deepEqual(await fault.importSource(context, request, input), retry);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE source_id=$1', [retry.source_id]))
        .rows[0].n,
      1,
    );
  } finally {
    await database.pool.end();
    await relay.close();
  }
});
test('S02-PG02: database-policy outage blocks cached private search and source redisplay', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350),
    fault = new KnowledgeStore(database, artifacts);
  try {
    const a = await imported(note('outage', 'OutageCanary private source.')),
      ctx = { ...context, generation: randomUUID() };
    assert.equal((await fault.search(ctx, { query: 'OutageCanary' })).status, 'ok');
    relay.partition();
    const result = await fault.search(ctx, { query: 'OutageCanary' });
    assert.equal(result.status, 'unavailable');
    assert.equal(JSON.stringify(result).includes('OutageCanary'), false);
    assert.equal((await fault.get(ctx, String(a.source_id), String(a.revision_id), 0)).status, 'unavailable');
  } finally {
    await database.pool.end();
    await relay.close();
  }
});
test('S02-T06: a prepared retrieval is denied if access changes before disclosure', async () => {
  const a = await imported(note('during-read', 'RevocationRaceCanary private source.'));
  const guarded = new KnowledgeStore(store.database, artifacts, {
    beforeDisclosure: async () => {
      await pool.query("UPDATE cos.sources SET status='revoked',version=version+1 WHERE scope_id=$1 AND id=$2", [
        scope,
        a.source_id,
      ]);
    },
  });
  const result = await guarded.search({ ...context, generation: randomUUID() }, { query: 'RevocationRaceCanary' });
  assert.equal(result.status, 'denied');
  assert.equal(JSON.stringify(result).includes('RevocationRaceCanary'), false);
});
test('S02-T03: concurrent corrections honour the reviewed source version and preserve one winner', async () => {
  const a = await imported(note('concurrent', 'ConcurrentCanary initial dependency.'));
  const first = note('concurrent-one', 'ConcurrentCanary supplier is ready.', {
    sourceKey: 'concurrent',
    expectedVersion: 1,
  });
  const second = note('concurrent-two', 'ConcurrentCanary supplier is delayed.', {
    sourceKey: 'concurrent',
    expectedVersion: 1,
  });
  const outcomes = await Promise.all([
    store.importSource(context, randomUUID(), first),
    store.importSource(context, randomUUID(), second),
  ]);
  assert.deepEqual(outcomes.map((r) => r.status).sort(), ['conflict', 'ok']);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE source_id=$1', [a.source_id])).rows[0]
      .n,
    2,
  );
});
