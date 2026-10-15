import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate, SCHEMA_VERSION } from '../../modules/chief-of-staff/store/migrations.js';
import { CHECKPOINT_TABLES } from '../../modules/chief-of-staff/ops/coordinated-backup.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { MailStore } from '../../modules/chief-of-staff/mail/store.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../../modules/chief-of-staff/mail/oauth.js';
import { collectMail } from '../../modules/chief-of-staff/mail/capture.js';
import { normalizeMailMessage, type MailWindow } from '../../modules/chief-of-staff/mail/normalization.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
const scopes: string[] = [],
  roots: string[] = [];
let admin: pg.Client, database: BoundedDatabase;
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
});
after(async () => {
  if (admin) {
    const exists = async (table: string) =>
      (await admin.query('SELECT to_regclass($1) IS NOT NULL AS present', ['cos.' + table])).rows[0].present;
    if (await exists('mail_messages'))
      await admin.query('DELETE FROM cos.mail_messages WHERE scope_id=ANY($1)', [scopes]);
    if (await exists('mail_states'))
      await admin.query('UPDATE cos.mail_states SET current_capture=NULL,last_attempt=NULL WHERE scope_id=ANY($1)', [
        scopes,
      ]);
    for (const t of ['mail_captures', 'mail_states', 'mail_bindings'])
      if (await exists(t)) await admin.query('DELETE FROM cos.' + t + ' WHERE scope_id=ANY($1)', [scopes]);
    await admin.query('DELETE FROM cos.calendar_bindings WHERE scope_id=ANY($1)', [scopes]);
    await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=ANY($1)', [scopes]);
    for (const t of [
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
      await admin.query('DELETE FROM cos.' + t + ' WHERE scope_id=ANY($1)', [scopes]);
    await admin.query('DELETE FROM cos.scopes WHERE id=ANY($1)', [scopes]);
    await admin.end();
  }
  await database?.pool.end();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(hooks: ConstructorParameters<typeof MailStore>[2] = {}) {
  const scope = 'fixture-mail-' + randomUUID();
  scopes.push(scope);
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture-instance',$1,$1,'active')",
    [scope],
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mail-store-'));
  roots.push(root);
  for (const name of ['artifacts', 'staging']) fs.mkdirSync(root + '/' + name, { mode: 0o700 });
  const artifacts = new KnowledgeArtifacts(root + '/artifacts', root + '/staging'),
    store = new MailStore(database, artifacts, hooks);
  const context = {
    scopeId: scope,
    ownerId: 'fixture-owner',
    agentGroupId: scope,
    sessionId: scope,
    ingressId: randomUUID(),
    provider: 'codex',
  };
  const binding = {
    id: randomUUID(),
    provider: 'fixture' as const,
    mailboxEmail: 'owner@example.invalid',
    scopes: [GOOGLE_MAIL_READ_SCOPE],
    processingProviders: ['codex'],
  };
  return { scope, root, artifacts, store, context, binding };
}
async function capture(capturedAt = Date.now()) {
  const raw = {
    id: 'aa01',
    threadId: 'bb01',
    historyId: '101',
    internalDate: String(capturedAt - 1000),
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      body: { data: Buffer.from('Fixture mail asks about project alpha.').toString('base64url') },
    },
  };
  return collectMail({
    mailboxEmail: 'owner@example.invalid',
    capturedAt,
    reader: {
      profile: async () => ({ mailboxEmail: 'owner@example.invalid', historyId: '100' }),
      list: async () => ({ messages: [{ id: 'aa01', threadId: 'bb01' }], nextPageToken: null, resultSizeEstimate: 1 }),
      message: async (_id: string, window: MailWindow) => normalizeMailMessage(raw, window),
      history: async () => ({ changedIds: [], deletedIds: [], historyId: '200', nextPageToken: null }),
      thread: async () => ({ messages: [], excluded: 0, unsupported: 0 }),
    },
  });
}
test('G04 mailbox schema is additive, constrained and included in coordinated checkpoints', async () => {
  assert.equal(SCHEMA_VERSION, 19);
  for (const table of ['mail_bindings', 'mail_states', 'mail_captures', 'mail_messages'])
    assert(CHECKPOINT_TABLES.includes(table));
  const f = await fixture();
  assert.equal((await f.store.bind(f.context, f.binding)).status, 'ok');
  await assert.rejects(
    admin.query(
      "INSERT INTO cos.mail_bindings(scope_id,id,provider,mailbox_email,permission_scopes,processing_providers,auth,provenance) VALUES($1,$2,'fixture','bad@example.invalid',ARRAY['https://www.googleapis.com/auth/gmail.modify'],ARRAY['codex'],'ready','{}')",
      [f.scope, randomUUID()],
    ),
    { code: '23514' },
  );
});
test('G04 binding replay preserves identity and refuses broader grants and foreign owners', async () => {
  const f = await fixture();
  const first = await f.store.bind(f.context, f.binding);
  assert.equal(first.status, 'ok');
  assert.deepEqual(await f.store.bind(f.context, f.binding), first);
  assert.equal(
    (await f.store.bind(f.context, { ...f.binding, mailboxEmail: 'different@example.invalid' })).status,
    'conflict',
  );
  assert.equal(
    (
      await f.store.bind(f.context, {
        ...f.binding,
        id: randomUUID(),
        scopes: ['https://www.googleapis.com/auth/gmail.compose'],
      })
    ).status,
    'denied',
  );
  assert.equal((await f.store.connection({ ...f.context, ownerId: 'foreign-owner' }, f.binding.id)).status, 'denied');
});
test('G04 publishes messages and their history cursor atomically, then reconciles the same capture once', async () => {
  const f = await fixture();
  assert.equal((await f.store.bind(f.context, f.binding)).status, 'ok');
  const prepared = await capture(),
    id = randomUUID();
  assert.equal((await f.store.start(f.context, f.binding.id, id, prepared.window)).status, 'ok');
  const result = await f.store.publish(f.context, f.binding.id, id, prepared);
  assert.equal(result.status, 'ok');
  assert.deepEqual(await f.store.publish(f.context, f.binding.id, id, prepared), result);
  const state = (
    await admin.query(
      'SELECT history_cursor,current_capture FROM cos.mail_states WHERE scope_id=$1 AND binding_id=$2',
      [f.scope, f.binding.id],
    )
  ).rows[0];
  assert.equal(state.history_cursor, '200');
  assert.equal(state.current_capture, id);
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0].n,
    1,
  );
});
test('G04 failed reads and superseded captures cannot advance the saved cursor or replace newer state', async () => {
  const f = await fixture();
  assert.equal((await f.store.bind(f.context, f.binding)).status, 'ok');
  const prepared = await capture(),
    first = randomUUID(),
    later = randomUUID();
  await f.store.start(f.context, f.binding.id, first, prepared.window);
  await f.store.start(f.context, f.binding.id, later, prepared.window);
  assert.equal((await f.store.publish(f.context, f.binding.id, first, prepared)).status, 'conflict');
  assert.equal((await f.store.fail(f.context, f.binding.id, later, 'mail_unavailable')).status, 'ok');
  const state = (
    await admin.query('SELECT history_cursor,current_capture FROM cos.mail_states WHERE scope_id=$1', [f.scope])
  ).rows[0];
  assert.equal(state.history_cursor, null);
  assert.equal(state.current_capture, null);
});
test('G04 losing the publish response reconciles the committed receipt without duplicate messages or cursor changes', async () => {
  let lose = true;
  const f = await fixture({
    afterPublishCommit: async () => {
      if (lose) {
        lose = false;
        throw Error('FIXTURE_LOST_RESPONSE');
      }
    },
  });
  assert.equal((await f.store.bind(f.context, f.binding)).status, 'ok');
  const prepared = await capture(),
    id = randomUUID();
  await f.store.start(f.context, f.binding.id, id, prepared.window);
  assert.equal((await f.store.publish(f.context, f.binding.id, id, prepared)).status, 'pending');
  await database.pool.end();
  database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  const rebuilt = new MailStore(database, f.artifacts);
  assert.equal((await rebuilt.publish(f.context, f.binding.id, id, prepared)).status, 'ok');
  assert.equal((await rebuilt.fail(f.context, f.binding.id, id, 'mail_unavailable')).status, 'conflict');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0].n,
    1,
  );
});
test('G04 capture publication refuses a wrong mailbox, modified content, changed binding and a later pause', async () => {
  const f = await fixture();
  assert.equal((await f.store.bind(f.context, f.binding)).status, 'ok');
  const prepared = await capture(),
    id = randomUUID();
  await f.store.start(f.context, f.binding.id, id, prepared.window);
  const wrong = { ...prepared, mailboxEmail: 'other@example.invalid' };
  const { digest: _old, ...content } = wrong;
  wrong.digest = digest(content);
  assert.equal((await f.store.publish(f.context, f.binding.id, id, wrong)).status, 'denied');
  const changed = structuredClone(prepared);
  changed.messages[0].text = 'MODIFIED_FIXTURE_TEXT';
  assert.equal((await f.store.publish(f.context, f.binding.id, id, changed)).status, 'denied');
  await admin.query('UPDATE cos.mail_bindings SET version=version+1 WHERE scope_id=$1 AND id=$2', [
    f.scope,
    f.binding.id,
  ]);
  assert.equal((await f.store.publish(f.context, f.binding.id, id, prepared)).status, 'conflict');
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [f.scope]);
  assert.equal((await f.store.publish(f.context, f.binding.id, id, prepared)).status, 'denied');
  assert.equal(
    (await admin.query('SELECT history_cursor FROM cos.mail_states WHERE scope_id=$1', [f.scope])).rows[0]
      .history_cursor,
    null,
  );
});
test('G04 reconstructs only the current capture and preserves the original selection identity across incremental publication', async () => {
  const f = await fixture();
  assert.equal((await f.store.bind(f.context, f.binding)).status, 'ok');
  const prepared = await capture(),
    first = randomUUID();
  await f.store.start(f.context, f.binding.id, first, prepared.window);
  assert.equal((await f.store.publish(f.context, f.binding.id, first, prepared)).status, 'ok');
  const second = await capture(Date.now()),
    id = randomUUID();
  const started = await f.store.start(f.context, f.binding.id, id, second.window);
  assert.equal(started.status, 'ok');
  assert.deepEqual(started.previous, prepared);
  assert.equal((await f.store.publish(f.context, f.binding.id, id, second)).status, 'ok');
  const row = (
    await admin.query('SELECT last_capture,selection_id FROM cos.mail_messages WHERE scope_id=$1', [f.scope])
  ).rows[0];
  assert.equal(row.last_capture, id);
  assert.equal(row.selection_id, first);
  const coverage = await f.store.coverage(f.context);
  assert.equal(coverage.status, 'ok');
  assert.equal(JSON.stringify(coverage).includes('Fixture mail asks'), false);
});
/** Independent source fixture exercises disclosure guards before the mail publisher is added. */
async function readableMailFixture() {
  const f = await fixture();
  await f.store.bind(f.context, f.binding);
  const prepared = await capture(),
    id = randomUUID();
  await f.store.start(f.context, f.binding.id, id, prepared.window);
  await f.store.publish(f.context, f.binding.id, id, prepared);
  const text = prepared.messages[0].text,
    blob = await f.artifacts.exclusive(async (lease) => f.artifacts.publishText(f.scope, text, lease)),
    source = randomUUID(),
    revision = randomUUID();
  const policy = {
    scope_owner_only: true,
    mail_binding_id: f.binding.id,
    mailbox_email: f.binding.mailboxEmail,
    provider_message_id: 'aa01',
    provider_thread_id: 'bb01',
    selection_id: id,
  };
  await admin.query(
    "INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance) VALUES($1,$2,'source',$3,$4,'published','{}')",
    [blob.id, f.scope, blob.digest, blob.byteLength],
  );
  await admin.query(
    "INSERT INTO cos.sources(id,scope_id,source_key,title,status,processing_providers,access_policy,provenance) VALUES($1,$2,$1,'Mail fixture','current',ARRAY['codex'],$3,$4)",
    [source, f.scope, JSON.stringify(policy), JSON.stringify({ origin: 'mail_message' })],
  );
  await admin.query(
    "INSERT INTO cos.source_revisions(id,scope_id,source_id,artifact_id,digest,version,locator_format,provenance) VALUES($1,$2,$3,$4,$5,1,'normalized-utf8-lines/v1','{}')",
    [revision, f.scope, source, blob.id, blob.digest],
  );
  await admin.query('UPDATE cos.sources SET current_revision_id=$3 WHERE scope_id=$1 AND id=$2', [
    f.scope,
    source,
    revision,
  ]);
  await admin.query(
    "INSERT INTO cos.chunks(scope_id,revision_id,ordinal,start_line,end_line,heading,text) VALUES($1,$2,0,1,1,'',$3)",
    [f.scope, revision, text],
  );
  await admin.query('UPDATE cos.mail_messages SET source_id=$2 WHERE scope_id=$1', [f.scope, source]);
  const context = { ...f.context, generation: randomUUID() };
  return { ...f, id, source, revision, policy, context };
}
test('G04 mail evidence is closed by default and by a Calendar-only grant, and opens only under its own host authority', async () => {
  const f = await readableMailFixture();
  // A same-UUID Calendar grant must not cross the profile boundary.
  await admin.query(
    "INSERT INTO cos.calendar_bindings(scope_id,id,provider,selected_calendar_ids,permission_scopes,time_zone,processing_providers,auth,provenance) VALUES($1,$2,'fixture',ARRAY['primary'],ARRAY['https://www.googleapis.com/auth/calendar.events.readonly'],'Australia/Sydney',ARRAY['codex'],'ready','{}')",
    [f.scope, f.binding.id],
  );
  for (const options of [
    {},
    { calendarEnabled: () => true, calendarAccess: () => true },
    { mailEnabled: () => true, mailAccess: () => false },
  ]) {
    const knowledge = new KnowledgeStore(database, f.artifacts, {}, options);
    const result = await knowledge.search(f.context, { query: 'alpha' });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.items, []);
  }
  const knowledge = new KnowledgeStore(
    database,
    f.artifacts,
    {},
    { mailEnabled: () => true, mailAccess: (scope, binding) => scope === f.scope && binding === f.binding.id },
  );
  const result = await knowledge.search(f.context, { query: 'alpha' });
  assert.equal(result.status, 'ok');
  assert.equal((result.items as unknown[]).length, 1);
});
test('G04 the rolling wall-clock retention boundary closes cached evidence and its existing context during a provider outage', async () => {
  const f = await readableMailFixture(),
    knowledge = new KnowledgeStore(database, f.artifacts, {}, { mailEnabled: () => true, mailAccess: () => true });
  assert.equal((await knowledge.search(f.context, { query: 'alpha' })).status, 'ok');
  assert.equal((await knowledge.contextReady(f.context)).status, 'ok');
  await admin.query(
    "UPDATE cos.mail_messages SET internal_date=clock_timestamp()-interval '30 days 1 second' WHERE scope_id=$1",
    [f.scope],
  );
  assert.equal((await knowledge.contextReady(f.context)).status, 'denied');
  assert.equal((await knowledge.get(f.context, f.source, f.revision, 0)).status, 'denied');
  const fresh = { ...f.context, generation: randomUUID() };
  const result = await knowledge.search(fresh, { query: 'alpha' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items, []);
});
for (const boundary of ['account', 'selection', 'message', 'auth', 'capture', 'late-host-denial'])
  test(`G04 mail disclosure rejects changed ${boundary} authority`, async () => {
    const f = await readableMailFixture();
    let open = true;
    const knowledge = new KnowledgeStore(
      database,
      f.artifacts,
      boundary === 'late-host-denial'
        ? {
            beforeDisclosure: async () => {
              open = false;
            },
          }
        : {},
      { mailEnabled: () => true, mailAccess: () => open },
    );
    if (boundary === 'account')
      await admin.query(
        "UPDATE cos.sources SET access_policy=jsonb_set(access_policy,'{mailbox_email}','\"other@example.invalid\"') WHERE scope_id=$1",
        [f.scope],
      );
    if (boundary === 'selection')
      await admin.query(
        "UPDATE cos.sources SET access_policy=jsonb_set(access_policy,'{selection_id}',to_jsonb($2::text)) WHERE scope_id=$1",
        [f.scope, randomUUID()],
      );
    if (boundary === 'message')
      await admin.query(
        "UPDATE cos.sources SET access_policy=jsonb_set(access_policy,'{provider_message_id}','\"ff01\"') WHERE scope_id=$1",
        [f.scope],
      );
    if (boundary === 'auth')
      await admin.query("UPDATE cos.mail_bindings SET auth='revoked' WHERE scope_id=$1", [f.scope]);
    if (boundary === 'capture')
      await admin.query('UPDATE cos.mail_states SET current_capture=NULL WHERE scope_id=$1', [f.scope]);
    const result = await knowledge.search(f.context, { query: 'alpha' });
    if (boundary === 'late-host-denial') assert.equal(result.status, 'denied');
    else {
      assert.equal(result.status, 'ok');
      assert.deepEqual(result.items, []);
    }
  });
