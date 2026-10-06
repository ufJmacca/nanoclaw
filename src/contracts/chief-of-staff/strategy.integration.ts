/** Remote PostgreSQL contracts; fixture scopes and the explicitly selected protected test target only. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { migrate, MIGRATIONS, SCHEMA_VERSION } from '../../modules/chief-of-staff/store/migrations.js';
import { connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';

const immutable = [
  'review_charter_revisions',
  'strategy_observations',
  'strategy_review_snapshots',
  'strategy_review_results',
  'strategy_decisions',
  'strategy_direction_revisions',
];
const heads = ['review_charters', 'strategy_directions'];
let admin: pg.Client, runtime: pg.Client, version: number;
let protectedBefore: Record<string, number>;
async function protectedCounts() {
  const counts: Record<string, number> = {};
  for (const table of ['records', 'work_items', 'missions', 'actions', 'action_writer_bindings'])
    counts[table] = (await admin.query('SELECT count(*)::int AS n FROM cos.' + table)).rows[0].n;
  return counts;
}
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  protectedBefore = await protectedCounts();
  version = await migrate(admin, fixtureRuntimeUser());
  runtime = await connectFixtureDatabase(process.env, 'runtime');
});
after(async () => {
  await runtime?.end();
  await admin?.end();
});

test('S10 monotonic review migrations preserve every predecessor checksum and protected row count', async () => {
  assert.equal(version, SCHEMA_VERSION);
  assert.deepEqual(
    (await admin.query('SELECT version,checksum FROM cos.schema_migrations ORDER BY version')).rows,
    MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })),
  );
  assert.deepEqual(await protectedCounts(), protectedBefore);
  for (const table of [...immutable, ...heads])
    assert.equal(
      (await admin.query('SELECT to_regclass($1) IS NOT NULL AS present', ['cos.' + table])).rows[0].present,
      true,
    );
});
test('S10 reviewed charters, observations, snapshots, reviews and decisions have append-only runtime grants', async () => {
  for (const table of immutable) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      assert.equal(
        (await runtime.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', ['cos.' + table, privilege]))
          .rows[0].allowed,
        ['SELECT', 'INSERT'].includes(privilege),
        `${table} ${privilege}`,
      );
    await assert.rejects(runtime.query(`UPDATE cos.${table} SET scope_id=scope_id WHERE false`), { code: '42501' });
  }
});
test('S10 mutable review/direction heads cannot delete approved history or truncate state', async () => {
  for (const table of heads) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      assert.equal(
        (await runtime.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', ['cos.' + table, privilege]))
          .rows[0].allowed,
        ['SELECT', 'INSERT', 'UPDATE'].includes(privilege),
        `${table} ${privilege}`,
      );
  }
});
test('S10 schema grants cannot enable a real calendar writer', async () => {
  for (const table of ['action_writer_bindings', 'action_writer_revisions'])
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      assert.equal(
        (await runtime.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', ['cos.' + table, privilege]))
          .rows[0].allowed,
        false,
      );
});

/** Synthetic admin seeding is never an owner decision or execution grant. All rows roll back. */
async function schemaFixture(
  operation: (ids: {
    scope: string;
    foreign: string;
    initiative: string;
    otherInitiative: string;
    proposal: string;
    review: string;
    artifact: string;
    output: string;
    foreignArtifact: string;
  }) => Promise<void>,
) {
  const scope = 'strategy-schema-' + randomUUID(),
    foreign = 'foreign-' + randomUUID(),
    initiative = randomUUID(),
    otherInitiative = randomUUID(),
    proposal = randomUUID(),
    review = 'review-' + 'a'.repeat(64),
    artifact = '1'.repeat(64) + '-' + '2'.repeat(64),
    output = '3'.repeat(64) + '-' + '4'.repeat(64),
    foreignArtifact = '5'.repeat(64) + '-' + '6'.repeat(64);
  await admin.query('BEGIN');
  try {
    for (const id of [scope, foreign])
      await admin.query(
        "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture',$1,$1,'active')",
        [id],
      );
    for (const [id, ownerScope] of [
      [initiative, scope],
      [otherInitiative, scope],
      ['foreign-record-' + randomUUID(), foreign],
    ])
      await admin.query(
        "INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance) VALUES($1,$2,'project','Synthetic initiative','','active',1,'{}')",
        [id, ownerScope],
      );
    await admin.query(
      "INSERT INTO cos.proposals(id,scope_id,session_id,ingress_id,owner_id,change,payload_hash,challenge_hash,state,expires_at) VALUES($1,$2,$2,'fixture-ingress','fixture-owner','{}',$3,$3,'approved',clock_timestamp()+interval '1 hour')",
      [proposal, scope, 'b'.repeat(64)],
    );
    await admin.query(
      'INSERT INTO cos.review_charter_revisions(scope_id,version,body,digest,proposal_id) VALUES($1,1,$2,$3,$4)',
      [scope, '{}', 'c'.repeat(64), proposal],
    );
    for (const [id, ownerScope] of [
      [artifact, scope],
      [output, scope],
      [foreignArtifact, foreign],
    ])
      await admin.query(
        "INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance) VALUES($1,$2,'summary',$3,2,'published','{}')",
        [id, ownerScope, 'd'.repeat(64)],
      );
    await operation({
      scope,
      foreign,
      initiative,
      otherInitiative,
      proposal,
      review,
      artifact,
      output,
      foreignArtifact,
    });
  } finally {
    await admin.query('ROLLBACK');
  }
}
async function snapshotRow(
  scope: string,
  review: string,
  artifact: string,
  revision = 1,
  previous: number | null = null,
) {
  return admin.query(
    `INSERT INTO cos.strategy_review_snapshots(scope_id,id,revision,previous_revision,charter_version,owner_id,session_id,processing_provider,artifact_id,snapshot_digest,context,version_refs,as_of,expires_at)
    VALUES($1,$2,$3,$4,1,'fixture-owner',$1,'codex',$5,$6,'{}','{}',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
    [scope, review, revision, previous, artifact, 'e'.repeat(64)],
  );
}
async function rejectedStatement(operation: () => Promise<unknown>, code: string) {
  await admin.query('SAVEPOINT invalid_fixture');
  try {
    await assert.rejects(operation, { code });
  } finally {
    await admin.query('ROLLBACK TO SAVEPOINT invalid_fixture');
    await admin.query('RELEASE SAVEPOINT invalid_fixture');
  }
}
test('S10 later review revisions cannot bypass the first revision with a null predecessor', async () => {
  await schemaFixture(async (ids) => {
    await rejectedStatement(() => snapshotRow(ids.scope, ids.review, ids.artifact, 2, null), '23514');
    await rejectedStatement(() => snapshotRow(ids.scope, ids.review, ids.artifact, 2, 3), '23514');
    await rejectedStatement(() => snapshotRow(ids.scope, ids.review, ids.artifact, 2, 1), '23503');
  });
});
test('S10 review artifacts cannot be borrowed from another privacy scope', async () => {
  await schemaFixture(async (ids) => {
    await rejectedStatement(() => snapshotRow(ids.scope, ids.review, ids.foreignArtifact), '23503');
    await snapshotRow(ids.scope, ids.review, ids.artifact);
    assert.equal(
      (await admin.query('SELECT revision FROM cos.strategy_review_snapshots WHERE scope_id=$1', [ids.scope])).rows[0]
        .revision,
      1,
    );
  });
});
test('S10 one owner decision cannot authorise the direction revision of another initiative', async () => {
  await schemaFixture(async (ids) => {
    await snapshotRow(ids.scope, ids.review, ids.artifact);
    await admin.query(
      'INSERT INTO cos.strategy_review_results(scope_id,review_id,revision,artifact_id,draft_digest,output_digest) VALUES($1,$2,1,$3,$4,$4)',
      [ids.scope, ids.review, ids.output, 'f'.repeat(64)],
    );
    await admin.query(
      "INSERT INTO cos.strategy_decisions(scope_id,proposal_id,review_id,review_revision,initiative_id,option_id,decision,direction,rationale,provenance) VALUES($1,$2,$3,1,$4,'change','approved','change','Fixture decision','{}')",
      [ids.scope, ids.proposal, ids.review, ids.initiative],
    );
    await rejectedStatement(
      () =>
        admin.query(
          'INSERT INTO cos.strategy_direction_revisions(scope_id,initiative_id,version,expected_record_version,proposal_id,body) VALUES($1,$2,1,1,$3,$4)',
          [ids.scope, ids.otherInitiative, ids.proposal, '{}'],
        ),
      '23503',
    );
  });
});
