import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  connectFixtureDatabase,
  fixtureDatabaseConfig,
  fixtureProfile,
  fixtureRuntimeUser,
} from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { checkpointSchema } from '../../modules/chief-of-staff/ops/checkpoint-schema.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { MailStore } from '../../modules/chief-of-staff/mail/store.js';
import { collectMail } from '../../modules/chief-of-staff/mail/capture.js';
import { normalizeMailMessage } from '../../modules/chief-of-staff/mail/normalization.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../../modules/chief-of-staff/mail/oauth.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from '../../modules/chief-of-staff/mail-drafts/oauth.js';
import { DraftJournal, initializeDraftJournal } from '../../modules/chief-of-staff/mail-drafts/journal.js';
import { googleMailDraftWriter } from '../../modules/chief-of-staff/mail-drafts/google-writer.js';
import { MailDraftStore } from '../../modules/chief-of-staff/mail-drafts/store.js';
import type { MailDraftBinding } from '../../modules/chief-of-staff/mail-drafts/binding.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import type { CosBinding } from '../../cos-boundary.js';
import type { MailDraftHostGrant } from '../../modules/chief-of-staff/mail-drafts/profile.js';
import type { MailDraftAccountConsent } from '../../modules/chief-of-staff/ops/mail-draft-consent.js';
import { writeMailDraftStandingPolicy } from '../../modules/chief-of-staff/ops/mail-draft-policy-store.js';

const scopes: string[] = [],
  roots: string[] = [],
  journals: DraftJournal[] = [];
let admin: pg.Client, database: BoundedDatabase, baseline: string;
async function stateDigest() {
  const state: Record<string, unknown> = {};
  for (const table of checkpointSchema(20).tables) {
    assert.match(table, /^[a-z_]+$/);
    const row = (
      await admin.query(
        `SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(r)::text,E'\\n' ORDER BY to_jsonb(r)::text),'')) AS digest FROM cos."${table}" r`,
      )
    ).rows[0];
    assert(row.count <= 100000, 'fixture_inventory_bound');
    state[table] = row;
  }
  return digest(state);
}
before(async () => {
  assert.equal(fixtureProfile(), 'test', 'G05_runtime_database_fixture_prohibited');
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  assert.equal(await migrate(admin, fixtureRuntimeUser()), 20);
  database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  baseline = await stateDigest();
});
after(async () => {
  try {
    if (admin) {
      // Only unique synthetic scopes allocated by this process. Never clear an existing test/runtime area.
      for (const table of ['mail_draft_writer_revisions', 'mail_draft_writer_bindings', 'mail_messages'])
        await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=ANY($1)', [scopes]);
      await admin.query('UPDATE cos.mail_states SET current_capture=NULL,last_attempt=NULL WHERE scope_id=ANY($1)', [
        scopes,
      ]);
      for (const table of ['mail_captures', 'mail_states', 'mail_bindings'])
        await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=ANY($1)', [scopes]);
      await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=ANY($1)', [scopes]);
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
        await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=ANY($1)', [scopes]);
      await admin.query('DELETE FROM cos.scopes WHERE id=ANY($1)', [scopes]);
      if (baseline) assert.equal(await stateDigest(), baseline, 'existing81_table_records_preserved');
    }
  } finally {
    await database?.pool.end();
    await admin?.end();
    for (const journal of journals) journal.close();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});
function saved(raw: string) {
  const [head, body] = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n');
  const headers = head
    .replace(/\r\n[ \t]+/g, ' ')
    .split('\r\n')
    .map((line) => {
      const index = line.indexOf(':');
      return { name: line.slice(0, index), value: line.slice(index + 1).trim() };
    });
  return {
    id: 'r-fixture',
    message: {
      id: 'dd04',
      threadId: 'bb01',
      labelIds: ['DRAFT'],
      payload: {
        mimeType: 'text/plain',
        headers,
        body: { data: Buffer.from(body, 'base64').toString('base64url'), size: Buffer.from(body, 'base64').length },
      },
    },
  };
}
/** Synthetic metadata only. This exercises the exact trusted SQL transaction, not
 * Google consent, encrypted recovery, host-grant publication or provider access. */
async function ownerPolicyFixture() {
  const scope = 'fixture-draft-policy-' + randomUUID(),
    readerId = randomUUID(),
    writerId = randomUUID(),
    reference = randomUUID();
  scopes.push(scope);
  const binding = {
    scopeId: scope,
    ownerId: 'fixture-owner',
    agentGroupId: scope,
    sessionId: scope,
    messagingGroupId: scope,
    instanceId: 'fixture',
    channelId: scope,
    botId: 'fixture-bot',
    provider: 'codex',
  } as CosBinding;
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,$2,$3,$4,$5,'active')",
    [scope, binding.ownerId, binding.instanceId, binding.channelId, binding.agentGroupId],
  );
  await admin.query(
    "INSERT INTO cos.mail_bindings(scope_id,id,provider,mailbox_email,permission_scopes,credential_ref,processing_providers,auth,provenance) VALUES($1,$2,'google','owner@example.test',$3,$4,ARRAY['codex'],'ready','{}'::jsonb)",
    [scope, readerId, [GOOGLE_MAIL_READ_SCOPE], reference],
  );
  const selection = {
    scopeId: scope,
    readerBindingId: readerId,
    writerBindingId: writerId,
    readerReference: reference,
    writerReference: writerId,
    mailboxDigest: digest('owner@example.test'),
    readerClientDigest: digest('reader-fixture'),
    writerClientDigest: digest('writer-fixture'),
  };
  const consent: MailDraftAccountConsent = {
    format: 'cos-mail-draft-account-consent/v1',
    installationDigest: digest('fixture installation'),
    nativeBindingDigest: digest(binding),
    journalGeneration: randomUUID(),
    requestId: randomUUID(),
    readerConnectionDigest: digest({
      status: 'ok',
      binding: {
        id: readerId,
        provider: 'google',
        mailboxEmail: 'owner@example.test',
        scopes: [GOOGLE_MAIL_READ_SCOPE],
        credentialRef: reference,
        processingProviders: ['codex'],
        auth: 'ready',
        version: 1,
      },
    }),
    selection,
  };
  const grant: MailDraftHostGrant = {
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    agentGroupId: binding.agentGroupId,
    sessionId: binding.sessionId,
    id: writerId,
    version: 1,
    backupOperationId: 'release-action-' + randomUUID(),
    targetBackupDigest: digest('fixture snapshot'),
    writeEnabled: true,
    binding: {
      format: 'cos-mail-draft-binding/v1',
      provider: 'google',
      readerBindingId: readerId,
      mailboxDigest: selection.mailboxDigest,
      readerClientDigest: selection.readerClientDigest,
      writerClientDigest: selection.writerClientDigest,
      credentialReference: writerId,
      nativeBindingDigest: digest(binding),
      journalGeneration: consent.journalGeneration,
      maxPerDay: 5,
      timeZone: 'Australia/Sydney',
      replyMode: 'plain_text_reply',
      permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
      recoveryProofDigest: digest('fixture proof'),
    },
  };
  return { scope, binding, readerId, writerId, grant, consent };
}
test('G05 actual owner policy transaction installs one immutable revision and reconciles identical metadata', async () => {
  const f = await ownerPolicyFixture();
  await writeMailDraftStandingPolicy(admin, f.binding, f.grant, f.consent, async () => {});
  await writeMailDraftStandingPolicy(admin, f.binding, f.grant, f.consent, async () => {});
  const rows = (
    await admin.query(
      'SELECT b.state,r.body,r.digest,r.consent_ref FROM cos.mail_draft_writer_bindings b JOIN cos.mail_draft_writer_revisions r ON r.scope_id=b.scope_id AND r.binding_id=b.id WHERE b.scope_id=$1',
      [f.scope],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'enabled');
  assert.equal(rows[0].digest, digest(f.grant.binding));
  assert.equal(rows[0].consent_ref, digest(f.consent));
  await assert.rejects(
    writeMailDraftStandingPolicy(
      admin,
      f.binding,
      { ...f.grant, binding: { ...f.grant.binding, recoveryProofDigest: digest('changed proof') } },
      f.consent,
      async () => {},
    ),
  );
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mail_draft_writer_revisions WHERE scope_id=$1', [f.scope]))
      .rows[0].n,
    1,
  );
});
test('G05 actual owner policy rollback preserves a failed final authority check without creating policy rows', async () => {
  const f = await ownerPolicyFixture();
  let checks = 0;
  await assert.rejects(
    writeMailDraftStandingPolicy(admin, f.binding, f.grant, f.consent, async () => {
      if (++checks === 2) throw Error('fixture authority lost before commit');
    }),
  );
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mail_draft_writer_bindings WHERE scope_id=$1', [f.scope]))
      .rows[0].n,
    0,
  );
});
test('G05 actual owner policy refuses a changed reader and never enables another scope', async () => {
  const f = await ownerPolicyFixture();
  await admin.query("UPDATE cos.mail_bindings SET auth='revoked' WHERE scope_id=$1", [f.scope]);
  await assert.rejects(writeMailDraftStandingPolicy(admin, f.binding, f.grant, f.consent, async () => {}));
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mail_draft_writer_bindings WHERE scope_id=$1', [f.scope]))
      .rows[0].n,
    0,
  );
});
async function fixture() {
  const scope = 'fixture-draft-' + randomUUID(),
    readerId = randomUUID(),
    writerId = randomUUID(),
    context = {
      scopeId: scope,
      ownerId: 'fixture-owner',
      agentGroupId: scope,
      sessionId: scope,
      ingressId: randomUUID(),
      provider: 'codex',
      generation: randomUUID(),
    };
  scopes.push(scope);
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture',$1,$1,'active')",
    [scope],
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-integration-'));
  roots.push(root);
  for (const name of ['artifacts', 'staging']) fs.mkdirSync(root + '/' + name, { mode: 0o700 });
  const artifacts = new KnowledgeArtifacts(root + '/artifacts', root + '/staging'),
    mail = new MailStore(database, artifacts),
    mailbox = 'owner@example.test',
    now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime() as number;
  assert.equal(
    (
      await mail.bind(context, {
        id: readerId,
        provider: 'fixture',
        mailboxEmail: mailbox,
        scopes: [GOOGLE_MAIL_READ_SCOPE],
        processingProviders: ['codex'],
      })
    ).status,
    'ok',
  );
  const capture = await collectMail({
    mailboxEmail: mailbox,
    capturedAt: now,
    reader: {
      profile: async () => ({ mailboxEmail: mailbox, historyId: '100' }),
      list: async () => ({ messages: [{ id: 'aa01', threadId: 'bb01' }], nextPageToken: null, resultSizeEstimate: 1 }),
      message: async (_id, window) =>
        normalizeMailMessage(
          {
            id: 'aa01',
            threadId: 'bb01',
            historyId: '101',
            internalDate: String(now - 1000),
            labelIds: ['INBOX'],
            payload: {
              mimeType: 'text/plain',
              body: { data: Buffer.from('Harmless fixture alpha request.').toString('base64url') },
            },
          },
          window,
        ),
      history: async () => ({ changedIds: [], deletedIds: [], historyId: '200', nextPageToken: null }),
      thread: async () => ({ messages: [], excluded: 0, unsupported: 0 }),
    },
  });
  const captureId = randomUUID();
  assert.equal((await mail.start(context, readerId, captureId, capture.window)).status, 'ok');
  assert.equal((await mail.publish(context, readerId, captureId, capture)).status, 'ok');
  const knowledge = new KnowledgeStore(database, artifacts, {}, { mailEnabled: () => true, mailAccess: () => true }),
    authority = {
      bindingDigest: digest('fixture native ' + scope),
      contextGeneration: context.generation,
      draftProfileDigest: digest('cos-mail-draft/v1'),
      provider: {
        profile: 'codex-subscription/coordinator-v1',
        model: 'fixture-codex',
        policyDigest: digest('fixture allowance'),
      },
    },
    installation = digest('fixture installation ' + scope),
    owner = initializeDraftJournal(root + '/effects', installation),
    journal = new DraftJournal(root + '/effects', installation, owner.generation);
  journals.push(journal);
  const binding: MailDraftBinding = {
    format: 'cos-mail-draft-binding/v1',
    provider: 'fixture',
    readerBindingId: readerId,
    mailboxDigest: digest(mailbox),
    writerClientDigest: digest('writer-fixture.apps.googleusercontent.com'),
    readerClientDigest: digest('reader-fixture.apps.googleusercontent.com'),
    credentialReference: randomUUID(),
    nativeBindingDigest: authority.bindingDigest,
    journalGeneration: owner.generation,
    maxPerDay: 5,
    timeZone: 'Australia/Sydney',
    replyMode: 'plain_text_reply',
    permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
    recoveryProofDigest: digest('fixture recovery only'),
  };
  await admin.query(
    "INSERT INTO cos.mail_draft_writer_bindings(scope_id,id,reader_binding_id,owner_id,session_id,version,state) VALUES($1,$2,$3,$4,$5,1,'enabled')",
    [scope, writerId, readerId, context.ownerId, context.sessionId],
  );
  await admin.query(
    'INSERT INTO cos.mail_draft_writer_revisions(scope_id,binding_id,version,body,digest,consent_ref) VALUES($1,$2,1,$3,$4,$5)',
    [scope, writerId, JSON.stringify(binding), digest(binding), digest('fixture consent only')],
  );
  let active = true,
    posts = 0,
    draft: ReturnType<typeof saved> | null = null;
  const createStore = () =>
    new MailDraftStore(database, knowledge, {
      journal,
      authority: () => (active ? authority : null),
      matches: (_context, selected) => digest(selected.body) === digest(binding),
      writer: (_context, _selected, current) =>
        googleMailDraftWriter({
          journal,
          admitted: () => active,
          access: async () => {
            assert.equal(await current(), true, 'fixture_current_policy_required');
            return {
              generation: binding.credentialReference,
              scopeId: scope,
              bindingId: writerId,
              contextGeneration: context.generation,
              mailboxEmail: mailbox,
              readerMailboxEmail: mailbox,
              clientId: 'writer-fixture.apps.googleusercontent.com',
              readerClientId: 'reader-fixture.apps.googleusercontent.com',
              auth: 'ready',
              scopes: [GOOGLE_MAIL_DRAFT_SCOPE],
              writeEnabled: true,
            };
          },
          token: async () => {
            assert.equal(await current(), true);
            return 'FIXTURE_TOKEN_NOT_LIVE';
          },
          sourceReader: {
            replySource: async () => ({
              source: {
                id: 'aa01',
                threadId: 'bb01',
                mailboxEmail: mailbox,
                headers: [
                  { name: 'From', value: 'sender@example.test' },
                  { name: 'To', value: mailbox },
                  { name: 'Subject', value: 'Fixture alpha' },
                  { name: 'Message-ID', value: '<fixture-source@example.test>' },
                ],
              },
              internalDate: now - 1000,
              observedAt: Date.now(),
              historyId: '101',
              hasDraft: false,
              alreadyAnswered: false,
            }),
          },
          fetch: async (url, init) => {
            const resource = new URL(url).pathname;
            if (resource.endsWith('/profile')) return new Response(JSON.stringify({ emailAddress: mailbox }));
            if (init.method === 'POST') {
              assert(resource.endsWith('/drafts'));
              posts++;
              const message = JSON.parse(String(init.body)).message;
              assert.equal(message.threadId, 'bb01');
              draft = saved(message.raw);
              return new Response(
                JSON.stringify({ id: draft.id, message: { id: draft.message.id, threadId: draft.message.threadId } }),
              );
            }
            if (resource.endsWith('/drafts'))
              return new Response(
                JSON.stringify({
                  drafts: draft
                    ? [{ id: draft.id, message: { id: draft.message.id, threadId: draft.message.threadId } }]
                    : [],
                }),
              );
            assert(resource.endsWith('/drafts/r-fixture'));
            return draft ? new Response(JSON.stringify(draft)) : new Response('{}', { status: 404 });
          },
        }),
    });
  const input = { writer_binding_id: writerId, source_message_id: 'aa01', reply_text: 'PRIVATE_FIXTURE_REPLY' };
  return {
    scope,
    context,
    input,
    readerId,
    writerId,
    binding,
    journal,
    store: createStore(),
    rebuild: createStore,
    posts: () => posts,
    active: (value: boolean) => {
      active = value;
    },
    edit: () => {
      assert(draft);
      draft.message.payload.body.data = Buffer.from('Owner changed it').toString('base64url');
      draft.message.payload.body.size = Buffer.byteLength('Owner changed it');
    },
  };
}
test('G05 runtime policy reads do not require or grant policy mutation rights', async () => {
  await database.run(async (client) => {
    for (const table of ['mail_draft_writer_bindings', 'mail_draft_writer_revisions']) {
      const privileges = (
        await client.query(
          "SELECT has_table_privilege(current_user,$1,'SELECT') AS readable,has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE') AS writable",
          ['cos.' + table],
        )
      ).rows[0];
      assert.equal(privileges.readable, true);
      assert.equal(privileges.writable, false);
      await client.query('SELECT * FROM cos.' + table + ' WHERE false');
    }
  });
});
test('G05 real writer discovery exposes only current owner-bound identifiers without provider work', async () => {
  const f = await fixture(),
    found = await f.store.bindings(f.context);
  assert.deepEqual(found, {
    status: 'ok',
    items: [
      {
        writer_binding_id: f.writerId,
        reader_binding_id: f.readerId,
        daily_limit: 5,
        time_zone: 'Australia/Sydney',
        reply_mode: 'plain_text_reply',
      },
    ],
  });
  assert(!JSON.stringify(found).includes('credential'));
  assert.equal(f.posts(), 0);
  await admin.query("UPDATE cos.mail_draft_writer_bindings SET state='disabled' WHERE scope_id=$1", [f.scope]);
  assert.deepEqual(await f.store.bindings(f.context), { status: 'ok', items: [] });
  assert.equal(f.posts(), 0);
});
test('G05 real PostgreSQL policies and published read-only source admit one verified draft; retries recheck edits', async () => {
  const f = await fixture(),
    requestId = randomUUID();
  const first = await f.store.create(f.context, requestId, f.input);
  assert.equal(first.status, 'ok');
  assert.equal(first.draft_status, 'verified');
  assert.equal(f.posts(), 1);
  const operation = (
    await admin.query('SELECT * FROM cos.operations WHERE session_id=$1 AND request_id=$2', [
      f.context.sessionId,
      requestId,
    ])
  ).rows[0];
  assert(!JSON.stringify(operation).includes('PRIVATE_FIXTURE_REPLY'));
  f.edit();
  const retry = await f.store.create(f.context, requestId, f.input);
  assert.equal(retry.draft_status, 'edited');
  assert.equal(f.posts(), 1);
  assert.equal((await f.store.status(f.context, { operation_id: String(first.operation_id) })).draft_status, 'edited');
});
test('G05 concurrent retries and an older PostgreSQL request snapshot cannot erase the independent effect reservation', async () => {
  const f = await fixture(),
    requestId = randomUUID();
  const results = await Promise.all(Array.from({ length: 3 }, () => f.store.create(f.context, requestId, f.input)));
  assert(results.every((result) => result.status === 'ok'));
  assert.equal(f.posts(), 1);
  assert.equal(
    (await f.store.create(f.context, requestId, { ...f.input, reply_text: 'Changed text' })).status,
    'conflict',
  );
  // Simulate only this synthetic request being absent from an older restored PG checkpoint. Never restore/clear a database.
  await admin.query('DELETE FROM cos.operations WHERE scope_id=$1 AND session_id=$2 AND request_id=$3', [
    f.scope,
    f.context.sessionId,
    requestId,
  ]);
  const replay = await f.rebuild().create(f.context, requestId, f.input);
  assert.equal(replay.status, 'ok');
  assert.equal(replay.existing, true);
  assert.equal(f.posts(), 1);
  assert.equal(f.journal.findSource(f.binding.mailboxDigest, 'aa01')?.operationId, results[0].operation_id);
});
for (const boundary of [
  'disabled_policy',
  'foreign_owner',
  'expired_source',
  'withdrawn_source',
  'processing_denied',
  'reader_revoked',
  'native_paused',
]) {
  test(`G05 real admission denies ${boundary} without any provider draft write`, async () => {
    const f = await fixture();
    if (boundary === 'disabled_policy')
      await admin.query("UPDATE cos.mail_draft_writer_bindings SET state='disabled' WHERE scope_id=$1", [f.scope]);
    if (boundary === 'foreign_owner') f.context.ownerId = 'foreign-owner';
    if (boundary === 'expired_source')
      await admin.query(
        "UPDATE cos.mail_messages SET internal_date=clock_timestamp()-interval '31 days' WHERE scope_id=$1",
        [f.scope],
      );
    if (boundary === 'withdrawn_source')
      await admin.query("UPDATE cos.sources SET status='revoked' WHERE scope_id=$1", [f.scope]);
    if (boundary === 'processing_denied')
      await admin.query("UPDATE cos.sources SET processing_providers=ARRAY['claude'] WHERE scope_id=$1", [f.scope]);
    if (boundary === 'reader_revoked')
      await admin.query("UPDATE cos.mail_bindings SET auth='revoked' WHERE scope_id=$1", [f.scope]);
    if (boundary === 'native_paused') f.active(false);
    assert.equal((await f.store.create(f.context, randomUUID(), f.input)).status, 'denied');
    assert.equal(f.posts(), 0);
    assert.equal(f.journal.findSource(f.binding.mailboxDigest, 'aa01'), null);
  });
}
