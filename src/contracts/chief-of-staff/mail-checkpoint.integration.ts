/** Synthetic predecessor/current checkpoint data; the receiving database is the
 * independently admitted test target. This is no proof of a live backup restore. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { checkpointSchema } from '../../modules/chief-of-staff/ops/checkpoint-schema.js';
import {
  restoreCoordinatedSandbox,
  restoreCoordinatedTestScope,
  verifyCoordinatedSandbox,
  type CoordinatedBackupIdentity,
  type CoordinatedBackupReceipt,
  type ScopeCheckpoint,
} from '../../modules/chief-of-staff/ops/coordinated-backup.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { ActionWitness, initializeActionWitness } from '../../modules/chief-of-staff/actions/witness.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';

let admin: pg.Client, client: pg.Client;
const scopes: string[] = [],
  roots: string[] = [];
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  client = await connectFixtureDatabase();
  await client.query("SET TIME ZONE 'UTC'");
});
after(async () => {
  try {
    if (admin) {
      await admin.query('DELETE FROM cos.records WHERE scope_id=ANY($1)', [scopes]);
      await admin.query('DELETE FROM cos.scopes WHERE id=ANY($1)', [scopes]);
    }
  } finally {
    await client?.end();
    await admin?.end();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});
async function fixture(version: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mail-checkpoint-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  for (const name of ['receipt', 'artifacts', 'staging', 'restore']) fs.mkdirSync(root + '/' + name, { mode: 0o700 });
  const archive = root + '/receipt/coordinated';
  fs.mkdirSync(archive, { mode: 0o700 });
  for (const name of ['sqlite', 'sqlite/0', 'artifacts', 'restrictions'])
    fs.mkdirSync(archive + '/' + name, { mode: 0o700 });
  const native = root + '/native.sqlite',
    db = new Database(native);
  db.exec("CREATE TABLE messages(id,body); INSERT INTO messages VALUES('fixture','preserved')");
  db.close();
  fs.chmodSync(native, 0o600);
  const scope = 'fixture-checkpoint-' + randomUUID();
  scopes.push(scope);
  const context = {
    scopeId: scope,
    ownerId: 'fixture-owner',
    agentGroupId: scope,
    sessionId: scope,
    ingressId: randomUUID(),
  };
  const artifacts = new KnowledgeArtifacts(root + '/artifacts', root + '/staging'),
    installationDigest = digest({ fixture: scope }),
    owner = initializeActionWitness(root + '/effects', installationDigest);
  const witness = new ActionWitness(root + '/effects', installationDigest, owner.generation);
  const options: CoordinatedBackupIdentity = {
    context,
    databaseFingerprint: digest('synthetic source identity, not a live database'),
    operationId: randomUUID(),
    receiptRoot: root + '/receipt',
    nativeDatabases: [native],
    artifacts,
    restrictionFiles: [],
    witness,
  };
  const schema = checkpointSchema(version),
    columns: ScopeCheckpoint['columns'] = {},
    rows: ScopeCheckpoint['rows'] = {};
  for (const table of schema.tables) {
    columns[table] = (
      await admin.query(
        "SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum",
        ['cos.' + table],
      )
    ).rows.map((row) => row.attname);
    rows[table] = [];
  }
  const at = new Date().toISOString();
  const storedAt = (await client.query('SELECT to_jsonb($1::timestamptz) AS value', [at])).rows[0].value;
  rows.scopes = [
    {
      id: scope,
      owner_id: context.ownerId,
      instance_id: 'synthetic-recovery',
      channel_id: scope,
      agent_group_id: scope,
      status: 'paused',
      version: 1,
      created_at: storedAt,
      updated_at: storedAt,
    },
  ];
  rows.records = [
    {
      id: 'record-' + scope,
      scope_id: scope,
      kind: 'project',
      title: 'Synthetic retained project',
      description: 'Fixture only',
      lifecycle: 'active',
      version: 1,
      provenance: { kind: 'fixture' },
      created_at: storedAt,
      updated_at: storedAt,
    },
  ];
  const checkpoint: ScopeCheckpoint = {
    format: 'cos-scoped-checkpoint/v1',
    scopeId: scope,
    schemaVersion: version,
    schemaDigest: schema.digest,
    databaseFingerprint: options.databaseFingerprint,
    at,
    columns,
    rows,
  };
  const publish = (file: string, bytes: Buffer) => {
    fs.writeFileSync(archive + '/' + file, bytes, { mode: 0o600 });
    return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const receipt: CoordinatedBackupReceipt = {
    format: 'cos-coordinated-backup/v1',
    operationId: options.operationId,
    contextDigest: digest(context),
    inputsDigest: digest({
      nativeDatabases: options.nativeDatabases,
      artifactsRoot: artifacts.root,
      restrictionFiles: [],
    }),
    databaseFingerprint: options.databaseFingerprint,
    schemaVersion: version,
    schemaDigest: schema.digest,
    barrierDigest: digest({
      generation: 1,
      activeWorkers: 0,
      activeOperations: 0,
      nativeWriters: 0,
      effectsEnabled: false,
    }),
    admissionRestored: false,
    journal: { installationDigest, generation: owner.generation },
    remote: publish('remote.json', Buffer.from(JSON.stringify(checkpoint) + '\n')),
    sqlite: [publish('sqlite/0/native.sqlite', fs.readFileSync(native))],
    artifacts: [publish('artifacts/.cos-artifacts', fs.readFileSync(artifacts.root + '/.cos-artifacts'))],
    restrictions: [],
  };
  publish('manifest.json', Buffer.from(JSON.stringify(receipt) + '\n'));
  return {
    root,
    scope,
    options,
    checkpoint,
    receipt,
    quiescent: async () => ({
      generation: 1,
      activeWorkers: 0 as const,
      activeOperations: 0 as const,
      nativeWriters: 0 as const,
      effectsEnabled: false as const,
    }),
  };
}
for (const version of [18, 19])
  test(`G04 schema-${version} synthetic checkpoint restores insert-only into the actual current test database`, async () => {
    const f = await fixture(version),
      sandbox = { client, config: await fixtureDatabaseConfig(), testTargetId: process.env.COS_TEST_TARGET_ID! };
    const journal = fs.readFileSync(f.options.witness.root + '/owner.json');
    await restoreCoordinatedSandbox({ ...f.options, quiescent: f.quiescent }, f.root + '/sandbox');
    const first = await restoreCoordinatedTestScope(f.options, f.root + '/restore', sandbox, async () => {});
    assert.equal(first.inserted, true);
    assert.equal(first.admissionRestored, false);
    assert.equal(first.eventJournalRestored, false);
    assert.equal(
      (await restoreCoordinatedTestScope(f.options, f.root + '/restore', sandbox, async () => {})).inserted,
      false,
    );
    const proof = await verifyCoordinatedSandbox(f.options, f.root + '/sandbox', sandbox);
    assert.equal(proof.schemaVersion, version);
    assert.equal(proof.schemaDigest, f.receipt.schemaDigest);
    assert.equal(proof.restoredStateDigest, first.restoredStateDigest);
    assert.equal((await admin.query('SELECT status FROM cos.scopes WHERE id=$1', [f.scope])).rows[0].status, 'paused');
    assert.equal(
      (await admin.query('SELECT count(*)::int AS n FROM cos.records WHERE scope_id=$1', [f.scope])).rows[0].n,
      1,
    );
    for (const table of ['mail_bindings', 'mail_states', 'mail_captures', 'mail_messages'])
      assert.equal(
        (await admin.query('SELECT count(*)::int AS n FROM cos.' + table + ' WHERE scope_id=$1', [f.scope])).rows[0].n,
        0,
      );
    assert.deepEqual(fs.readFileSync(f.options.witness.root + '/owner.json'), journal);
  });
