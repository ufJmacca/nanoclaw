import { createFixtureDatabase } from './fixture-database-readiness.js';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate, SCHEMA_VERSION } from '../../modules/chief-of-staff/store/migrations.js';
import { MAIL_CHECKSUM } from '../../modules/chief-of-staff/store/mail-schema.js';
import { checkpointSchema } from '../../modules/chief-of-staff/ops/checkpoint-schema.js';
import { CHECKPOINT_TABLES } from '../../modules/chief-of-staff/ops/coordinated-backup.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { MailStore } from '../../modules/chief-of-staff/mail/store.js';
import { OwnerMailStore } from '../../modules/chief-of-staff/ops/owner-mail-store.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../../modules/chief-of-staff/mail/oauth.js';
import { collectMail } from '../../modules/chief-of-staff/mail/capture.js';
import { normalizeMailMessage, type MailWindow } from '../../modules/chief-of-staff/mail/normalization.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { MailView } from '../../modules/chief-of-staff/mail/view.js';
import { MailConnector } from '../../modules/chief-of-staff/mail/connector.js';
import { CalendarAccessFences } from '../../modules/chief-of-staff/calendar/access-fences.js';
import { MailReadError } from '../../modules/chief-of-staff/mail/reader.js';
import { MailPump } from '../../modules/chief-of-staff/mail/pump.js';
import { MailHost } from '../../modules/chief-of-staff/mail/host.js';
import { MailMaintenance } from '../../modules/chief-of-staff/mail/maintenance.js';
import { setTimeout as delay } from 'node:timers/promises';
import { checkMailContext, mailAnswerNotice } from '../../modules/chief-of-staff/mail/answer-notice.js';
import type { MailReviewReadScope } from '../../modules/chief-of-staff/automation/mail-review-access.js';
import { loadMailReviewRecords } from '../../modules/chief-of-staff/automation/mail-review-records.js';
import { MailReviewAccess } from '../../modules/chief-of-staff/automation/mail-review-access.js';
import { MailReviewPreparer } from '../../modules/chief-of-staff/automation/mail-review-preparation.js';
import { mailReviewSchedulePolicy } from '../../modules/chief-of-staff/automation/mail-review-policy.js';
import type { MailReviewBinding } from '../../modules/chief-of-staff/automation/mail-review-binding.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
const scopes: string[] = [],
  roots: string[] = [];
let admin: pg.Client, database: BoundedDatabase;
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  database = await createFixtureDatabase(await fixtureDatabaseConfig());
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
async function capture(capturedAt?: number, ageMs = 1000, review = false) {
  // Production polling and retention both use the selected PostgreSQL clock.
  const at: number = capturedAt ?? (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
  const raw = {
    id: 'aa01',
    threadId: 'bb01',
    historyId: '101',
    internalDate: String(at - ageMs),
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: review
        ? [
            { name: 'Subject', value: 'Please review project alpha' },
            { name: 'From', value: 'person@example.invalid' },
            { name: 'To', value: 'owner@example.invalid' },
          ]
        : [],
      body: {
        data: Buffer.from(
          review ? 'Could you review project alpha?' : 'Fixture mail asks about project alpha.',
        ).toString('base64url'),
      },
    },
  };
  return collectMail({
    mailboxEmail: 'owner@example.invalid',
    capturedAt: at,
    reader: {
      profile: async () => ({ mailboxEmail: 'owner@example.invalid', historyId: '100' }),
      list: async () => ({ messages: [{ id: 'aa01', threadId: 'bb01' }], nextPageToken: null, resultSizeEstimate: 1 }),
      message: async (_id: string, window: MailWindow) => normalizeMailMessage(raw, window),
      history: async () => ({ changedIds: [], deletedIds: [], historyId: '200', nextPageToken: null }),
      thread: async () => ({ messages: [], excluded: 0, unsupported: 0 }),
    },
  });
}
test('G04 host inventory pages all retention bindings without account or message content', async () => {
  const f = await fixture();
  const ids = Array.from({ length: 12 }, () => randomUUID()).sort();
  for (const id of ids) assert.equal((await f.store.bind(f.context, { ...f.binding, id })).status, 'ok');
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [f.scope]);
  await f.store.setAuth(f.context, ids[0], 'revoked');
  const first = await f.store.maintenanceBindings(f.context);
  assert.equal(first.status, 'ok');
  const items = first.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 10);
  assert.deepEqual(Object.keys(items[0]).sort(), ['auth', 'binding_id', 'poll_due', 'provider_allowed']);
  assert.equal(items[0].auth, 'revoked');
  assert.deepEqual(
    items.map((x) => x.binding_id),
    ids.slice(0, 10),
  );
  assert.equal(first.next_after, ids[9]);
  const second = await f.store.maintenanceBindings(f.context, String(first.next_after));
  assert.deepEqual(
    (second.items as typeof items).map((x) => x.binding_id),
    ids.slice(10),
  );
  assert.equal(second.next_after, null);
  assert.equal((await f.store.maintenanceBindings({ ...f.context, ownerId: 'other' })).status, 'denied');
  assert.equal((await f.store.maintenanceBindings(f.context, 'bad')).status, 'denied');
  assert.equal(
    (await f.store.maintenanceBindings({ ...f.context, origin: { kind: 'schedule' } } as never)).status,
    'denied',
  );
});
test('G04 mailbox overflow keeps bounded notices and retained context while checking undisplayed access', async () => {
  const f = await fixture();
  const ids = Array.from({ length: 113 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
  for (const [index, id] of ids.entries()) {
    assert.equal(
      (await f.store.bind(f.context, { ...f.binding, id, mailboxEmail: `mailbox-${index}@example.invalid` })).status,
      'ok',
    );
  }
  const context = { ...f.context, generation: randomUUID() };
  const fenced = new Set<string>();
  const options = { enabled: () => true, access: (_scope: string, id: string) => !fenced.has(id) };
  const projection = await database.run(async (client) => {
    try {
      return { status: 'ok' as const, notice: await mailAnswerNotice(client, context, options) };
    } catch (error) {
      // Preserve the notice failure category before the database port's fixed
      // unavailable wrapper, so the regression cannot be mistaken for an outage.
      if (!(error instanceof Error) || error.message !== 'mail_inventory_limit') throw error;
      return {
        status: 'failed' as const,
        reason: error.message,
      };
    }
  });
  assert.equal(projection.status, 'ok', projection.status === 'failed' ? projection.reason : undefined);
  const read = (register = false) =>
    database.run(
      async (client) => checkMailContext(client, context, () => mailAnswerNotice(client, context, options), register),
      register,
    );
  const registered = await read(true);
  assert.equal(registered.status, 'ok');
  assert.ok(registered.status === 'ok' && registered.notice);
  const original = registered.notice;
  assert.match(original.text, /additional.*mailbox|mailbox.*not shown/i);
  assert.equal((original.text.match(/Mailbox mailbox-/g) ?? []).length, 10);
  assert.doesNotMatch(original.text, /mailbox-112@example\.invalid/);
  assert.match(original.text, /does not establish that the inbox is empty or that all mail has been reviewed/);
  assert.deepEqual(await read(), registered);

  const other = await fixture();
  const undisplayed = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  assert.equal((await other.store.bind(other.context, { ...other.binding, id: undisplayed })).status, 'ok');
  assert.equal(
    (await f.store.bind(f.context, { ...f.binding, id: undisplayed, processingProviders: ['claude'] })).status,
    'ok',
  );
  assert.deepEqual(await read(), registered);

  // Access outside the displayed page must still invalidate exposure in the
  // retained main context, without throwing or silently forgetting that policy.
  fenced.add(ids.at(-1)!);
  assert.deepEqual(await read(), { status: 'denied' });
  fenced.clear();
  assert.deepEqual(await read(), registered);
  await f.store.setAuth(f.context, ids.at(-1)!, 'revoked');
  assert.deepEqual(await read(), { status: 'denied' });
});
for (const count of [1, 10]) {
  test(`G04 mailbox legacy context identity remains valid with ${count} bindings`, async () => {
    const f = await fixture();
    const ids = Array.from({ length: count }, () => randomUUID()).sort();
    for (const id of ids) assert.equal((await f.store.bind(f.context, { ...f.binding, id })).status, 'ok');
    const context = { ...f.context, generation: randomUUID() };
    const policies = ids.map((id) => ({
      binding: id,
      version: 1,
      auth: 'ready',
      scopes: f.binding.scopes,
      mailbox: digest(f.binding.mailboxEmail),
      accessible: true,
    }));
    const result = { generation: context.generation, provider: context.provider, identity_digest: digest(policies) };
    const ticket =
      'mail-context-' + digest({ scope: f.scope, generation: context.generation, provider: context.provider });
    await admin.query(
      "INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash,result) VALUES($1,$2,$3,'cos_mail_context',$4,$5)",
      [f.context.sessionId, ticket, f.scope, digest(result), JSON.stringify(result)],
    );
    const checked = await database.run((client) =>
      checkMailContext(client, context, () =>
        mailAnswerNotice(client, context, { enabled: () => true, access: () => true }),
      ),
    );
    assert.ok(checked.status === 'ok' && checked.notice);
    assert.equal(checked.notice.identityDigest, result.identity_digest);
    assert.doesNotMatch(checked.notice.text, /Additional connected mailboxes/);
  });
}
test('G04 only one concurrent host claims a due poll; claims never fabricate a capture or success', async () => {
  const f = await fixture();
  await f.store.bind(f.context, f.binding);
  const claims = await Promise.all([
    f.store.claimPoll(f.context, f.binding.id),
    f.store.claimPoll(f.context, f.binding.id),
  ]);
  assert.deepEqual(claims.map((x) => x.claimed).sort(), [false, true]);
  const state = (await admin.query('SELECT * FROM cos.mail_states WHERE scope_id=$1', [f.scope])).rows[0];
  assert.equal(state.current_capture, null);
  assert.equal(state.last_attempt, null);
  assert.equal(state.last_success_at, null);
  assert.equal(
    (await admin.query('SELECT count(*) AS n FROM cos.mail_captures WHERE scope_id=$1', [f.scope])).rows[0].n,
    '0',
  );
  assert.equal((await f.store.claimPoll(f.context, f.binding.id)).claimed, false);
  await admin.query("UPDATE cos.mail_states SET next_poll_at=clock_timestamp()-interval '1 second' WHERE scope_id=$1", [
    f.scope,
  ]);
  assert.equal((await f.store.claimPoll({ ...f.context, provider: 'other' }, f.binding.id)).claimed, false);
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [f.scope]);
  assert.equal((await f.store.claimPoll(f.context, f.binding.id)).status, 'denied');
  await admin.query("UPDATE cos.scopes SET status='active' WHERE id=$1", [f.scope]);
  await f.store.setAuth(f.context, f.binding.id, 'revoked');
  assert.equal((await f.store.claimPoll(f.context, f.binding.id)).claimed, false);
});
test('G04 mailbox schema is additive, constrained and included in coordinated checkpoints', async () => {
  assert(Number(SCHEMA_VERSION) >= 19);
  assert.equal(
    (await admin.query('SELECT checksum FROM cos.schema_migrations WHERE version=19')).rows[0].checksum,
    MAIL_CHECKSUM,
  );
  for (const table of ['mail_bindings', 'mail_states', 'mail_captures', 'mail_messages']) {
    assert(checkpointSchema(19).tables.includes(table));
    assert(CHECKPOINT_TABLES.includes(table));
  }
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
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [f.scope]);
  const owned = new OwnerMailStore(database, f.artifacts),
    selected = { ...f.binding, id: randomUUID(), provider: 'google' as const, credentialRef: randomUUID() };
  assert.equal((await f.store.bind(f.context, selected)).status, 'denied');
  assert.equal((await owned.coverage(f.context)).status, 'ok');
  const installed = await owned.bind(f.context, selected);
  assert.equal(installed.status, 'ok');
  assert.deepEqual(await owned.bind(f.context, selected), installed);
  assert.equal((await owned.connection(f.context, selected.id)).status, 'ok');
  assert.equal(
    (await owned.bind({ ...f.context, ownerId: 'foreign-owner' }, { ...selected, id: randomUUID() })).status,
    'denied',
  );
  assert.equal(
    (await owned.bind(f.context, { ...selected, mailboxEmail: 'different@example.invalid' })).status,
    'conflict',
  );
  assert.equal((await f.store.connection(f.context, selected.id)).status, 'denied');
  assert.equal((await admin.query('SELECT status FROM cos.scopes WHERE id=$1', [f.scope])).rows[0].status, 'paused');
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
  database = await createFixtureDatabase(await fixtureDatabaseConfig());
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
  const firstSelection = (await admin.query('SELECT selection_id FROM cos.mail_messages WHERE scope_id=$1', [f.scope]))
    .rows[0].selection_id;
  const second = await capture(),
    id = randomUUID();
  const started = await f.store.start(f.context, f.binding.id, id, second.window);
  assert.equal(started.status, 'ok');
  assert.deepEqual(started.previous, prepared);
  assert.equal((await f.store.publish(f.context, f.binding.id, id, second)).status, 'ok');
  const row = (
    await admin.query('SELECT last_capture,selection_id FROM cos.mail_messages WHERE scope_id=$1', [f.scope])
  ).rows[0];
  assert.equal(row.last_capture, id);
  assert.equal(row.selection_id, firstSelection);
  const anchor = (
    await admin.query('SELECT metadata FROM cos.mail_captures WHERE scope_id=$1 AND id=$2', [f.scope, firstSelection])
  ).rows[0].metadata;
  assert.equal(anchor.contract, 'cos-mail-selection-anchor/v1');
  assert.equal(JSON.stringify(anchor).includes('Fixture mail asks'), false);
  const historical = (
    await admin.query('SELECT content_digest,metadata FROM cos.mail_captures WHERE scope_id=$1 AND id=$2', [
      f.scope,
      first,
    ])
  ).rows[0];
  assert.equal(historical.content_digest, prepared.digest);
  assert.equal(historical.metadata.contract, 'cos-mail-capture-receipt/v1');
  assert.equal(historical.metadata.capture_digest, prepared.digest);
  assert.equal(historical.metadata.messageIds, undefined);
  assert.equal((await f.store.publish(f.context, f.binding.id, first, prepared)).status, 'ok');
  assert.equal(
    (await admin.query('SELECT current_capture FROM cos.mail_states WHERE scope_id=$1', [f.scope])).rows[0]
      .current_capture,
    id,
  );
  const coverage = await f.store.coverage(f.context);
  assert.equal(coverage.status, 'ok');
  assert.equal(JSON.stringify(coverage).includes('Fixture mail asks'), false);
});
async function publishFixture(ageMs = 1000, review = false) {
  const f = await fixture();
  await f.store.bind(f.context, f.binding);
  const prepared = await capture(undefined, ageMs, review),
    id = randomUUID();
  await f.store.start(f.context, f.binding.id, id, prepared.window);
  assert.equal((await f.store.publish(f.context, f.binding.id, id, prepared)).status, 'ok');
  const knowledge = new KnowledgeStore(
    database,
    f.artifacts,
    { purgeContexts: async () => ({ status: 'ok' }) },
    { mailEnabled: () => true, mailAccess: () => true },
  );
  return { ...f, prepared, id, knowledge, context: { ...f.context, generation: randomUUID() } };
}
test('G06 preparation loads only current published owner Mail records and refuses corrupt stored content', async () => {
  const f = await publishFixture();
  const load = (ctx = f.context, capture = f.id) =>
    database.run((client) => loadMailReviewRecords(client, ctx, f.binding.id, capture));
  const records = await load();
  assert.equal(records.length, 1);
  assert.equal(records[0].message.id, 'aa01');
  assert.equal(records[0].message.trust, 'untrusted_mail_evidence');
  assert.match(records[0].message.text, /project alpha/);
  assert.ok(records[0].revision_digest);
  assert.deepEqual(await load({ ...f.context, ownerId: 'another-owner' }), []);
  assert.deepEqual(await load(f.context, randomUUID()), []);
  await assert.rejects(
    loadMailReviewRecords(
      admin,
      { ...f.context, origin: { kind: 'schedule', runId: 'a'.repeat(64), generation: 1 } },
      f.binding.id,
      f.id,
    ),
    /mail_review_source_unavailable/,
  );
  await admin.query("UPDATE cos.sources SET status='revoked' WHERE scope_id=$1", [f.scope]);
  assert.deepEqual(await load(), []);
  await admin.query("UPDATE cos.sources SET status='current' WHERE scope_id=$1", [f.scope]);
  await admin.query('UPDATE cos.mail_messages SET content_digest=$2 WHERE scope_id=$1', [
    f.scope,
    digest('corrupt stored content'),
  ]);
  await assert.rejects(loadMailReviewRecords(admin, f.context, f.binding.id, f.id), /mail_review_source_unavailable/);
});
test('G06 preparation freezes a real published source through runtime SQL and reuses it without another metadata read', async () => {
  const f = await publishFixture(1000, true),
    writer = randomUUID(),
    policy = randomUUID();
  const writerBody = {
    format: 'cos-mail-draft-binding/v1',
    provider: 'fixture',
    readerBindingId: f.binding.id,
    mailboxDigest: digest(f.binding.mailboxEmail),
    writerClientDigest: digest('writer'),
    readerClientDigest: digest('reader'),
    credentialReference: randomUUID(),
    nativeBindingDigest: digest('fixture native'),
    journalGeneration: randomUUID(),
    maxPerDay: 5,
    timeZone: 'Australia/Sydney',
    replyMode: 'plain_text_reply',
    permissionScopes: ['https://www.googleapis.com/auth/gmail.compose'],
    recoveryProofDigest: digest('fixture recovery'),
  };
  const binding: MailReviewBinding = {
    format: 'cos-mail-review-binding/v1',
    provider: 'fixture',
    readerBindingId: f.binding.id,
    writerBindingId: writer,
    writerVersion: 1,
    writerDigest: digest(writerBody),
    writerConsentRef: digest('fixture consent'),
    nativeBindingDigest: writerBody.nativeBindingDigest,
    mailboxDigest: writerBody.mailboxDigest,
    contextGeneration: f.context.generation,
    morningScheduleId: randomUUID(),
    afternoonScheduleId: randomUUID(),
    timeZone: 'Australia/Sydney',
    maxCandidateThreads: 10,
    maxModelAttempts: 3,
    maxDraftsPerDay: 5,
  };
  const runId = digest(randomUUID()),
    limits = { max_turns: 3, max_tool_calls: 16, deadline_seconds: 300, refresh_seconds: 30 };
  try {
    await admin.query(
      "INSERT INTO cos.mail_draft_writer_bindings(scope_id,id,reader_binding_id,owner_id,session_id,version,state) VALUES($1,$2,$3,$4,$5,1,'enabled')",
      [f.scope, writer, f.binding.id, f.context.ownerId, f.context.sessionId],
    );
    await admin.query(
      'INSERT INTO cos.mail_draft_writer_revisions(scope_id,binding_id,version,body,digest,consent_ref) VALUES($1,$2,1,$3,$4,$5)',
      [f.scope, writer, JSON.stringify(writerBody), digest(writerBody), binding.writerConsentRef],
    );
    await admin.query(
      "INSERT INTO cos.mail_review_policies(scope_id,id,owner_id,session_id,agent_group_id,version,state) VALUES($1,$2,$3,$4,$1,1,'enabled')",
      [f.scope, policy, f.context.ownerId, f.context.sessionId],
    );
    await admin.query(
      'INSERT INTO cos.mail_review_policy_revisions(scope_id,binding_id,version,reader_binding_id,writer_binding_id,writer_version,body,digest,owner_config_ref) VALUES($1,$2,1,$3,$4,1,$5,$6,$7)',
      [f.scope, policy, f.binding.id, writer, JSON.stringify(binding), digest(binding), digest('fixture config')],
    );
    await admin.query(
      "INSERT INTO cos.brief_schedules(scope_id,id,owner_id,session_id,agent_group_id,title,policy,limits,version,provenance,purpose,mail_review_policy_id,mail_review_policy_version,mail_review_slot) VALUES($1,$2,$3,$4,$1,'Fixture morning review',$5,$6,1,'{}','mail_review',$7,1,'morning')",
      [
        f.scope,
        binding.morningScheduleId,
        f.context.ownerId,
        f.context.sessionId,
        JSON.stringify(mailReviewSchedulePolicy('morning')),
        JSON.stringify(limits),
        policy,
      ],
    );
    await admin.query(
      `INSERT INTO cos.brief_schedule_revisions(scope_id,schedule_id,version,body,proposal_id,mail_review_policy_id,mail_review_policy_version)
       SELECT scope_id,id,version,to_jsonb(s),NULL,mail_review_policy_id,mail_review_policy_version FROM cos.brief_schedules s WHERE scope_id=$1 AND id=$2`,
      [f.scope, binding.morningScheduleId],
    );
    await admin.query(
      "INSERT INTO cos.brief_runs(scope_id,id,schedule_id,schedule_version,owner_id,session_id,agent_group_id,intended_at,local_date,state,limits,model_calls,generation,lease_owner,lease_until,deadline_at,provenance) VALUES($1,$2,$3,1,$4,$5,$1,clock_timestamp(),CURRENT_DATE,'dispatched',$6,0,1,$7,clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '5 minutes','{}')",
      [
        f.scope,
        runId,
        binding.morningScheduleId,
        f.context.ownerId,
        f.context.sessionId,
        JSON.stringify(limits),
        'cos-native-' + binding.nativeBindingDigest,
      ],
    );
    const identity = { bindingDigest: binding.nativeBindingDigest, contextGeneration: f.context.generation };
    const access = new MailReviewAccess({
      authority: () => identity,
      ownerAuthority: () => identity,
      matches: () => true,
    });
    let metadataReads = 0;
    const preparer = new MailReviewPreparer({
      database,
      access,
      knowledge: f.knowledge,
      current: () => true,
      connector: {
        reviewSource: async (_ctx, _binding, message, _window, current) => {
          assert.equal(await current(), true);
          metadataReads++;
          const stored = f.prepared.messages.find((m) => m.id === message)!;
          return {
            id: stored.id,
            threadId: stored.threadId,
            historyId: stored.historyId,
            internalDate: stored.internalDate,
            observedAt: Date.now(),
            excluded: null,
          };
        },
      },
    });
    assert.equal((await preparer.execute(f.context, runId, 1)).status, 'ok');
    assert.equal(metadataReads, 1);
    const frozen = (
      await admin.query('SELECT review_inputs,model_calls,tool_calls FROM cos.brief_runs WHERE scope_id=$1 AND id=$2', [
        f.scope,
        runId,
      ])
    ).rows[0];
    assert.equal(frozen.review_inputs.candidates.length, 1);
    assert.equal(frozen.review_inputs.candidates[0].source_message_id, 'aa01');
    assert.equal(frozen.model_calls, 0);
    assert.equal(frozen.tool_calls, 0);
    assert.equal((await preparer.execute(f.context, runId, 1)).status, 'ok');
    assert.equal(metadataReads, 1);
    const scheduled = {
      ...f.context,
      ingressId: `brief:${runId}:1`,
      origin: { kind: 'schedule' as const, runId, generation: 1 },
    };
    assert.equal(
      (await database.run((client) => access.check(client, scheduled, 'read')))?.inputs.candidates.length,
      1,
    );
    assert.equal(await database.run((client) => access.check(client, scheduled, 'draft', 'bb01')), null);
    await admin.query('UPDATE cos.brief_runs SET model_calls=1 WHERE scope_id=$1 AND id=$2', [f.scope, runId]);
    assert.equal((await database.run((client) => access.check(client, scheduled, 'draft', 'bb01')))?.id, policy);
    const scopedKnowledge = new KnowledgeStore(
      database,
      f.artifacts,
      {},
      {
        mailEnabled: () => true,
        mailAccess: () => true,
        mailReviewAccess: access,
      },
    );
    const priorities = new PriorityStore(
      database,
      scopedKnowledge,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      access,
    );
    const reviewContext = await priorities.context(scheduled, scheduled);
    assert.equal(reviewContext.status, 'ok');
    const displayed = reviewContext.mail_review as {
      candidates: { excerpt: string; citation: { evidence_id: string } }[];
    };
    assert.equal(displayed.candidates.length, 1);
    assert.match(displayed.candidates[0].excerpt, /Could you review project alpha/);
    assert.match(displayed.candidates[0].citation.evidence_id, /^[a-f0-9-]{36}$/);
    assert.equal((await scopedKnowledge.contextReady(f.context)).status, 'ok');
    await admin.query("UPDATE cos.mail_review_policies SET state='revoked' WHERE scope_id=$1", [f.scope]);
    assert.equal((await priorities.context(scheduled, scheduled)).status, 'denied');
    assert.equal((await preparer.execute(f.context, runId, 1)).status, 'denied');
    assert.equal(metadataReads, 1);
  } finally {
    for (const table of [
      'brief_runs',
      'brief_schedule_revisions',
      'brief_schedules',
      'mail_review_policy_revisions',
      'mail_review_policies',
      'mail_draft_writer_revisions',
      'mail_draft_writer_bindings',
    ])
      await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=$1', [f.scope]);
  }
});
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const until = performance.now() + 3000;
  while (!(await check())) {
    assert(performance.now() < until, 'mail background operation did not settle');
    await delay(20);
  }
}
test('G04 background maintenance applies independent revocation to real paused storage without inference or provider reads', async () => {
  const f = await publishFixture();
  const before = (await admin.query('SELECT last_success_at FROM cos.mail_states WHERE scope_id=$1', [f.scope]))
    .rows[0];
  fs.mkdirSync(f.root + '/pump-fences', { mode: 0o700 });
  const fences = CalendarAccessFences.initialize(f.root + '/pump-fences');
  fences.deny(f.scope, f.binding.id, 'revoked');
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [f.scope]);
  let reads = 0;
  const pump = new MailPump({
    store: f.store,
    fences,
    connector: {
      refresh: async () => {
        reads++;
        return { result: { status: 'unavailable' } };
      },
    },
    authority: { retention: () => true, poll: () => false },
  });
  try {
    assert.equal(pump.poke(f.context), true);
    await eventually(
      async () =>
        (await admin.query('SELECT count(*) AS n FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0].n ===
        '0',
    );
    assert.equal(reads, 0);
    const after = (
      await admin.query(
        'SELECT b.auth,s.last_success_at FROM cos.mail_bindings b JOIN cos.mail_states s ON s.scope_id=b.scope_id AND s.binding_id=b.id WHERE b.scope_id=$1',
        [f.scope],
      )
    ).rows[0];
    assert.equal(after.auth, 'revoked');
    assert.deepEqual(after.last_success_at, before.last_success_at);
  } finally {
    await pump.close();
  }
});
test('G04 global-off owner tightens real paused mail storage without a source connector or waiving protected history purge', async () => {
  const f = await publishFixture();
  const exposed = await f.knowledge.search(f.context, { query: 'alpha' });
  assert.equal(exposed.status, 'ok');
  assert((exposed.items as unknown[]).length > 0);
  await f.store.setAuth(f.context, f.binding.id, 'revoked');
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [f.scope]);
  const ownedDatabase = await createFixtureDatabase(await fixtureDatabaseConfig());
  const host = new MailHost({ store: new MailStore(ownedDatabase, f.artifacts) });
  const maintenance = new MailMaintenance({
    admitted: () => true,
    contexts: () => [f.context],
    authority: { retention: () => true, poll: () => true },
    connect: async () => ({
      mail: host,
      knowledge: new KnowledgeStore(ownedDatabase, f.artifacts),
      database: ownedDatabase,
    }),
  });
  try {
    assert.equal(host.active(), false);
    assert.equal(host.connector, undefined);
    await maintenance.tick();
    await eventually(
      async () =>
        (await admin.query('SELECT count(*) AS n FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0].n ===
        '0',
    );
    assert.equal(
      (await admin.query('SELECT auth FROM cos.mail_bindings WHERE scope_id=$1', [f.scope])).rows[0].auth,
      'revoked',
    );
    const current = (
      await admin.query(
        'SELECT c.metadata FROM cos.mail_states s JOIN cos.mail_captures c ON c.scope_id=s.scope_id AND c.id=s.current_capture WHERE s.scope_id=$1',
        [f.scope],
      )
    ).rows[0];
    assert.equal(current.metadata.mode, 'retention');
    await maintenance.tick();
    assert.equal(maintenance.status().purge, 'pending');
  } finally {
    await maintenance.close();
  }
});
test('G04 reconstructing a background scheduler honors a prior database poll claim', async () => {
  const f = await fixture();
  await f.store.bind(f.context, f.binding);
  let reads = 0;
  const options = {
    store: f.store,
    fences: { assertOpen: () => {} },
    connector: {
      refresh: async () => {
        reads++;
        return { result: { status: 'unavailable' as const } };
      },
    },
    authority: { retention: () => true, poll: () => true },
  };
  const first = new MailPump(options);
  try {
    first.poke(f.context);
    await eventually(async () => reads === 1);
  } finally {
    await first.close();
  }
  let checked = false,
    claims = 0;
  const next = new MailPump({
    ...options,
    store: {
      maintenanceBindings: f.store.maintenanceBindings.bind(f.store),
      setAuth: f.store.setAuth.bind(f.store),
      claimPoll: async (...args) => {
        claims++;
        return f.store.claimPoll(...args);
      },
      maintain: async (...args) => {
        const result = await f.store.maintain(...args);
        checked = true;
        return result;
      },
    },
  });
  try {
    next.poke(f.context);
    await eventually(async () => checked);
  } finally {
    await next.close();
  }
  assert.equal(reads, 1);
  assert.equal(claims, 0);
  const state = (
    await admin.query(
      'SELECT current_capture,last_success_at,next_poll_at>clock_timestamp() AS delayed FROM cos.mail_states WHERE scope_id=$1',
      [f.scope],
    )
  ).rows[0];
  assert.equal(state.current_capture, null);
  assert.equal(state.last_success_at, null);
  assert.equal(state.delayed, true);
});
const rehashCapture = (value: Awaited<ReturnType<typeof capture>>) => {
  const { digest: _digest, ...content } = value;
  value.digest = digest(content);
  return value;
};
test('G06 restricts new scheduled Mail reads and citations while preserving earlier owner context', async () => {
  const f = await fixture();
  await f.store.bind(f.context, f.binding);
  const prepared = await capture(),
    { digest: _digest, ...first } = prepared.messages[0];
  const second = { ...first, id: 'aa02', threadId: 'bb02' };
  prepared.messages.push({ ...second, digest: digest(second) });
  prepared.textBytes *= 2;
  rehashCapture(prepared);
  const id = randomUUID();
  assert.equal((await f.store.start(f.context, f.binding.id, id, prepared.window)).status, 'ok');
  assert.equal((await f.store.publish(f.context, f.binding.id, id, prepared)).status, 'ok');
  let selected: MailReviewReadScope | null = { binding_id: f.binding.id, thread_ids: ['bb01'] };
  let revokeOnDisclosure = false;
  const knowledge = new KnowledgeStore(
    database,
    f.artifacts,
    {
      beforeDisclosure: async () => {
        if (revokeOnDisclosure) selected = { binding_id: null, thread_ids: [] };
      },
    },
    {
      mailEnabled: () => true,
      mailAccess: () => true,
      mailReviewAccess: { scopeForReads: async (_client, ctx) => (ctx.origin?.kind === 'schedule' ? selected : null) },
    },
  );
  const owner = { ...f.context, generation: randomUUID() },
    runId = 'a'.repeat(64),
    scheduled = {
      ...owner,
      ingressId: `brief:${runId}:1`,
      origin: { kind: 'schedule' as const, runId, generation: 1 },
    };
  const old = await knowledge.search(owner, { query: 'alpha' });
  assert.equal(old.status, 'ok');
  assert.equal((old.items as unknown[]).length, 2);
  const outside = (
    await admin.query(
      "SELECT mm.source_id,s.current_revision_id FROM cos.mail_messages mm JOIN cos.sources s ON s.scope_id=mm.scope_id AND s.id=mm.source_id WHERE mm.scope_id=$1 AND mm.provider_thread_id='bb02'",
      [f.scope],
    )
  ).rows[0];
  const inside = (
    await admin.query("SELECT source_id FROM cos.mail_messages WHERE scope_id=$1 AND provider_thread_id='bb01'", [
      f.scope,
    ])
  ).rows[0];
  const found = await knowledge.search(scheduled, { query: 'alpha' });
  assert.equal(found.status, 'ok');
  assert.equal((found.items as unknown[]).length, 1);
  assert.equal((await knowledge.get(scheduled, outside.source_id, outside.current_revision_id, 0)).status, 'denied');
  assert.equal((await knowledge.contextReady(scheduled)).status, 'ok');
  assert.equal((await knowledge.contextReady(owner)).status, 'ok');
  const oldEvidence = (old.items as Array<{ source_id: string; text: string; evidence_id: string }>).find(
    (item) => item.source_id === outside.source_id,
  )!;
  assert.equal(
    (
      await knowledge.answers.prepare(scheduled, randomUUID(), {
        kind: 'answer',
        coverage: 'limited',
        claims: [
          {
            kind: 'quote',
            text: oldEvidence.text,
            citations: [{ kind: 'source', evidence_id: oldEvidence.evidence_id }],
          },
        ],
      })
    ).status,
    'denied',
  );
  assert.equal((await knowledge.readSourcesCurrent(scheduled, [inside.source_id])).status, 'ok');
  selected = { binding_id: null, thread_ids: [] };
  assert.deepEqual((await knowledge.search(scheduled, { query: 'alpha' })).items, []);
  assert.equal((await knowledge.readSourcesCurrent(scheduled, [inside.source_id])).status, 'denied');
  assert.equal((await knowledge.contextReady(owner)).status, 'ok');
  // Only the separately checked generic schedule path may return an unrestricted read scope.
  selected = null;
  assert.equal(((await knowledge.search(scheduled, { query: 'alpha' })).items as unknown[]).length, 2);
  selected = { binding_id: f.binding.id, thread_ids: ['bb01'] };
  revokeOnDisclosure = true;
  assert.equal((await knowledge.search(scheduled, { query: 'alpha' })).status, 'denied');
});
test('G04 publishes mail as cited untrusted evidence in the same committed capture and cursor', async () => {
  const f = await publishFixture();
  const row = (
    await admin.query(
      'SELECT m.source_id,m.selection_id,s.provenance,s.access_policy,s.current_revision_id FROM cos.mail_messages m JOIN cos.sources s ON s.scope_id=m.scope_id AND s.id=m.source_id WHERE m.scope_id=$1',
      [f.scope],
    )
  ).rows[0];
  assert(row);
  assert.equal(row.provenance.origin, 'mail_message');
  assert.equal(row.access_policy.mail_binding_id, f.binding.id);
  assert.equal(row.access_policy.selection_id, row.selection_id);
  const found = await f.knowledge.search(f.context, { query: 'alpha' });
  assert.equal(found.status, 'ok');
  assert.equal((found.items as unknown[]).length, 1);
  assert.match(JSON.stringify(found), /untrusted|Untrusted/);
});
test('G04 a capture rollback admits neither mail evidence nor its cursor and reconciles the same capture after restart', async () => {
  const f = await fixture({
    beforePublishCommit: async () => {
      throw Error('FIXTURE_INTERRUPTED_BEFORE_COMMIT');
    },
  });
  await f.store.bind(f.context, f.binding);
  const prepared = await capture(),
    id = randomUUID();
  await f.store.start(f.context, f.binding.id, id, prepared.window);
  assert.equal((await f.store.publish(f.context, f.binding.id, id, prepared)).status, 'pending');
  for (const table of ['sources', 'source_revisions', 'chunks', 'mail_messages'])
    assert.equal(
      (await admin.query('SELECT count(*)::int AS n FROM cos.' + table + ' WHERE scope_id=$1', [f.scope])).rows[0].n,
      0,
    );
  assert.equal(
    (await admin.query('SELECT history_cursor FROM cos.mail_states WHERE scope_id=$1', [f.scope])).rows[0]
      .history_cursor,
    null,
  );
  await database.pool.end();
  database = await createFixtureDatabase(await fixtureDatabaseConfig());
  const store = new MailStore(database, f.artifacts);
  assert.equal((await store.publish(f.context, f.binding.id, id, prepared)).status, 'ok');
  assert.equal((await store.publish(f.context, f.binding.id, id, prepared)).status, 'ok');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE scope_id=$1', [f.scope])).rows[0].n,
    1,
  );
});
test('G04 history and label changes preserve unchanged source revisions and exposed context', async () => {
  const f = await publishFixture();
  assert.equal((await f.knowledge.search(f.context, { query: 'alpha' })).status, 'ok');
  const next = structuredClone(f.prepared),
    id = randomUUID();
  next.historyId = '201';
  next.messages[0].historyId = '201';
  next.messages[0].labels = ['SENT'];
  const { digest: _old, ...message } = next.messages[0];
  next.messages[0].digest = digest(message);
  rehashCapture(next);
  await f.store.start(f.context, f.binding.id, id, next.window);
  assert.equal((await f.store.publish(f.context, f.binding.id, id, next)).status, 'ok');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE scope_id=$1', [f.scope])).rows[0].n,
    1,
  );
  assert.equal((await f.knowledge.contextReady(f.context)).status, 'ok');
});
test('G04 selection withdrawal closes evidence immediately and purges its local copies before a fresh selection is admitted', async () => {
  const f = await publishFixture(),
    found = await f.knowledge.search(f.context, { query: 'alpha' }),
    evidence = (found.items as Array<{ source_id: string; revision_id: string }>)[0];
  assert(evidence);
  const source = evidence.source_id,
    artifact = (
      await admin.query('SELECT artifact_id FROM cos.source_revisions WHERE scope_id=$1 AND source_id=$2', [
        f.scope,
        source,
      ])
    ).rows[0].artifact_id;
  const empty = rehashCapture({ ...structuredClone(f.prepared), messages: [], textBytes: 0, removedIds: ['aa01'] }),
    removed = randomUUID();
  await f.store.start(f.context, f.binding.id, removed, empty.window);
  assert.equal((await f.store.publish(f.context, f.binding.id, removed, empty)).status, 'ok');
  assert.equal((await f.knowledge.contextReady(f.context)).status, 'denied');
  assert.equal(
    (await f.knowledge.get({ ...f.context, generation: randomUUID() }, source, evidence.revision_id, 0)).status,
    'denied',
  );
  assert.equal(
    (
      await admin.query('SELECT kind FROM cos.revocation_tombstones WHERE scope_id=$1 AND source_id=$2', [
        f.scope,
        source,
      ])
    ).rows[0].kind,
    'delete',
  );
  assert.equal((await f.knowledge.purgeDue(f.scope)).status, 'ok');
  assert.equal(fs.existsSync(f.artifacts.root + '/' + artifact + '.blob'), false);
  const selected = randomUUID();
  await f.store.start(f.context, f.binding.id, selected, f.prepared.window);
  assert.equal((await f.store.publish(f.context, f.binding.id, selected, f.prepared)).status, 'ok');
  const current = (
    await admin.query(
      'SELECT m.source_id,r.artifact_id FROM cos.mail_messages m JOIN cos.sources s ON s.scope_id=m.scope_id AND s.id=m.source_id JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.id=s.current_revision_id WHERE m.scope_id=$1',
      [f.scope],
    )
  ).rows[0];
  assert.notEqual(current.source_id, source);
  assert.notEqual(current.artifact_id, artifact);
  assert.equal((await f.knowledge.contextReady(f.context)).status, 'denied');
});
test('G04 retention publishes a separate immutable checkpoint during a provider outage and preserves the provider sync time and cursor', async () => {
  const f = await publishFixture(30 * 86400000 - 500);
  const before = (
    await admin.query(
      'SELECT current_capture,history_cursor,last_success_at,last_attempt FROM cos.mail_states WHERE scope_id=$1',
      [f.scope],
    )
  ).rows[0];
  const original = (
    await admin.query('SELECT metadata,content_digest FROM cos.mail_captures WHERE scope_id=$1 AND id=$2', [
      f.scope,
      f.id,
    ])
  ).rows[0];
  await new Promise((resolve) => setTimeout(resolve, 750));
  const operation = randomUUID();
  const result = await f.store.maintain(f.context, f.binding.id, operation);
  assert.equal(result.status, 'ok');
  assert.deepEqual(await f.store.maintain(f.context, f.binding.id, operation), result);
  const state = (
    await admin.query(
      'SELECT current_capture,history_cursor,last_success_at,last_attempt FROM cos.mail_states WHERE scope_id=$1',
      [f.scope],
    )
  ).rows[0];
  assert.equal(state.current_capture, operation);
  assert.equal(state.history_cursor, before.history_cursor);
  assert.equal(state.last_success_at.toISOString(), before.last_success_at.toISOString());
  assert.equal(state.last_attempt, before.last_attempt);
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0].n,
    0,
  );
  assert.deepEqual(
    (
      await admin.query('SELECT metadata,content_digest FROM cos.mail_captures WHERE scope_id=$1 AND id=$2', [
        f.scope,
        f.id,
      ])
    ).rows[0],
    original,
  );
  assert.equal((await f.knowledge.purgeDue(f.scope)).status, 'ok');
  const currentWindow = await f.store.captureWindow(f.context);
  assert.equal(currentWindow.status, 'ok');
  const next = await f.store.start(f.context, f.binding.id, randomUUID(), currentWindow.window as MailWindow);
  assert.equal(next.status, 'ok');
  const previous = next.previous as { messages: unknown[]; mode: string };
  assert.equal(previous.mode, 'retention');
  assert.deepEqual(previous.messages, []);
});
for (const state of ['paused', 'revoked'])
  test(`G04 trusted retention removes closed mail while ${state} without reopening source or global admission`, async () => {
    const f = await publishFixture();
    if (state === 'paused') await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [f.scope]);
    await admin.query("UPDATE cos.mail_bindings SET auth='revoked' WHERE scope_id=$1", [f.scope]);
    const result = await f.store.maintain(f.context, f.binding.id, randomUUID());
    assert.equal(result.status, 'ok');
    assert.equal(
      (await admin.query('SELECT count(*)::int AS n FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0].n,
      0,
    );
    assert.equal(
      (await admin.query('SELECT auth FROM cos.mail_bindings WHERE scope_id=$1', [f.scope])).rows[0].auth,
      'revoked',
    );
    assert.equal(
      (await admin.query('SELECT status FROM cos.scopes WHERE id=$1', [f.scope])).rows[0].status,
      state === 'paused' ? 'paused' : 'active',
    );
  });
test('G04 owner source denial removes raw copies and cannot be revived by a later capture', async () => {
  const f = await publishFixture(),
    row = (await admin.query('SELECT source_id FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0];
  assert.equal((await f.knowledge.revokeOwned(f.context, row.source_id)).status, 'ok');
  const maintained = await f.store.maintain(f.context, f.binding.id, randomUUID());
  assert.equal(maintained.status, 'ok');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0].n,
    0,
  );
  assert.equal((await f.knowledge.purgeDue(f.scope)).status, 'ok');
  const currentWindow = await f.store.captureWindow(f.context);
  assert.equal(currentWindow.status, 'ok');
  const id = randomUUID(),
    freshCapture = await capture((currentWindow.window as MailWindow).capturedAt);
  assert.equal((await f.store.start(f.context, f.binding.id, id, freshCapture.window)).status, 'ok');
  assert.equal((await f.store.publish(f.context, f.binding.id, id, freshCapture)).status, 'denied');
  const filtered = await f.store.filterCapture(f.context, f.binding.id, freshCapture);
  assert.equal(filtered.status, 'ok');
  const safeCapture = filtered.capture as typeof f.prepared;
  assert.deepEqual(safeCapture.messages, []);
  assert.equal(safeCapture.complete, false);
  assert(safeCapture.limitations.includes('owner_denied'));
  assert.equal((await f.store.publish(f.context, f.binding.id, id, safeCapture)).status, 'ok');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0].n,
    0,
  );
});
test('G04 a fresh capture cannot move its observation window backwards after retention advanced it', async () => {
  const f = await publishFixture(30 * 86400000 - 500);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal((await f.store.maintain(f.context, f.binding.id, randomUUID())).status, 'ok');
  assert.equal((await f.store.start(f.context, f.binding.id, randomUUID(), f.prepared.window)).status, 'conflict');
});
test('G04 repeated retention checks without content changes do not grow checkpoint history or replace provider freshness', async () => {
  const f = await publishFixture(),
    before = (await admin.query('SELECT count(*)::int AS n FROM cos.mail_captures WHERE scope_id=$1', [f.scope]))
      .rows[0].n;
  const state = (
    await admin.query('SELECT current_capture,last_success_at,last_attempt FROM cos.mail_states WHERE scope_id=$1', [
      f.scope,
    ])
  ).rows[0];
  for (let i = 0; i < 4; i++) {
    const result = await f.store.maintain(f.context, f.binding.id, randomUUID());
    assert.equal(result.status, 'ok');
    assert.equal(result.changed, false);
  }
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mail_captures WHERE scope_id=$1', [f.scope])).rows[0].n,
    before,
  );
  assert.deepEqual(
    (
      await admin.query('SELECT current_capture,last_success_at,last_attempt FROM cos.mail_states WHERE scope_id=$1', [
        f.scope,
      ])
    ).rows[0],
    state,
  );
});
test('G04 cited mail answers carry host-rendered freshness without resetting their context on an ordinary poll', async () => {
  const f = await publishFixture(),
    found = await f.knowledge.search(f.context, { query: 'alpha' }),
    evidence = (found.items as Array<{ text: string; evidence_id: string }>)[0];
  assert(evidence);
  const draft = {
    kind: 'answer',
    coverage: 'limited',
    claims: [
      { kind: 'quote', text: evidence.text, citations: [{ kind: 'source', evidence_id: evidence.evidence_id }] },
    ],
  };
  const answer = await f.knowledge.answers.prepare(f.context, randomUUID(), draft);
  assert.equal(answer.status, 'ok');
  assert.match(String(answer.text), /Mailbox coverage/);
  assert.match(String(answer.text), /last successful refresh/i);
  assert.match(String(answer.text), /does not establish that the inbox is empty/i);
  const clock = await f.store.captureWindow(f.context);
  assert.equal(clock.status, 'ok');
  const next = rehashCapture({
      ...structuredClone(f.prepared),
      mode: 'incremental',
      window: clock.window as MailWindow,
      historyId: '201',
    }),
    id = randomUUID();
  await f.store.start(f.context, f.binding.id, id, next.window);
  assert.equal((await f.store.publish(f.context, f.binding.id, id, next)).status, 'ok');
  assert.equal((await f.knowledge.contextReady(f.context)).status, 'ok');
  const old = await f.knowledge.answers.get(f.context, String(answer.artifact_id));
  assert.equal(old.status, 'ok');
  assert.equal(old.text, answer.text);
  const fresh = await f.knowledge.answers.prepare(f.context, randomUUID(), draft);
  assert.equal(fresh.status, 'ok');
  assert.match(String(fresh.text), /Mailbox coverage/);
});
test('G04 even an empty mailbox metadata view is fenced when its account authority is later withdrawn', async () => {
  const f = await fixture();
  await f.store.bind(f.context, f.binding);
  const ctx = { ...f.context, generation: randomUUID() },
    knowledge = new KnowledgeStore(database, f.artifacts, {}, { mailEnabled: () => true, mailAccess: () => true });
  assert.equal((await knowledge.recordMailContext(ctx)).status, 'ok');
  assert.equal((await knowledge.contextReady(ctx)).status, 'ok');
  await admin.query("UPDATE cos.mail_bindings SET auth='revoked' WHERE scope_id=$1", [f.scope]);
  assert.equal((await knowledge.contextReady(ctx)).status, 'denied');
});
test('G04 mail exposed by a work-evidence path still adds host coverage to its answer', async () => {
  const f = await publishFixture(),
    found = await f.knowledge.search(f.context, { query: 'alpha' }),
    evidence = (found.items as Array<{ text: string; evidence_id: string }>)[0];
  // Work evidence can register source exposure without going through knowledge search.
  await admin.query("DELETE FROM cos.operations WHERE scope_id=$1 AND method='cos_mail_context'", [f.scope]);
  const answer = await f.knowledge.answers.prepare(f.context, randomUUID(), {
    kind: 'answer',
    coverage: 'limited',
    claims: [
      { kind: 'quote', text: evidence.text, citations: [{ kind: 'source', evidence_id: evidence.evidence_id }] },
    ],
  });
  assert.equal(answer.status, 'ok');
  assert.match(String(answer.text), /Mailbox coverage/);
});
for (const state of ['partial', 'stale', 'failed', 'retention'])
  test(`G04 mailbox coverage explicitly reports ${state} observations`, async () => {
    const f = await publishFixture(state === 'retention' ? 30 * 86400000 - 500 : 1000);
    if (state === 'partial') {
      const next = rehashCapture({
        ...structuredClone(f.prepared),
        complete: false,
        limitations: ['checkpoint_limit'],
      });
      const id = randomUUID();
      assert.equal((await f.store.start(f.context, f.binding.id, id, next.window)).status, 'ok');
      assert.equal((await f.store.publish(f.context, f.binding.id, id, next)).status, 'ok');
    }
    if (state === 'stale')
      await admin.query(
        "UPDATE cos.mail_states SET last_success_at=clock_timestamp()-interval '11 minutes' WHERE scope_id=$1",
        [f.scope],
      );
    if (state === 'failed') {
      const id = randomUUID(),
        clock = await f.store.captureWindow(f.context);
      assert.equal((await f.store.start(f.context, f.binding.id, id, clock.window as MailWindow)).status, 'ok');
      assert.equal((await f.store.fail(f.context, f.binding.id, id, 'mail_unavailable')).status, 'ok');
    }
    if (state === 'retention') {
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.equal((await f.store.maintain(f.context, f.binding.id, randomUUID())).status, 'ok');
    }
    const view = await f.knowledge.recordMailContext(f.context);
    assert.equal(view.status, 'ok');
    const text = (view.notice as { text: string }).text;
    assert.match(text, state === 'stale' ? /Stale:/ : /Incomplete:/);
    assert.match(
      text,
      state === 'partial'
        ? /checkpoint size limit/
        : state === 'failed'
          ? /latest refresh failed/
          : state === 'retention'
            ? /retention ran without a provider refresh/
            : /over ten minutes old/,
    );
    assert.doesNotMatch(text, /Capture complete/);
    assert.match(text, /does not establish that the inbox is empty/);
  });
test('G04 account loss between answer preparation and commit cannot publish a stale mail answer', async () => {
  const f = await publishFixture();
  let accessible = true,
    hookCalled = false;
  const knowledge = new KnowledgeStore(
    database,
    f.artifacts,
    {
      afterAnswerPublication: async () => {
        hookCalled = true;
        accessible = false;
      },
    },
    { mailEnabled: () => true, mailAccess: () => accessible },
  );
  assert.equal((await knowledge.recordMailContext(f.context)).status, 'ok');
  const answer = await knowledge.answers.prepare(f.context, randomUUID(), {
    kind: 'answer',
    coverage: 'insufficient',
    claims: [],
  });
  assert.equal(hookCalled, true);
  assert.equal(answer.status, 'denied');
  assert.equal(
    (await admin.query("SELECT count(*)::int AS n FROM cos.artifacts WHERE scope_id=$1 AND kind='answer'", [f.scope]))
      .rows[0].n,
    0,
  );
});
test('G04 a refresh starting during answer publication cannot commit the previous freshness observation', async () => {
  const f = await publishFixture();
  let hookCalled = false;
  const knowledge = new KnowledgeStore(
    database,
    f.artifacts,
    {
      afterAnswerPublication: async () => {
        hookCalled = true;
        const clock = await f.store.captureWindow(f.context),
          id = randomUUID();
        assert.equal((await f.store.start(f.context, f.binding.id, id, clock.window as MailWindow)).status, 'ok');
      },
    },
    { mailEnabled: () => true, mailAccess: () => true },
  );
  assert.equal((await knowledge.recordMailContext(f.context)).status, 'ok');
  const answer = await knowledge.answers.prepare(f.context, randomUUID(), {
    kind: 'answer',
    coverage: 'insufficient',
    claims: [],
  });
  assert.equal(hookCalled, true);
  assert.equal(answer.status, 'denied');
  assert.equal((await knowledge.contextReady(f.context)).status, 'ok');
});
test('G04 host refresh publishes through the real store and a reconstructed mail journal preserves provider revocation', async () => {
  const f = await fixture();
  assert.equal((await f.store.bind(f.context, f.binding)).status, 'ok');
  fs.mkdirSync(f.root + '/mail-fences', { mode: 0o700 });
  const fences = CalendarAccessFences.initialize(f.root + '/mail-fences');
  let revoked = false;
  const options = {
    store: f.store,
    fences,
    admitted: () => true,
    verifyStorage: () => {},
    fixtureReader: () => ({
      profile: async () => {
        if (revoked) throw new MailReadError('mail_auth_revoked');
        return { mailboxEmail: f.binding.mailboxEmail, historyId: '100' };
      },
      list: async () => ({ messages: [], nextPageToken: null, resultSizeEstimate: 0 }),
      history: async () => ({ changedIds: [], deletedIds: [], historyId: '101', nextPageToken: null }),
      message: async () => ({ status: 'excluded' as const, reason: 'not_selected' as const }),
      thread: async () => ({ messages: [], excluded: 0, unsupported: 0 }),
    }),
  };
  const connector = new MailConnector(options),
    first = randomUUID();
  assert.equal((await connector.refresh(f.context, f.binding.id, first)).result.status, 'ok');
  assert.equal(
    (await admin.query('SELECT current_capture,history_cursor FROM cos.mail_states WHERE scope_id=$1', [f.scope]))
      .rows[0].current_capture,
    first,
  );
  revoked = true;
  const denied = await connector.refresh(f.context, f.binding.id, randomUUID());
  assert.equal(denied.result.status, 'denied');
  assert.equal(denied.result.access_loss, 'revoked');
  const reconstructed = new MailConnector({ ...options, fences: new CalendarAccessFences(f.root + '/mail-fences') });
  assert.throws(() => reconstructed.assertOpen(f.scope, f.binding.id), /auth_revoked/);
  assert.equal(
    (await admin.query('SELECT auth FROM cos.mail_bindings WHERE scope_id=$1', [f.scope])).rows[0].auth,
    'revoked',
  );
  assert.equal(
    (await admin.query('SELECT current_capture FROM cos.mail_states WHERE scope_id=$1', [f.scope])).rows[0]
      .current_capture,
    first,
  );
});
test('G04 host refresh reconciles the exact committed capture after losing publication acknowledgement', async () => {
  let interrupted = false;
  const f = await fixture({
    afterPublishCommit: async () => {
      if (!interrupted) {
        interrupted = true;
        throw Error('FIXTURE_LOST_PUBLICATION_ACK');
      }
    },
  });
  await f.store.bind(f.context, f.binding);
  const options = {
    store: f.store,
    admitted: () => true,
    verifyStorage: () => {},
    fences: {
      assertOpen: () => {},
      deny: () => {},
      runCheck: async <T>(_scope: string, _binding: string, operation: () => Promise<T>) => operation(),
    },
    fixtureReader: () => ({
      profile: async () => ({ mailboxEmail: f.binding.mailboxEmail, historyId: '100' }),
      list: async () => ({ messages: [], nextPageToken: null, resultSizeEstimate: 0 }),
      message: async () => ({ status: 'excluded' as const, reason: 'not_selected' as const }),
      thread: async () => ({ messages: [], excluded: 0, unsupported: 0 }),
      history: async () => ({ changedIds: [], deletedIds: [], historyId: '101', nextPageToken: null }),
    }),
  };
  const connector = new MailConnector(options),
    id = randomUUID();
  const first = await connector.refresh(f.context, f.binding.id, id);
  assert.equal(first.result.status, 'pending');
  assert(first.prepared);
  // Reconstruct the runtime pool after the lost acknowledgement, like host recovery.
  await database.pool.end();
  database = await createFixtureDatabase(await fixtureDatabaseConfig());
  const restored = new MailConnector({
    ...options,
    store: new MailStore(database, f.artifacts),
    fixtureReader: () => {
      throw Error('PROVIDER_MUST_NOT_BE_REPLAYED');
    },
  });
  assert.equal((await restored.refresh(f.context, f.binding.id, id, first.prepared)).result.status, 'ok');
  assert.equal(
    (await admin.query('SELECT current_capture FROM cos.mail_states WHERE scope_id=$1', [f.scope])).rows[0]
      .current_capture,
    id,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM cos.mail_captures WHERE scope_id=$1 AND metadata->>'contract'='cos-mail-capture/v1'",
        [f.scope],
      )
    ).rows[0].n,
    1,
  );
});
test('G04 host access-loss updates are monotonic, close exposed evidence and remain available while paused', async () => {
  const f = await publishFixture();
  assert.equal((await f.knowledge.search(f.context, { query: 'alpha' })).status, 'ok');
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [f.scope]);
  assert.equal((await f.store.setAuth(f.context, f.binding.id, 'revoked')).status, 'ok');
  const first = (await admin.query('SELECT auth,version FROM cos.mail_bindings WHERE scope_id=$1', [f.scope])).rows[0];
  assert.equal(first.auth, 'revoked');
  assert.equal(first.version, 2);
  assert.equal((await f.store.setAuth(f.context, f.binding.id, 'expired')).status, 'ok');
  assert.equal((await f.store.setAuth(f.context, f.binding.id, 'ready' as never)).status, 'denied');
  assert.deepEqual(
    (await admin.query('SELECT auth,version FROM cos.mail_bindings WHERE scope_id=$1', [f.scope])).rows[0],
    first,
  );
  await admin.query("UPDATE cos.scopes SET status='active' WHERE id=$1", [f.scope]);
  assert.equal((await f.knowledge.contextReady(f.context)).status, 'denied');
  assert.equal((await f.store.start(f.context, f.binding.id, randomUUID(), f.prepared.window)).status, 'denied');
  assert.equal((await f.store.maintain(f.context, f.binding.id, randomUUID())).status, 'ok');
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0].n,
    0,
  );
});
test('G04 typed mail search ranks only the selected binding and thread reads carry captured message references', async () => {
  const f = await publishFixture();
  fs.writeFileSync(f.root + '/staging/note.md', 'alpha alpha alpha alpha alpha alpha alpha', { mode: 0o600 });
  assert.equal(
    (
      await f.knowledge.importSource(f.context, randomUUID(), {
        sourceKey: 'unrelated-note',
        filename: 'note.md',
        title: 'Unrelated note',
        processingProviders: ['codex'],
        expectedVersion: 0,
      })
    ).status,
    'ok',
  );
  const view = new MailView({ store: f.store, knowledge: f.knowledge, enabled: () => true, assertOpen: () => {} });
  const found = await view.search(f.context, { binding_id: f.binding.id, query: 'alpha', limit: 1 });
  assert.equal(found.status, 'ok');
  assert.equal((found.items as Array<{ message_id: string }>)[0]?.message_id, 'aa01');
  assert.equal(JSON.stringify(found).includes('Unrelated note'), false);
  const thread = await view.thread(f.context, { binding_id: f.binding.id, thread_id: 'bb01' });
  assert.equal(thread.status, 'ok');
  const message = (
    thread.items as Array<{ message_id: string; evidence: Array<{ evidence_id: string; text: string }> }>
  )[0];
  assert.equal(message.message_id, 'aa01');
  assert(message.evidence.every((ref) => typeof ref.evidence_id === 'string'));
  assert.match(message.evidence.map((ref) => ref.text).join('\n'), /project alpha/);
  assert.match(String(thread.freshness_notice), /Last successful refresh/);
  const absent = await view.thread(f.context, { binding_id: f.binding.id, thread_id: 'ff01' });
  assert.equal(absent.status, 'ok');
  assert.deepEqual(absent.items, []);
  assert.match(String(absent.freshness_notice), /does not establish that the inbox is empty/);
  assert.equal((await view.search(f.context, { binding_id: randomUUID(), query: 'alpha' })).status, 'denied');
  const foreign = { ...f.context, ownerId: 'foreign-owner', generation: randomUUID() };
  assert.equal((await view.thread(foreign, { binding_id: f.binding.id, thread_id: 'bb01' })).status, 'denied');
  await admin.query(
    "UPDATE cos.mail_messages SET message=jsonb_set(message,'{labels}','[\"TRASH\"]') WHERE scope_id=$1",
    [f.scope],
  );
  const fresh = { ...f.context, generation: randomUUID() },
    excluded = await view.thread(fresh, { binding_id: f.binding.id, thread_id: 'bb01' });
  assert.equal(excluded.status, 'ok');
  assert.deepEqual(excluded.items, []);
  assert.equal(excluded.omitted_messages, 1);
  assert.equal(JSON.stringify(excluded).includes('project alpha'), false);
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
    selection_id: (await admin.query('SELECT selection_id FROM cos.mail_messages WHERE scope_id=$1', [f.scope])).rows[0]
      .selection_id,
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
