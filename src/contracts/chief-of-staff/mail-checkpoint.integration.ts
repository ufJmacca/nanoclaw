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
import { normalizeMailMessage, MAIL_RETENTION_MS } from '../../modules/chief-of-staff/mail/normalization.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../../modules/chief-of-staff/mail/oauth.js';

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
      await admin.query('DELETE FROM cos.mail_messages WHERE scope_id=ANY($1)', [scopes]);
      await admin.query('UPDATE cos.mail_states SET current_capture=NULL,last_attempt=NULL WHERE scope_id=ANY($1)', [
        scopes,
      ]);
      for (const table of ['mail_captures', 'mail_states', 'mail_bindings'])
        await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=ANY($1)', [scopes]);
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
  if (version === 19) {
    const binding = randomUUID(),
      captureId = randomUUID(),
      anchor = randomUUID(),
      capturedAt = Date.now(),
      internalDate = capturedAt - 1000;
    const normalized = normalizeMailMessage(
      {
        id: 'aa01',
        threadId: 'bb01',
        historyId: '101',
        internalDate: String(internalDate),
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Synthetic mail body survives checked restoration.').toString('base64url') },
        },
      },
      { capturedAt, since: capturedAt - MAIL_RETENTION_MS },
    );
    assert.equal(normalized.status, 'selected');
    if (normalized.status !== 'selected') throw Error('synthetic_mail_required');
    const message = normalized.message,
      window = { capturedAt, since: capturedAt - MAIL_RETENTION_MS };
    const content = {
      contract: 'cos-mail-capture/v1',
      mode: 'full',
      mailboxEmail: 'owner@example.invalid',
      historyId: '200',
      window,
      lastFullSyncAt: capturedAt,
      messages: [message],
      deferred: [],
      unsupported: [],
      limitations: [],
      complete: true,
      textBytes: Buffer.byteLength(message.text),
      removedIds: [],
    };
    const capture = { ...content, digest: digest(content) },
      { messages: _messages, ...metadata } = capture;
    const anchorMetadata = {
      contract: 'cos-mail-selection-anchor/v1',
      binding_id: binding,
      selection_id: anchor,
      provider_message_id: message.id,
      first_capture_id: captureId,
      first_capture_digest: capture.digest,
    };
    rows.mail_bindings = [
      {
        scope_id: scope,
        id: binding,
        provider: 'fixture',
        mailbox_email: content.mailboxEmail,
        permission_scopes: [GOOGLE_MAIL_READ_SCOPE],
        credential_ref: null,
        processing_providers: ['codex'],
        auth: 'ready',
        version: 1,
        provenance: { origin: 'synthetic_checkpoint' },
        created_at: storedAt,
        updated_at: storedAt,
      },
    ];
    rows.mail_states = [
      {
        scope_id: scope,
        binding_id: binding,
        current_capture: captureId,
        last_attempt: captureId,
        history_cursor: '200',
        last_attempt_at: storedAt,
        last_success_at: storedAt,
        next_poll_at: storedAt,
      },
    ];
    const base = {
      scope_id: scope,
      binding_id: binding,
      binding_version: 1,
      base_capture: null,
      status: 'complete',
      capture_window: window,
      failure_code: null,
      created_at: storedAt,
      completed_at: storedAt,
    };
    rows.mail_captures = [
      {
        ...base,
        id: anchor,
        content_digest: digest(anchorMetadata),
        metadata: anchorMetadata,
        result: { status: 'ok', selection_anchor: true },
      },
      {
        ...base,
        id: captureId,
        content_digest: capture.digest,
        metadata: { ...metadata, messageIds: [message.id] },
        result: {
          status: 'ok',
          capture_id: captureId,
          message_count: 1,
          complete: true,
          limitations: [],
          history_cursor: '200',
        },
      },
    ];
    const storedInternalDate = (
      await client.query('SELECT to_jsonb($1::timestamptz) AS value', [new Date(internalDate).toISOString()])
    ).rows[0].value;
    rows.mail_messages = [
      {
        scope_id: scope,
        binding_id: binding,
        provider_message_id: message.id,
        provider_thread_id: message.threadId,
        message,
        content_digest: message.digest,
        internal_date: storedInternalDate,
        source_id: null,
        selection_id: anchor,
        last_capture: captureId,
        created_at: storedAt,
        updated_at: storedAt,
      },
    ];
  }
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
        f.checkpoint.rows[table]?.length ?? 0,
      );
    if (version === 19) {
      const message = (
        await admin.query('SELECT message,selection_id,last_capture FROM cos.mail_messages WHERE scope_id=$1', [
          f.scope,
        ])
      ).rows[0];
      assert.deepEqual(message.message, f.checkpoint.rows.mail_messages[0].message);
      assert.equal(message.selection_id, f.checkpoint.rows.mail_messages[0].selection_id);
      assert.equal(message.last_capture, f.checkpoint.rows.mail_states[0].current_capture);
      assert.equal(
        (await admin.query('SELECT history_cursor FROM cos.mail_states WHERE scope_id=$1', [f.scope])).rows[0]
          .history_cursor,
        '200',
      );
    }
    assert.deepEqual(fs.readFileSync(f.options.witness.root + '/owner.json'), journal);
  });
