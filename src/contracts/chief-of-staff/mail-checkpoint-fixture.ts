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
import { GOOGLE_MAIL_DRAFT_SCOPE } from '../../modules/chief-of-staff/mail-drafts/oauth.js';
import { DraftJournal, initializeDraftJournal } from '../../modules/chief-of-staff/mail-drafts/journal.js';

let admin: pg.Client, client: pg.Client, baseline: string;
const scopes: string[] = [],
  roots: string[] = [];
async function existingState() {
  const state: Record<string, unknown> = {};
  for (const table of checkpointSchema(20).tables) {
    assert.match(table, /^[a-z_]+$/);
    state[table] = (
      await admin.query(
        `SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(r)::text,E'\\n' ORDER BY to_jsonb(r)::text),'')) AS digest FROM cos."${table}" r`,
      )
    ).rows[0];
  }
  return digest(state);
}
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  baseline = await existingState();
  client = await connectFixtureDatabase();
  await client.query("SET TIME ZONE 'UTC'");
});
after(async () => {
  try {
    if (admin) {
      for (const table of ['mail_draft_writer_revisions', 'mail_draft_writer_bindings', 'mail_messages'])
        await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=ANY($1)', [scopes]);
      await admin.query('UPDATE cos.mail_states SET current_capture=NULL,last_attempt=NULL WHERE scope_id=ANY($1)', [
        scopes,
      ]);
      for (const table of ['mail_captures', 'mail_states', 'mail_bindings'])
        await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=ANY($1)', [scopes]);
      await admin.query(
        'UPDATE cos.calendar_states SET current_snapshot=NULL,last_attempt=NULL WHERE scope_id=ANY($1)',
        [scopes],
      );
      for (const table of ['calendar_snapshots', 'calendar_states', 'calendar_bindings'])
        await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=ANY($1)', [scopes]);
      await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=ANY($1)', [scopes]);
      for (const table of ['derivation_links', 'evidence_refs', 'chunks', 'source_revisions', 'sources', 'artifacts'])
        await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=ANY($1)', [scopes]);
      await admin.query('DELETE FROM cos.records WHERE scope_id=ANY($1)', [scopes]);
      await admin.query('DELETE FROM cos.scopes WHERE id=ANY($1)', [scopes]);
      if (baseline) assert.equal(await existingState(), baseline, 'existing81_table_records_preserved');
    }
  } finally {
    await client?.end();
    await admin?.end();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});
async function fixture(version: number, danglingRevision = false, drafts = false) {
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
  const draftRoot = root + '/draft-history',
    draftOwner = drafts ? initializeDraftJournal(draftRoot, installationDigest) : null,
    draftNow = Date.now(),
    reservation = {
      scopeId: scope,
      bindingId: randomUUID(),
      contextGeneration: randomUUID(),
      mailboxDigest: digest('owner@example.invalid'),
      sourceMessageId: 'aa01',
      threadId: 'bb01',
      requestId: randomUUID(),
      contentDigest: digest('synthetic saved reply'),
    };
  if (draftOwner) {
    const history = new DraftJournal(draftRoot, installationDigest, draftOwner.generation);
    try {
      for (let index = 1; index <= 5; index++)
        history.reserve({ ...reservation, sourceMessageId: 'aa0' + index, threadId: 'bb0' + index }, draftNow);
    } finally {
      history.close();
    }
  }
  const draftSnapshot = () =>
      draftOwner
        ? ['owner.json', 'effects.sqlite'].map((name) => ({
            name,
            sha256: createHash('sha256')
              .update(fs.readFileSync(draftRoot + '/' + name))
              .digest('hex'),
          }))
        : [],
    beforeDrafts = draftSnapshot();
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
  if (version >= 19) {
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
  if (version === 20) {
    assert(draftOwner);
    const writer = randomUUID(),
      body = {
        format: 'cos-mail-draft-binding/v1',
        provider: 'fixture',
        readerBindingId: rows.mail_bindings[0].id,
        mailboxDigest: reservation.mailboxDigest,
        writerClientDigest: digest('separate synthetic writer'),
        readerClientDigest: digest('synthetic reader'),
        credentialReference: randomUUID(),
        nativeBindingDigest: digest(context),
        journalGeneration: draftOwner.generation,
        maxPerDay: 5,
        timeZone: 'Australia/Sydney',
        replyMode: 'plain_text_reply',
        permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
        recoveryProofDigest: digest('synthetic offline proof'),
      };
    rows.mail_draft_writer_bindings = [
      {
        scope_id: scope,
        id: writer,
        reader_binding_id: rows.mail_bindings[0].id,
        owner_id: context.ownerId,
        session_id: context.sessionId,
        version: 1,
        state: 'enabled',
        created_at: storedAt,
        updated_at: storedAt,
      },
    ];
    rows.mail_draft_writer_revisions = [
      {
        scope_id: scope,
        binding_id: writer,
        version: 1,
        body,
        digest: digest(body),
        consent_ref: digest('synthetic consent'),
        created_at: storedAt,
      },
    ];
  }
  const sourceId = 'source-' + scope,
    revisionId = 'revision-' + scope,
    sourceText =
      version >= 19
        ? (rows.mail_messages[0].message as { text: string }).text
        : 'Synthetic selected source under recovery.',
    sourceArtifact = await artifacts.exclusive(async (lease) => artifacts.publishText(scope, sourceText, lease)),
    calendarBinding = randomUUID(),
    snapshotId = randomUUID(),
    lastAttemptId = randomUUID();
  rows.artifacts = [
    {
      id: sourceArtifact.id,
      scope_id: scope,
      kind: 'source',
      digest: sourceArtifact.digest,
      byte_length: sourceArtifact.byteLength,
      lifecycle: 'published',
      version: 1,
      provenance: { origin: 'synthetic_checkpoint' },
      created_at: storedAt,
      updated_at: storedAt,
    },
  ];
  rows.sources = [
    {
      id: sourceId,
      scope_id: scope,
      source_key: 'fixture:cyclic-source',
      title: 'Synthetic retained source',
      project_id: rows.records[0].id,
      current_revision_id: danglingRevision ? 'missing-revision' : revisionId,
      status: 'current',
      processing_providers: ['codex'],
      access_policy: {},
      version: 1,
      provenance: { origin: 'synthetic_checkpoint' },
      created_at: storedAt,
      updated_at: storedAt,
    },
  ];
  rows.source_revisions = [
    {
      id: revisionId,
      scope_id: scope,
      source_id: sourceId,
      artifact_id: sourceArtifact.id,
      digest: sourceArtifact.digest,
      version: 1,
      supersedes: null,
      locator_format: 'normalized-utf8-lines/v1',
      provenance: { origin: 'synthetic_checkpoint' },
      captured_at: storedAt,
      created_at: storedAt,
      updated_at: storedAt,
    },
  ];
  rows.chunks = [
    {
      scope_id: scope,
      revision_id: revisionId,
      ordinal: 0,
      start_line: 1,
      end_line: 1,
      heading: '',
      text: sourceText,
      created_at: storedAt,
    },
  ];
  rows.evidence_refs = [
    {
      id: 'evidence-' + scope,
      scope_id: scope,
      source_id: sourceId,
      revision_id: revisionId,
      revision_digest: sourceArtifact.digest,
      source_version: 1,
      start_line: 1,
      end_line: 1,
      session_id: context.sessionId,
      context_generation: 'fixture-generation',
      processing_provider: 'codex',
      created_at: storedAt,
    },
  ];
  rows.derivation_links = [
    {
      scope_id: scope,
      artifact_id: sourceArtifact.id,
      evidence_id: rows.evidence_refs[0].id,
      created_at: storedAt,
    },
  ];
  rows.calendar_bindings = [
    {
      scope_id: scope,
      id: calendarBinding,
      provider: 'fixture',
      selected_calendar_ids: ['primary'],
      permission_scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
      credential_ref: null,
      time_zone: 'Australia/Sydney',
      processing_providers: ['codex'],
      auth: 'ready',
      version: 1,
      provenance: { origin: 'synthetic_checkpoint' },
      created_at: storedAt,
      updated_at: storedAt,
    },
  ];
  rows.calendar_states = [
    {
      scope_id: scope,
      binding_id: calendarBinding,
      calendar_id: 'primary',
      current_snapshot: snapshotId,
      last_attempt: lastAttemptId,
      last_attempt_at: storedAt,
      last_success_at: storedAt,
    },
  ];
  rows.calendar_snapshots = [
    { id: snapshotId, status: 'complete', content_digest: digest('synthetic snapshot'), failure_code: null },
    { id: lastAttemptId, status: 'failed', content_digest: null, failure_code: 'fixture_unavailable' },
  ].map((snapshot) => ({
    ...snapshot,
    scope_id: scope,
    binding_id: calendarBinding,
    calendar_id: 'primary',
    binding_version: 1,
    coverage_window: {},
    result: null,
    created_at: storedAt,
    completed_at: storedAt,
  }));
  if (version >= 19) rows.mail_messages[0].source_id = sourceId;
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
    artifacts: [
      publish('artifacts/.cos-artifacts', fs.readFileSync(artifacts.root + '/.cos-artifacts')),
      publish(
        'artifacts/' + sourceArtifact.id + '.blob',
        fs.readFileSync(artifacts.root + '/' + sourceArtifact.id + '.blob'),
      ),
    ],
    restrictions: [],
  };
  publish('manifest.json', Buffer.from(JSON.stringify(receipt) + '\n'));
  return {
    root,
    scope,
    options,
    checkpoint,
    receipt,
    draftHistory: draftOwner
      ? {
          draftRoot,
          installationDigest,
          generation: draftOwner.generation,
          reservation,
          now: draftNow,
          before: beforeDrafts,
          snapshot: draftSnapshot,
        }
      : null,
    quiescent: async () => ({
      generation: 1,
      activeWorkers: 0 as const,
      activeOperations: 0 as const,
      nativeWriters: 0 as const,
      effectsEnabled: false as const,
    }),
  };
}
export function registerMailCheckpointFixtures(slice: 'G04' | 'G05') {
  for (const version of slice === 'G05' ? [19, 20] : [18, 19])
    test(`${slice} schema-${version} synthetic checkpoint restores insert-only into the actual current test database`, async () => {
      const f = await fixture(version, false, slice === 'G05'),
        sandbox = {
          client: slice === 'G05' ? admin : client,
          config: await fixtureDatabaseConfig(process.env, slice === 'G05' ? 'migration' : 'runtime'),
          testTargetId: process.env.COS_TEST_TARGET_ID!,
        };
      if (slice === 'G05') {
        // Match the trusted owner restore controller's explicit TEST migration
        // login. Ordinary runtime retains SELECT-only standing-policy access.
        const rights = await client.query(
          "SELECT has_table_privilege(current_user,'cos.mail_draft_writer_bindings','INSERT') AS bindings,has_table_privilege(current_user,'cos.mail_draft_writer_revisions','INSERT') AS revisions",
        );
        assert.deepEqual(rights.rows[0], { bindings: false, revisions: false });
      }
      const originalRowsDigest = digest(f.checkpoint.rows);
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
      assert.equal(digest(f.checkpoint.rows), originalRowsDigest);
      const pointers = (
        await admin.query('SELECT current_snapshot,last_attempt FROM cos.calendar_states WHERE scope_id=$1', [f.scope])
      ).rows[0];
      assert.equal(pointers.current_snapshot, f.checkpoint.rows.calendar_states[0].current_snapshot);
      assert.equal(pointers.last_attempt, f.checkpoint.rows.calendar_states[0].last_attempt);
      assert.notEqual(pointers.current_snapshot, pointers.last_attempt);
      assert.equal(
        (await admin.query('SELECT current_revision_id FROM cos.sources WHERE scope_id=$1', [f.scope])).rows[0]
          .current_revision_id,
        f.checkpoint.rows.source_revisions[0].id,
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT condeferrable FROM pg_constraint WHERE connamespace='cos'::regnamespace AND conname=ANY($1)",
            [['current_source_revision', 'calendar_current_snapshot', 'calendar_last_attempt']],
          )
        ).rows.map((row) => row.condeferrable),
        [false, false, false],
      );
      assert.equal(
        (await admin.query('SELECT status FROM cos.scopes WHERE id=$1', [f.scope])).rows[0].status,
        'paused',
      );
      assert.equal(
        (await admin.query('SELECT count(*)::int AS n FROM cos.records WHERE scope_id=$1', [f.scope])).rows[0].n,
        1,
      );
      for (const table of ['mail_bindings', 'mail_states', 'mail_captures', 'mail_messages'])
        assert.equal(
          (await admin.query('SELECT count(*)::int AS n FROM cos.' + table + ' WHERE scope_id=$1', [f.scope])).rows[0]
            .n,
          f.checkpoint.rows[table]?.length ?? 0,
        );
      if (version >= 19) {
        const message = (
          await admin.query(
            'SELECT message,selection_id,last_capture,source_id FROM cos.mail_messages WHERE scope_id=$1',
            [f.scope],
          )
        ).rows[0];
        assert.deepEqual(message.message, f.checkpoint.rows.mail_messages[0].message);
        assert.equal(message.selection_id, f.checkpoint.rows.mail_messages[0].selection_id);
        assert.equal(message.last_capture, f.checkpoint.rows.mail_states[0].current_capture);
        assert.equal(message.source_id, f.checkpoint.rows.sources[0].id);
        assert.equal(
          (await admin.query('SELECT history_cursor FROM cos.mail_states WHERE scope_id=$1', [f.scope])).rows[0]
            .history_cursor,
          '200',
        );
      }
      if (version === 20) {
        for (const table of ['mail_draft_writer_bindings', 'mail_draft_writer_revisions']) {
          const actual = (await admin.query('SELECT * FROM cos.' + table + ' WHERE scope_id=$1', [f.scope])).rows;
          assert.equal(actual.length, 1);
          // Native admission and the independent witness are never restored by SQL metadata.
          if (table.endsWith('revisions')) {
            assert.deepEqual(actual[0].body, f.checkpoint.rows[table][0].body);
            assert.equal(actual[0].digest, f.checkpoint.rows[table][0].digest);
            assert.equal(actual[0].consent_ref, f.checkpoint.rows[table][0].consent_ref);
          }
        }
      }
      if (f.draftHistory) {
        const h = f.draftHistory;
        assert.deepEqual(h.snapshot(), h.before);
        const history = new DraftJournal(h.draftRoot, h.installationDigest, h.generation);
        try {
          assert.equal(history.reserve(h.reservation, h.now + 1).created, false);
          assert.throws(
            () => history.reserve({ ...h.reservation, sourceMessageId: 'aa06', threadId: 'bb06' }, h.now + 1),
            /^Error: mail_draft_daily_limit$/,
          );
        } finally {
          history.close();
        }
        assert.deepEqual(h.snapshot(), h.before);
      }
      assert.deepEqual(fs.readFileSync(f.options.witness.root + '/owner.json'), journal);
      const invalid = await fixture(version, true, slice === 'G05');
      await assert.rejects(
        restoreCoordinatedTestScope(invalid.options, invalid.root + '/restore', sandbox, async () => {}),
        /^Error: coordinated_test_restore_unavailable$/,
      );
      for (const table of checkpointSchema(version).tables)
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM cos."' +
                table +
                '" WHERE "' +
                (table === 'scopes' ? 'id' : 'scope_id') +
                '"=$1',
              [invalid.scope],
            )
          ).rows[0].n,
          0,
          table,
        );
    });
}
