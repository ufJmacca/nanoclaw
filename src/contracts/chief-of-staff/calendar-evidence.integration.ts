import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { before, after, test, mock } from 'node:test';
import pg from 'pg';
import { fixtureDatabaseConfig, connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { KnowledgeStore, type KnowledgeContext, type Evidence } from '../../modules/chief-of-staff/knowledge/store.js';
import { CalendarStore } from '../../modules/chief-of-staff/calendar/store.js';
import { CalendarEvidence } from '../../modules/chief-of-staff/calendar/evidence.js';
import { CalendarAccessFences } from '../../modules/chief-of-staff/calendar/access-fences.js';
import { fixtureCalendarReader } from '../../modules/chief-of-staff/calendar/fixture-reader.js';
import { collectCalendarSnapshot } from '../../modules/chief-of-staff/calendar/snapshot.js';
import { GOOGLE_EVENT_READ_SCOPE, CalendarReadError } from '../../modules/chief-of-staff/calendar/reader.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { connectionFault } from './connection-fault.js';
import { setTimeout as delay } from 'node:timers/promises';
import { CalendarConnector } from '../../modules/chief-of-staff/calendar/connector.js';
import { CalendarView } from '../../modules/chief-of-staff/calendar/view.js';
import { runCalendarAccountAdmin } from '../../modules/chief-of-staff/ops/calendar-account-admin.js';
import { runCalendarAdmin } from '../../modules/chief-of-staff/ops/calendar-admin.js';
import { writeAtomic } from '../../modules/chief-of-staff/ops/target-state.js';
import type { StorageInspection } from '../../modules/chief-of-staff/calendar/storage-protection.js';
import type { CosBinding } from '../../cos-boundary.js';
const scope = 'calendar-evidence-' + randomUUID();
const context: KnowledgeContext = {
  scopeId: scope,
  ownerId: 'fixture-owner',
  agentGroupId: scope,
  sessionId: scope,
  ingressId: randomUUID(),
  provider: 'codex',
  generation: randomUUID(),
};
const fresh = () => ({ ...context, generation: randomUUID() });
const window = { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-10T00:00:00Z', timeZone: 'Australia/Sydney' };
let admin: pg.Client,
  pool: pg.Pool,
  database: BoundedDatabase,
  calendar: CalendarStore,
  knowledge: KnowledgeStore,
  artifacts: KnowledgeArtifacts,
  fences: CalendarAccessFences,
  base: string;
const calendarAccess = (scopeId: string, bindingId: string) => {
  fences.assertOpen(scopeId, bindingId);
  return true;
};
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  pool = new pg.Pool(await fixtureDatabaseConfig());
  database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-calendar-evidence-'));
  for (const name of ['artifacts', 'staging', 'fences']) fs.mkdirSync(path.join(base, name), { mode: 0o700 });
  artifacts = new KnowledgeArtifacts(path.join(base, 'artifacts'), path.join(base, 'staging'));
  fences = CalendarAccessFences.initialize(path.join(base, 'fences'));
  knowledge = new KnowledgeStore(database, artifacts, {}, { calendarAccess, calendarEnabled: () => true });
  calendar = new CalendarStore(database, {}, new CalendarEvidence(artifacts));
  await pool.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture-instance',$1,$1,'active')",
    [scope],
  );
});
after(async () => {
  if (pool) {
    await pool.query('UPDATE cos.calendar_states SET current_snapshot=NULL,last_attempt=NULL WHERE scope_id=$1', [
      scope,
    ]);
    await pool.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
    for (const table of [
      'calendar_event_revisions',
      'calendar_observations',
      'calendar_snapshots',
      'calendar_states',
      'calendar_bindings',
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
      'proposals',
    ])
      await pool.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    await pool.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
    await pool.end();
  }
  await database?.pool.end();
  await admin?.end();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});
const event = (summary: string) => ({
  id: 'meeting',
  etag: 'v1',
  summary,
  start: { date: '2026-10-04' },
  end: { date: '2026-10-05' },
});
async function setup(summary: string, id = randomUUID()) {
  assert.equal(
    (
      await calendar.bind(context, {
        id,
        provider: 'fixture',
        calendarIds: ['selected'],
        scopes: [GOOGLE_EVENT_READ_SCOPE],
        timeZone: window.timeZone,
        processingProviders: ['codex'],
      })
    ).status,
    'ok',
  );
  return {
    id,
    fixture: fixtureCalendarReader({
      access: { generation: id + ':1', calendarIds: ['selected'], scopes: [GOOGLE_EVENT_READ_SCOPE], auth: 'ready' },
      calendars: { selected: [event(summary)] },
    }),
  };
}
async function publish(s: Awaited<ReturnType<typeof setup>>) {
  const id = randomUUID();
  await calendar.start(context, s.id, 'selected', id, window);
  const snapshot = await collectCalendarSnapshot(s.fixture.reader, 'selected', window);
  const result = await calendar.publish(context, s.id, id, snapshot);
  assert.equal(result.status, 'ok');
  return { id, snapshot, result };
}
async function find(text: string, ctx = fresh()) {
  const result = await knowledge.search(ctx, { query: text });
  assert.equal(result.status, 'ok');
  const row = (result.items as Evidence[])[0];
  assert.ok(row, 'calendar evidence missing');
  return { row, ctx };
}
test('S03 operator flow: explicit loopback link, selected sync, stable retry and local/database disconnect', async () => {
  const fixtureRoot = path.join(base, 'operator');
  fs.mkdirSync(fixtureRoot, { mode: 0o700 });
  const roots = {
      targetRoot: fixtureRoot + '/state',
      installationRoot: fixtureRoot + '/app',
      dataRoot: fixtureRoot + '/data',
    },
    backupRoot = fixtureRoot + '/backup';
  for (const root of [...Object.values(roots), backupRoot, roots.targetRoot + '/calendar'])
    fs.mkdirSync(root, { mode: 0o700 });
  writeAtomic(roots.targetRoot + '/calendar', 'oauth-client.json', {
    clientId: 'fixture.apps.googleusercontent.com',
    clientSecret: 'OPERATOR_CLIENT_CANARY',
  });
  const inspect: StorageInspection = (command, args) =>
    JSON.stringify(
      command.endsWith('/findmnt')
        ? {
            filesystems: [
              {
                target: args[args.indexOf('--target') + 1],
                source: '/dev/mapper/fixture',
                fstype: 'ext4',
                'maj:min': '253:0',
                uuid: 'operator-fixture-storage',
              },
            ],
          }
        : {
            blockdevices: [
              { name: '/dev/mapper/fixture', type: 'crypt', 'maj:min': '253:0', uuid: 'operator-fixture-storage' },
            ],
          },
    );
  const requests: string[] = [];
  const transport = async (url: string, init: RequestInit) => {
    requests.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(init.method, 'POST');
      return new Response(
        JSON.stringify({
          access_token: 'OPERATOR_ACCESS_CANARY',
          refresh_token: 'OPERATOR_REFRESH_CANARY',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: GOOGLE_EVENT_READ_SCOPE,
        }),
      );
    }
    assert.equal(new URL(url).origin, 'https://www.googleapis.com');
    assert.equal(new URL(url).pathname, '/calendar/v3/calendars/selected/events');
    assert.equal(init.method, 'GET');
    return new Response(JSON.stringify({ accessRole: 'reader', items: [event('OperatorCalendarFixtureCanary')] }));
  };
  const connect = async () => new PriorityStore(BoundedDatabase.fromConfig(await fixtureDatabaseConfig()));
  const dependencies = {
    inspect,
    memory: () => {}, // Offline synthetic storage fixture; actual kernel memory checks have their own gate.
    fetch: transport,
    connect,
    artifacts: () => artifacts,
    display: async (url: string) => {
      const auth = new URL(url),
        callback = new URL(auth.searchParams.get('redirect_uri')!);
      callback.searchParams.set('code', 'fixture-code');
      callback.searchParams.set('state', auth.searchParams.get('state')!);
      const response = await fetch(callback);
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), /CANARY/);
    },
  };
  const options = {
    roots,
    env: { COS_CALENDAR_ENABLED: 'true' },
    binding: {
      scopeId: scope,
      ownerId: context.ownerId,
      agentGroupId: scope,
      sessionId: scope,
      provider: 'codex',
    } as CosBinding,
    check: async () => {},
    assertAuthority: () => {},
  };
  const configured = await runCalendarAccountAdmin(
    { ...options, args: { command: 'calendar-setup', scopeId: scope, requestId: randomUUID(), backupRoot } },
    dependencies,
  );
  assert.equal(configured.status, 'configured_paused');
  const bindingId = randomUUID();
  writeAtomic(roots.targetRoot, 'selection.json', {
    calendarIds: ['selected'],
    timeZone: window.timeZone,
    processingProviders: ['codex'],
  });
  const link = {
    command: 'calendar-link' as const,
    scopeId: scope,
    bindingId,
    requestId: randomUUID(),
    manifestFile: roots.targetRoot + '/selection.json',
  };
  assert.equal((await runCalendarAccountAdmin({ ...options, args: link }, dependencies)).status, 'ok');
  assert.equal((await runCalendarAccountAdmin({ ...options, args: link }, dependencies)).status, 'ok');
  assert.equal(requests.length, 1);
  writeAtomic(roots.targetRoot, 'sync.json', { calendarId: 'selected', window });
  const sync = {
    command: 'calendar-sync' as const,
    scopeId: scope,
    bindingId,
    requestId: randomUUID(),
    manifestFile: roots.targetRoot + '/sync.json',
  };
  assert.equal((await runCalendarAdmin({ ...options, args: sync }, dependencies)).status, 'ok');
  assert.equal((await runCalendarAdmin({ ...options, args: sync }, dependencies)).status, 'ok');
  assert.equal(requests.length, 2);
  const [snapshot] = (
    await pool.query('SELECT status FROM cos.calendar_snapshots WHERE scope_id=$1 AND id=$2', [scope, sync.requestId])
  ).rows;
  assert.equal(snapshot.status, 'complete');
  const rows = (
    await pool.query('SELECT event FROM cos.calendar_event_revisions WHERE scope_id=$1 AND binding_id=$2', [
      scope,
      bindingId,
    ])
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event.summary, 'OperatorCalendarFixtureCanary');
  const disconnected = await runCalendarAdmin(
    {
      ...options,
      env: {},
      args: { command: 'calendar-disconnect', scopeId: scope, bindingId, requestId: randomUUID() },
    },
    dependencies,
  );
  assert.equal(disconnected.status, 'ok');
  assert.equal(disconnected.local_access, 'denied');
  const recorded = await calendar.connection(context, bindingId);
  assert.equal((recorded.binding as { auth: string }).auth, 'disconnected');
  assert.throws(
    () => new CalendarAccessFences(roots.targetRoot + '/calendar/access-denials').assertOpen(scope, bindingId),
    /calendar_auth_disconnected/,
  );
  await assert.rejects(runCalendarAccountAdmin({ ...options, args: link }, dependencies), /calendar_auth_disconnected/);
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify([configured, disconnected]), /CANARY|refreshToken|clientSecret/);
});
test('S03-T10: checked calendar notices survive replay but expire on refresh and access changes, even without event citations', async () => {
  const s = await setup('CoverageNoticeCanary');
  await publish(s);
  const ctx = fresh(),
    request = randomUUID();
  const draft = { kind: 'answer', coverage: 'insufficient', claims: [], calendar: 'coverage' };
  const first = await knowledge.answers.prepare(ctx, request, draft);
  assert.equal(first.status, 'ok');
  assert.match(String(first.text), /Calendar coverage/);
  assert.match(String(first.text), /Last successful refresh:/);
  assert.match(String(first.text), /Australia\/Sydney/);
  assert.doesNotMatch(String(first.text), /CoverageNoticeCanary|credential|nothing scheduled/);
  assert.equal((await knowledge.answers.prepare(ctx, request, draft)).text, first.text);
  assert.equal((await knowledge.answers.authorizePublication(ctx, String(first.text))).status, 'ok');
  const pending = randomUUID();
  await calendar.start(context, s.id, 'selected', pending, window);
  assert.equal((await knowledge.answers.get(ctx, String(first.artifact_id))).status, 'denied');
  assert.equal((await knowledge.answers.authorizePublication(ctx, String(first.text))).status, 'denied');
  assert.equal((await knowledge.contextReady(ctx)).status, 'denied');
  const incompleteContext = fresh();
  const incomplete = await knowledge.answers.prepare(incompleteContext, randomUUID(), draft);
  assert.equal(incomplete.status, 'ok');
  assert.match(String(incomplete.text), /refresh is incomplete/);
  fences.deny(scope, s.id, 'revoked');
  assert.equal((await knowledge.answers.get(incompleteContext, String(incomplete.artifact_id))).status, 'denied');
  const disconnected = await knowledge.answers.prepare(fresh(), randomUUID(), draft);
  assert.equal(disconnected.status, 'ok');
  assert.match(String(disconnected.text), /access is unavailable/);
  assert.doesNotMatch(String(disconnected.text), /nothing scheduled/);
});
test('S03-T02/T03: snapshot events become S02 evidence with immutable exact-line citations and no duplicate revisions', async () => {
  const s = await setup('CalendarCitationCanary');
  const first = await publish(s);
  const { row } = await find('CalendarCitationCanary');
  assert.ok(row.text.includes('CalendarCitationCanary'));
  assert.equal(row.locator_format, 'normalized-utf8-lines/v1');
  await publish(s);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE scope_id=$1 AND source_id=$2', [
        scope,
        row.source_id,
      ])
    ).rows[0].n,
    1,
  );
  assert.deepEqual(await calendar.publish(context, s.id, first.id, first.snapshot), first.result);
  assert.equal(
    (
      await pool.query('SELECT source_id FROM cos.calendar_observations WHERE scope_id=$1 AND binding_id=$2', [
        scope,
        s.id,
      ])
    ).rows[0].source_id,
    row.source_id,
  );
});
test('S03-T05/T10: empty-calendar notices are rechecked after local access loss during final disclosure', async () => {
  const s = await setup('EmptyNoticeRace');
  s.fixture.replace('selected', []);
  await publish(s);
  const guarded = new KnowledgeStore(
    database,
    artifacts,
    {
      beforeAnswerDisclosure: async () => fences.deny(scope, s.id, 'revoked'),
    },
    { calendarAccess, calendarEnabled: () => true },
  );
  const result = await guarded.answers.prepare(fresh(), randomUUID(), {
    kind: 'answer',
    coverage: 'insufficient',
    claims: [],
    calendar: 'coverage',
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.text, undefined);
});
test('S03-T04/T10: notices enforce owner/provider identity and retrieval disablement', async () => {
  const draft = { kind: 'answer', coverage: 'insufficient', claims: [], calendar: 'coverage' };
  assert.equal(
    (await knowledge.answers.prepare({ ...fresh(), ownerId: 'foreign' }, randomUUID(), draft)).status,
    'denied',
  );
  const ctx = { ...fresh(), provider: 'claude' };
  const empty = await knowledge.answers.prepare(ctx, randomUUID(), draft);
  assert.equal(empty.status, 'ok');
  assert.match(String(empty.text), /no calendar is connected/);
  assert.doesNotMatch(String(empty.text), /selected|Australia\/Sydney/);
  let enabled = false;
  const disabled = new KnowledgeStore(database, artifacts, {}, { calendarAccess, calendarEnabled: () => enabled });
  const disabledContext = { ...ctx, generation: randomUUID() };
  const result = await disabled.answers.prepare(disabledContext, randomUUID(), draft);
  assert.equal(result.status, 'ok');
  assert.match(String(result.text), /retrieval is disabled/);
  enabled = true;
  assert.equal((await disabled.answers.get(disabledContext, String(result.artifact_id))).status, 'denied');
});
test('S03-T05: corrections fence exposed contexts, quarantine derived answers and provide only the new revision', async () => {
  const s = await setup('CalendarCorrectionCanary old meeting');
  await publish(s);
  const { row, ctx } = await find('CalendarCorrectionCanary');
  const answer = await knowledge.answers.prepare(ctx, randomUUID(), {
    kind: 'answer',
    coverage: 'limited',
    claims: [
      {
        kind: 'inference',
        text: 'Prepare for the meeting.',
        citations: [{ kind: 'source', evidence_id: row.evidence_id }],
      },
    ],
  });
  assert.equal(answer.status, 'ok');
  s.fixture.replace('selected', [event('CalendarCorrectionCanary corrected meeting')]);
  await publish(s);
  assert.equal((await knowledge.contextReady(ctx)).status, 'denied');
  const current = await find('CalendarCorrectionCanary');
  assert.notEqual(current.row.revision_id, row.revision_id);
  assert.ok(current.row.text.includes('corrected'));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM cos.artifacts WHERE scope_id=$1 AND kind='answer' AND lifecycle='quarantined'",
        [scope],
      )
    ).rows[0].n,
    1,
  );
  assert.ok(
    (await pool.query("SELECT id FROM cos.outbox WHERE scope_id=$1 AND kind='knowledge_invalidate'", [scope]))
      .rowCount! > 0,
  );
});
test('S03-T01/T05: cancellation and successful omission hide event evidence while retaining source history', async () => {
  for (const cancelled of [false, true]) {
    const term = cancelled ? 'CalendarCancelledCanary' : 'CalendarMissingCanary',
      s = await setup(term);
    await publish(s);
    const { ctx, row } = await find(term);
    s.fixture.replace('selected', cancelled ? [{ id: 'meeting', status: 'cancelled' }] : []);
    await publish(s);
    assert.equal((await knowledge.contextReady(ctx)).status, 'denied');
    assert.deepEqual((await knowledge.search(fresh(), { query: term })).items, []);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE scope_id=$1 AND source_id=$2', [
          scope,
          row.source_id,
        ])
      ).rows[0].n,
      1,
    );
  }
});
test('S03-T05: binding revocation retains access tombstones and hides cached event evidence', async () => {
  const s = await setup('CalendarRevocationCanary');
  await publish(s);
  const { row, ctx } = await find('CalendarRevocationCanary');
  await calendar.setAuth(context, s.id, 'revoked');
  assert.equal((await knowledge.contextReady(ctx)).status, 'denied');
  assert.deepEqual((await knowledge.search(fresh(), { query: 'CalendarRevocationCanary' })).items, []);
  assert.equal(
    (
      await pool.query('SELECT kind FROM cos.revocation_tombstones WHERE scope_id=$1 AND source_id=$2', [
        scope,
        row.source_id,
      ])
    ).rows[0].kind,
    'revoke',
  );
});
async function answerFor(ctx: KnowledgeContext, row: Evidence) {
  const result = await knowledge.answers.prepare(ctx, randomUUID(), {
    kind: 'answer',
    coverage: 'limited',
    claims: [
      {
        kind: 'inference',
        text: 'Prepare for the meeting.',
        citations: [{ kind: 'source', evidence_id: row.evidence_id }],
      },
    ],
  });
  assert.equal(result.status, 'ok');
  return String(result.artifact_id);
}
test('S03-T05: durable local denial alone fences search, direct reads, contexts, historical answers and publication', async () => {
  const s = await setup('CalendarLocalFenceCanary');
  await publish(s);
  const { row, ctx } = await find('CalendarLocalFenceCanary');
  const id = await answerFor(ctx, row);
  const read = await knowledge.answers.get(ctx, id);
  assert.equal(read.status, 'ok');
  fences.deny(scope, s.id, 'revoked');
  // Simulates remote invalidation failing: database state is still ready/current.
  assert.equal(
    (await pool.query('SELECT auth FROM cos.calendar_bindings WHERE scope_id=$1 AND id=$2', [scope, s.id])).rows[0]
      .auth,
    'ready',
  );
  assert.deepEqual((await knowledge.search(fresh(), { query: 'CalendarLocalFenceCanary' })).items, []);
  assert.equal((await knowledge.get(fresh(), row.source_id, row.revision_id, row.ordinal)).status, 'denied');
  assert.equal((await knowledge.contextReady(ctx)).status, 'denied');
  assert.equal((await knowledge.answers.get(fresh(), id)).status, 'denied');
  assert.equal((await knowledge.answers.authorizePublication(ctx, String(read.text))).status, 'denied');
});
test('S03-T05: unconfigured guard denies calendar evidence and revocation during disclosure closes late output', async () => {
  const s = await setup('CalendarLateFenceCanary');
  await publish(s);
  const { row, ctx } = await find('CalendarLateFenceCanary');
  const id = await answerFor(ctx, row);
  const unconfigured = new KnowledgeStore(database, artifacts);
  assert.deepEqual((await unconfigured.search(fresh(), { query: 'CalendarLateFenceCanary' })).items, []);
  assert.equal((await unconfigured.answers.get(fresh(), id)).status, 'denied');
  const late = new KnowledgeStore(
    database,
    artifacts,
    {
      beforeDisclosure: async () => {
        fences.deny(scope, s.id, 'disconnected');
      },
    },
    { calendarAccess },
  );
  assert.equal((await late.search(fresh(), { query: 'CalendarLateFenceCanary' })).status, 'denied');
  const second = await setup('CalendarLateAnswerCanary');
  await publish(second);
  const evidence = await find('CalendarLateAnswerCanary');
  const secondId = await answerFor(evidence.ctx, evidence.row);
  const lateAnswer = new KnowledgeStore(
    database,
    artifacts,
    {
      beforeAnswerDisclosure: async () => {
        fences.deny(scope, second.id, 'expired');
      },
    },
    { calendarAccess },
  );
  assert.equal((await lateAnswer.answers.get(fresh(), secondId)).status, 'denied');
});
test('S03-T04: a staging-file import cannot overwrite connector-owned source identity', async () => {
  const s = await setup('CalendarImportFenceCanary');
  await publish(s);
  const { row } = await find('CalendarImportFenceCanary');
  const key = (
    await pool.query('SELECT source_key FROM cos.sources WHERE scope_id=$1 AND id=$2', [scope, row.source_id])
  ).rows[0].source_key;
  fs.writeFileSync(path.join(base, 'staging', 'overwrite.txt'), 'Injected source replacement', { mode: 0o600 });
  const result = await knowledge.importSource(context, randomUUID(), {
    sourceKey: key,
    filename: 'overwrite.txt',
    title: 'Replacement',
    processingProviders: ['codex'],
    expectedVersion: row.source_version,
  });
  assert.equal(result.status, 'denied');
  assert.equal((await find('CalendarImportFenceCanary')).row.revision_id, row.revision_id);
});
test('S03-T05: historical answers retain uncited calendar context dependencies', async () => {
  const hidden = await setup('CalendarImplicitDependencyCanary');
  await publish(hidden);
  const cited = await setup('CalendarExplicitDependencyCanary');
  await publish(cited);
  const ctx = fresh();
  await find('CalendarImplicitDependencyCanary', ctx);
  const { row } = await find('CalendarExplicitDependencyCanary', ctx);
  const id = await answerFor(ctx, row);
  assert.equal((await knowledge.answers.get(fresh(), id)).status, 'ok');
  fences.deny(scope, hidden.id, 'revoked');
  assert.equal((await knowledge.answers.get(fresh(), id)).status, 'denied');
  assert.equal((await find('CalendarExplicitDependencyCanary')).row.source_id, row.source_id);
});
test('S03-PG01/PG02: lost database connection rolls back snapshot, evidence correction and answer invalidation together', async () => {
  const s = await setup('CalendarAtomicEvidenceCanary original');
  const first = await publish(s);
  const { row, ctx } = await find('CalendarAtomicEvidenceCanary');
  const answer = await answerFor(ctx, row);
  s.fixture.replace('selected', [event('CalendarAtomicEvidenceCanary corrected')]);
  const attempt = randomUUID();
  await calendar.start(context, s.id, 'selected', attempt, window);
  const snapshot = await collectCalendarSnapshot(s.fixture.reader, 'selected', window);
  const relay = await connectionFault(await fixtureDatabaseConfig());
  const brokenDatabase = new BoundedDatabase(new pg.Pool(relay.config), 350);
  let inject = true;
  const fault = new CalendarStore(
    brokenDatabase,
    {
      beforePublishCommit: async () => {
        if (inject) relay.partition();
      },
    },
    new CalendarEvidence(artifacts),
  );
  try {
    assert.equal((await fault.publish(context, s.id, attempt, snapshot)).status, 'pending');
    const read = await calendar.read(context, s.id, 'selected');
    assert.equal(read.snapshot_id, first.id);
    assert.equal(read.coverage, 'incomplete');
    assert.equal((await find('CalendarAtomicEvidenceCanary')).row.revision_id, row.revision_id);
    assert.equal((await knowledge.answers.get(ctx, answer)).status, 'ok');
    relay.restore();
    inject = false;
    await delay(1100);
    const recovered = await fault.publish(context, s.id, attempt, snapshot);
    assert.equal(recovered.status, 'ok');
    assert.deepEqual(await fault.publish(context, s.id, attempt, snapshot), recovered);
    assert.equal((await knowledge.answers.get(fresh(), answer)).status, 'denied');
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE scope_id=$1 AND source_id=$2', [
          scope,
          row.source_id,
        ])
      ).rows[0].n,
      2,
    );
  } finally {
    await brokenDatabase.pool.end();
    await relay.close();
  }
});
test('S03-T05: refresh never resurrects an owner-revoked calendar source', async () => {
  const s = await setup('CalendarOwnerRevokedCanary');
  await publish(s);
  const { row } = await find('CalendarOwnerRevokedCanary');
  const priorities = new PriorityStore(database, knowledge);
  const proposed = await priorities.propose(context, randomUUID(), {
    kind: 'source_revoke',
    source_id: row.source_id,
    expected_version: row.source_version,
    reason: 'Fixture owner withdrew source',
  });
  assert.equal(proposed.status, 'ok');
  assert.equal(
    (
      await priorities.decide(
        { ...context, ingressId: randomUUID() },
        String(proposed.proposal_id),
        String(proposed.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  assert.equal((await priorities.apply(scope, String(proposed.proposal_id))).status, 'ok');
  s.fixture.replace('selected', [event('CalendarOwnerRevokedCanary new event text')]);
  await publish(s);
  assert.deepEqual((await knowledge.search(fresh(), { query: 'CalendarOwnerRevokedCanary' })).items, []);
  const observed = await calendarView().read(fresh(), readInput(s.id));
  assert.equal(observed.coverage, 'incomplete');
  assert.equal(observed.warning, 'calendar_evidence_unavailable');
  assert.deepEqual(observed.items, []);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE scope_id=$1 AND source_id=$2', [
        scope,
        row.source_id,
      ])
    ).rows[0].n,
    1,
  );
});
test('S03-T04/T05: the connector reads scoped binding metadata and refreshes/disconnects through the real host stores', async () => {
  const s = await setup('CalendarConnectedHostCanary');
  const configured = await calendar.connection(context, s.id);
  assert.equal(configured.status, 'ok');
  assert.equal(JSON.stringify(configured).includes('credentialRef'), false);
  assert.equal((await calendar.connection({ ...context, ownerId: 'foreign' }, s.id)).status, 'denied');
  const connector = new CalendarConnector({
    store: calendar,
    fences,
    admitted: () => true,
    fixtureReader: () => s.fixture.reader,
  });
  assert.equal((await connector.refresh(context, s.id, 'selected', randomUUID(), window)).result.status, 'ok');
  const { ctx } = await find('CalendarConnectedHostCanary');
  assert.equal((await connector.disconnect(context, s.id)).status, 'ok');
  assert.equal((await knowledge.contextReady(ctx)).status, 'denied');
  assert.equal((await calendar.connection(context, s.id)).status, 'ok');
  assert.throws(() => connector.assertOpen(scope, s.id), /calendar_auth_disconnected/);
});
test('S03-T05/PG02: denial-write failure cannot reopen cached calendar evidence after host reconstruction', async () => {
  const s = await setup('CalendarReconstructedDenialCanary');
  await publish(s);
  const { ctx, row } = await find('CalendarReconstructedDenialCanary');
  const id = await answerFor(ctx, row),
    open = fs.openSync;
  const connector = new CalendarConnector({
    store: calendar,
    fences,
    admitted: () => true,
    fixtureReader: () => ({
      ...s.fixture.reader,
      list: async () => {
        mock.method(fs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, ...args: [fs.Mode?]) => {
          if (String(file).endsWith('.json') && flags === 'wx') throw new Error('PRIVATE_IO_CANARY');
          return open(file, flags, ...args);
        });
        throw new CalendarReadError('calendar_auth_revoked');
      },
    }),
  });
  try {
    const result = await connector.refresh(context, s.id, 'selected', randomUUID(), window);
    assert.equal(result.result.status, 'unavailable');
    assert.equal(result.result.code, 'calendar_access_fence_failed');
  } finally {
    mock.restoreAll();
  }
  assert.equal(
    (await pool.query('SELECT auth FROM cos.calendar_bindings WHERE scope_id=$1 AND id=$2', [scope, s.id])).rows[0]
      .auth,
    'ready',
  );
  const rebuilt = new CalendarAccessFences(path.join(base, 'fences'));
  const restarted = new KnowledgeStore(
    database,
    artifacts,
    {},
    {
      calendarAccess: (scopeId, bindingId) => {
        rebuilt.assertOpen(scopeId, bindingId);
        return true;
      },
    },
  );
  assert.deepEqual((await restarted.search(fresh(), { query: 'CalendarReconstructedDenialCanary' })).items, []);
  assert.equal((await restarted.contextReady(ctx)).status, 'denied');
  assert.equal((await restarted.answers.get(fresh(), id)).status, 'denied');
});
const calendarView = () =>
  new CalendarView({
    store: calendar,
    knowledge,
    assertOpen: (scopeId, bindingId) => fences.assertOpen(scopeId, bindingId),
    enabled: () => true,
  });
const readInput = (id: string) => ({
  binding_id: id,
  calendar_id: 'selected',
  time_min: window.timeMin,
  time_max: window.timeMax,
});
test('S03-T02/T08: bounded calendar view returns ordered events with checked citations and excludes long descriptions', async () => {
  const s = await setup('CalendarViewCanary');
  s.fixture.replace(
    'selected',
    Array.from({ length: 7 }, (_, i) => ({
      ...event('CalendarViewCanary ' + i),
      id: 'event-' + i,
      description: 'PRIVATE_LONG_DESCRIPTION_CANARY ' + 'x'.repeat(15000),
      start: { date: '2026-10-0' + (i + 2) },
      end: { date: '2026-10-0' + (i + 3) },
    })).reverse(),
  );
  await publish(s);
  const ctx = fresh(),
    result = await calendarView().read(ctx, { ...readInput(s.id), limit: 2, offset: 2 });
  assert.equal(result.status, 'ok');
  assert.equal(result.coverage, 'complete');
  assert.equal(result.next_offset, 4);
  const items = result.items as Array<{ summary: string; start: unknown; end: unknown; evidence: Evidence }>;
  assert.deepEqual(
    items.map((item) => item.summary),
    ['CalendarViewCanary 2', 'CalendarViewCanary 3'],
  );
  assert.deepEqual(items[0].start, { kind: 'date', date: '2026-10-04' });
  assert.ok(items[0].evidence.text.includes('2026-10-04'));
  assert.ok(items[0].evidence.text.includes('CalendarViewCanary 2'));
  assert.ok(items[0].evidence.evidence_id);
  assert.equal(JSON.stringify(result).includes('PRIVATE_LONG_DESCRIPTION_CANARY'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16000);
  const answer = await answerFor(ctx, items[0].evidence);
  assert.equal((await knowledge.answers.get(ctx, answer)).status, 'ok');
});
test('S03-T04/T10: calendar view preserves incomplete and unavailable coverage instead of claiming an empty day', async () => {
  const s = await setup('CalendarViewCoverageCanary'),
    view = calendarView();
  const initial = await view.read(fresh(), readInput(s.id));
  assert.equal(initial.status, 'ok');
  assert.equal(initial.coverage, 'incomplete');
  assert.equal(initial.warning, 'calendar_not_synced');
  await publish(s);
  const outside = await view.read(fresh(), {
    ...readInput(s.id),
    time_min: '2026-11-01T00:00:00Z',
    time_max: '2026-11-02T00:00:00Z',
  });
  assert.equal(outside.status, 'ok');
  assert.equal(outside.coverage, 'incomplete');
  assert.equal(outside.warning, 'calendar_window_not_covered');
  assert.deepEqual(outside.items, []);
  fences.deny(scope, s.id, 'disconnected');
  const lost = await view.read(fresh(), readInput(s.id));
  assert.equal(lost.status, 'ok');
  assert.equal(lost.coverage, 'unavailable');
  assert.deepEqual(lost.items, []);
  assert.equal((await view.read({ ...fresh(), ownerId: 'foreign' }, readInput(s.id))).status, 'denied');
  assert.equal((await view.read({ ...fresh(), provider: 'claude' }, readInput(s.id))).status, 'denied');
});
test('S03-T04: calendar view rejects unbounded or forged requests before selection', async () => {
  const s = await setup('CalendarViewLimitCanary'),
    view = calendarView();
  await publish(s);
  for (const extra of [
    { limit: 6 },
    { offset: -1 },
    { time_min: 'bad' },
    { time_max: window.timeMin },
    { scope_id: 'foreign' },
    { timeZone: 'forged' },
    { method: 'DELETE' },
  ])
    assert.equal((await view.read(fresh(), { ...readInput(s.id), ...extra })).status, 'denied');
});
test('S03-T10: coverage inventory is bounded and exposes no credentials, events or foreign-provider calendars', async () => {
  const s = await setup('CalendarCoveragePrivateContentCanary');
  await publish(s);
  const result = await calendarView().coverage(fresh());
  assert.equal(result.status, 'ok');
  assert.ok((result.items as unknown[]).length <= 10);
  assert.equal(JSON.stringify(result).includes('CalendarCoveragePrivateContentCanary'), false);
  assert.equal(JSON.stringify(result).includes('credential'), false);
  assert.equal((await calendarView().coverage({ ...fresh(), ownerId: 'foreign' })).status, 'denied');
  const foreign = await calendarView().coverage({ ...fresh(), provider: 'claude' });
  assert.equal(foreign.coverage, 'not_connected');
  assert.deepEqual(foreign.items, []);
  const ids: string[] = [];
  let offset = 0;
  for (let pages = 0; pages < 10; pages++) {
    const page = await calendarView().coverage(fresh(), offset);
    assert.equal(page.status, 'ok');
    ids.push(...(page.items as Array<{ binding_id: string }>).map((item) => item.binding_id));
    if (page.next_offset === null) break;
    offset = Number(page.next_offset);
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    ids.length,
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM cos.calendar_bindings WHERE scope_id=$1 AND 'codex'=ANY(processing_providers)",
        [scope],
      )
    ).rows[0].n,
  );
});
test('S03-T01/T05: a changed snapshot cannot publish a stale empty calendar view', async () => {
  const s = await setup('CalendarViewRaceCanary');
  s.fixture.replace('selected', []);
  await publish(s);
  let calls = 0;
  const view = new CalendarView({
    store: {
      coverage: (...args) => calendar.coverage(...args),
      evidenceSnapshot: async (...args) => {
        const captured = await calendar.evidenceSnapshot(...args);
        if (++calls === 1) {
          s.fixture.replace('selected', [event('CalendarViewRaceCanary')]);
          await publish(s);
        }
        return captured;
      },
    },
    knowledge,
    assertOpen: (scopeId, binding) => fences.assertOpen(scopeId, binding),
    enabled: () => true,
  });
  const result = await view.read(fresh(), readInput(s.id));
  assert.ok(['conflict', 'denied'].includes(result.status));
  assert.equal(result.items, undefined);
});
test('S03-T05/T10: uncited calendar metadata fences future replies, including changes outside the displayed notice page', async () => {
  // The maximal v4 UUID sorts after the earlier random v4 bindings. Keep the changed binding
  // explicitly active; an arbitrary prior fixture may already be disconnected and reject start.
  const outside = await setup('OutsideNoticePage', 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  await publish(outside);
  const ctx = fresh();
  assert.equal((await calendarView().coverage(ctx)).status, 'ok');
  const draft = {
    kind: 'answer',
    coverage: 'not_applicable',
    claims: [],
    questions: ['Which meeting should we prepare for?'],
  };
  const prepared = await knowledge.answers.prepare(ctx, randomUUID(), draft);
  assert.equal(prepared.status, 'ok');
  assert.match(String(prepared.text), /Calendar coverage/);
  assert.match(String(prepared.text), /first 10/);
  const firstPage = await calendarView().coverage(fresh());
  assert.equal(
    (firstPage.items as Array<{ binding_id: string }>).some((row) => row.binding_id === outside.id),
    false,
  );
  assert.equal((await calendar.start(context, outside.id, 'selected', randomUUID(), window)).status, 'ok');
  assert.equal((await knowledge.contextReady(ctx)).status, 'denied');
  assert.equal((await knowledge.answers.prepare(ctx, randomUUID(), draft)).status, 'denied');
  assert.equal((await knowledge.answers.get(fresh(), String(prepared.artifact_id))).status, 'denied');
});
