import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate, SCHEMA_VERSION } from '../../modules/chief-of-staff/store/migrations.js';

const scope = 'mission-schema-' + randomUUID();
let admin: pg.Client, runtime: pg.Pool;
const immutable = [
  'mission_context_manifests',
  'mission_work_orders',
  'mission_budget_reservations',
  'mission_result_submissions',
  'mission_reviews',
];
const mutable = ['missions', 'mission_attempts'];
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  assert.equal(await migrate(admin, fixtureRuntimeUser()), SCHEMA_VERSION);
  runtime = new pg.Pool(await fixtureDatabaseConfig());
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'owner','fixture',$1,$1,'active')",
    [scope],
  );
});
after(async () => {
  if (admin) {
    for (const table of [
      'mission_reviews',
      'mission_result_submissions',
      'mission_budget_reservations',
      'mission_attempts',
      'missions',
      'mission_work_orders',
      'mission_context_manifests',
      'mission_template_versions',
      'artifacts',
    ])
      if ((await admin.query('SELECT to_regclass($1) AS present', ['cos.' + table])).rows[0].present)
        await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
  }
  await runtime?.end();
  await admin?.end();
});
test('S05-T08 result artifacts remain distinct from publishable coordinator answers and support quarantine', async () => {
  const artifact = 'mission-result-' + randomUUID();
  await runtime.query(
    "INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance) VALUES($1,$2,'mission_result',$3,2,'published','{}')",
    [artifact, scope, 'f'.repeat(64)],
  );
  assert.equal(
    (await runtime.query("SELECT id FROM cos.artifacts WHERE scope_id=$1 AND kind IN ('answer','summary')", [scope]))
      .rowCount,
    0,
  );
  await runtime.query("UPDATE cos.artifacts SET lifecycle='quarantined' WHERE scope_id=$1 AND id=$2", [
    scope,
    artifact,
  ]);
  assert.equal(
    (await runtime.query('SELECT lifecycle FROM cos.artifacts WHERE id=$1', [artifact])).rows[0].lifecycle,
    'quarantined',
  );
});
test('S05-T03/T09 runtime cannot rewrite reviewed templates, approved orders, usage or results', async () => {
  for (const table of ['mission_template_versions', ...immutable, ...mutable])
    assert.equal(
      (await admin.query('SELECT to_regclass($1) IS NOT NULL AS present', ['cos.' + table])).rows[0].present,
      true,
    );
  for (const table of immutable) {
    const p = (
      await runtime.query(
        "SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'UPDATE') AS update,has_table_privilege(current_user,$1,'DELETE') AS delete",
        ['cos.' + table],
      )
    ).rows[0];
    assert.equal(p.read, true);
    assert.equal(p.insert, true);
    assert.equal(p.update, false);
    assert.equal(p.delete, false);
    await assert.rejects(runtime.query(`UPDATE cos.${table} SET scope_id=scope_id WHERE scope_id=$1`, [scope]), {
      code: '42501',
    });
  }
  const template = (
    await runtime.query(
      "SELECT has_table_privilege(current_user,'cos.mission_template_versions','SELECT') AS read,has_table_privilege(current_user,'cos.mission_template_versions','INSERT') AS insert,has_table_privilege(current_user,'cos.mission_template_versions','UPDATE') AS update",
    )
  ).rows[0];
  assert.deepEqual(template, { read: true, insert: false, update: false });
});
test('S05-T05/T09 schema binds each attempt, dispatch identity and reservation to one mission generation', async () => {
  await admin.query(
    'INSERT INTO cos.mission_template_versions(scope_id,id,version,body,digest,reviewed_by,provenance) VALUES($1,$2,1,$3,$4,$5,$6)',
    [scope, 'research', '{}', 'a'.repeat(64), 'fixture-operator', '{}'],
  );
  await runtime.query(
    'INSERT INTO cos.mission_context_manifests(scope_id,digest,body,provenance) VALUES($1,$2,$3,$4)',
    [scope, 'b'.repeat(64), '{}', '{}'],
  );
  await runtime.query(
    'INSERT INTO cos.mission_work_orders(scope_id,id,body,digest,context_digest,template_id,template_version,provenance) VALUES($1,$2,$3,$4,$5,$6,1,$7)',
    [scope, 'm1', '{}', 'c'.repeat(64), 'b'.repeat(64), 'research', '{}'],
  );
  await runtime.query("INSERT INTO cos.missions(scope_id,id,state,provenance) VALUES($1,'m1','proposed','{}')", [
    scope,
  ]);
  await runtime.query(
    "INSERT INTO cos.mission_attempts(scope_id,id,mission_id,generation,dispatch_revision,input_id,agent_group_id,session_id,state,provenance) VALUES($1,'a1','m1',1,1,'input1','group1-'||$1,'session1-'||$1,'queued','{}')",
    [scope],
  );
  await assert.rejects(
    runtime.query(
      "INSERT INTO cos.mission_attempts(scope_id,id,mission_id,generation,dispatch_revision,input_id,agent_group_id,session_id,state,provenance) VALUES($1,'a2','m1',1,1,'input2','group2-'||$1,'session2-'||$1,'queued','{}')",
      [scope],
    ),
    { code: '23505' },
  );
  await runtime.query(
    "INSERT INTO cos.mission_budget_reservations(scope_id,mission_id,call_id,attempt_id,generation,kind,payload_digest) VALUES($1,'m1','call1','a1',1,'model',$2)",
    [scope, 'd'.repeat(64)],
  );
  await assert.rejects(
    runtime.query(
      "INSERT INTO cos.mission_budget_reservations(scope_id,mission_id,call_id,attempt_id,generation,kind,payload_digest) VALUES($1,'m1','call2','a1',2,'model',$2)",
      [scope, 'd'.repeat(64)],
    ),
    { code: '23503' },
  );
  await assert.rejects(
    runtime.query(
      "INSERT INTO cos.mission_budget_reservations(scope_id,mission_id,call_id,attempt_id,generation,kind,payload_digest) VALUES($1,'m1','call1','a1',1,'tool',$2)",
      [scope, 'd'.repeat(64)],
    ),
    { code: '23505' },
  );
  await assert.rejects(
    runtime.query("UPDATE cos.missions SET state='invented' WHERE scope_id=$1 AND id='m1'", [scope]),
    { code: '23514' },
  );
});
