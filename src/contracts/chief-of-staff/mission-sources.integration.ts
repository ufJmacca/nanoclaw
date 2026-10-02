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
import { KnowledgeStore, type KnowledgeContext } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import type { MissionSource } from '../../modules/chief-of-staff/contracts/mission-protocol.js';

const scope = 'mission-source-' + randomUUID();
const context: KnowledgeContext = {
  scopeId: scope,
  ownerId: 'owner',
  agentGroupId: scope,
  sessionId: scope,
  ingressId: 'fixture',
  provider: 'codex',
  generation: randomUUID(),
};
let admin: pg.Client,
  knowledge: KnowledgeStore,
  base: string,
  enabled = true;
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mission-sources-'));
  for (const dir of ['artifacts', 'staging']) fs.mkdirSync(path.join(base, dir), { mode: 0o700 });
  knowledge = new KnowledgeStore(
    BoundedDatabase.fromConfig(await fixtureDatabaseConfig()),
    new KnowledgeArtifacts(path.join(base, 'artifacts'), path.join(base, 'staging')),
    {},
    { retrievalEnabled: () => enabled },
  );
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'owner','fixture',$1,$1,'active')",
    [scope],
  );
});
after(async () => {
  if (admin) {
    await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
    for (const table of [
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
    ])
      await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
  }
  await knowledge?.database.pool.end();
  await admin?.end();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});
async function note(text: string): Promise<MissionSource> {
  const filename = randomUUID() + '.md';
  fs.writeFileSync(path.join(base, 'staging', filename), text, { mode: 0o600 });
  const result = await knowledge.importSource(context, randomUUID(), {
    sourceKey: filename.slice(0, -3),
    filename,
    title: 'Fixture admitted note',
    processingProviders: ['codex'],
    expectedVersion: 0,
  });
  assert.equal(result.status, 'ok');
  return { source_id: String(result.source_id), revision_id: String(result.revision_id) };
}
async function capture(sources: MissionSource[], selected = context, maxBytes = 32768) {
  return knowledge.database.run(async (client) => {
    await client.query('BEGIN');
    const result = await knowledge.captureMissionSources(client, selected, sources, maxBytes);
    await client.query('COMMIT');
    return result;
  });
}
test('S05-T02/T03 captures only exact selected note revisions and verifies their source bytes', async () => {
  const a = await note('CANARY_A\n\n# Options\nA is smaller.\n'),
    b = await note('CANARY_B: private sibling context.');
  const result = await capture([a]);
  assert.equal(result?.length, 1);
  assert.equal(result?.[0].source_id, a.source_id);
  assert.equal(result?.[0].revision_id, a.revision_id);
  assert.match(JSON.stringify(result), /CANARY_A/);
  assert.doesNotMatch(JSON.stringify(result), /CANARY_B/);
  assert.equal(await capture([{ ...a, revision_id: b.revision_id }]), null);
  assert.equal(await capture([a, a]), null);
});
test('S05-T03 refuses guessed scope, owner, provider and active-context changes', async () => {
  const a = await note('Admitted source for scope controls.');
  for (const patch of [
    { scopeId: 'other' },
    { ownerId: 'intruder' },
    { agentGroupId: 'foreign-group' },
    { provider: 'claude' },
    { generation: 'not-a-generation' },
  ])
    assert.equal(await capture([a], { ...context, ...patch }), null);
  enabled = false;
  try {
    assert.equal(await capture([a]), null);
  } finally {
    enabled = true;
  }
});
test('S05-T03/T07 changed processing permission and source revocation prevent later capture', async () => {
  const a = await note('A revocable source.');
  await admin.query("UPDATE cos.sources SET processing_providers=ARRAY['claude'] WHERE scope_id=$1 AND id=$2", [
    scope,
    a.source_id,
  ]);
  assert.equal(await capture([a]), null);
  await admin.query(
    "UPDATE cos.sources SET processing_providers=ARRAY['codex'],status='revoked' WHERE scope_id=$1 AND id=$2",
    [scope, a.source_id],
  );
  assert.equal(await capture([a]), null);
});
test('S05-T03 first research profile cannot admit calendar or unreviewed source policy', async () => {
  const a = await note('Not a calendar grant.');
  await admin.query(
    'UPDATE cos.sources SET provenance=provenance||\'{"origin":"calendar_observation"}\'::jsonb WHERE scope_id=$1 AND id=$2',
    [scope, a.source_id],
  );
  assert.equal(await capture([a]), null);
  await admin.query(
    'UPDATE cos.sources SET provenance=provenance||\'{"origin":"selected_staging_file"}\'::jsonb,access_policy=\'{"scope_owner_only":false}\' WHERE scope_id=$1 AND id=$2',
    [scope, a.source_id],
  );
  assert.equal(await capture([a]), null);
});
test('S05-T08 rejects changed chunk bytes and missing chunks instead of sealing incomplete evidence', async () => {
  const a = await note('# First\nOriginal bytes.\n# Second\nOther bytes.');
  await admin.query("UPDATE cos.chunks SET text='forged' WHERE scope_id=$1 AND revision_id=$2 AND ordinal=0", [
    scope,
    a.revision_id,
  ]);
  assert.equal(await capture([a]), null);
  await admin.query('DELETE FROM cos.chunks WHERE scope_id=$1 AND revision_id=$2 AND ordinal=0', [
    scope,
    a.revision_id,
  ]);
  assert.equal(await capture([a]), null);
});
test('S05-T09 bounds actual UTF-8 context without silently dropping selected notes', async () => {
  const a = await note('界'.repeat(500));
  assert.equal(await capture([a], context, 1024), null);
  assert.equal((await capture([a], context, 32768))?.length, 1);
  for (const max of [0, 1023, 65537, Infinity]) assert.equal(await capture([a], context, max), null);
});
test('S05-T07 a coordinator context exposed to revoked notes cannot delegate using another still-readable note', async () => {
  const a = await note('Exposure canary A.'),
    b = await note('Still-readable canary B.');
  const exposed = { ...context, generation: randomUUID() };
  assert.equal((await knowledge.search(exposed, { query: 'Exposure', sourceId: a.source_id })).status, 'ok');
  await admin.query("UPDATE cos.sources SET status='revoked' WHERE scope_id=$1 AND id=$2", [scope, a.source_id]);
  assert.equal(await capture([b], exposed), null);
  assert.equal((await capture([b], { ...context, generation: randomUUID() }))?.length, 1);
});
