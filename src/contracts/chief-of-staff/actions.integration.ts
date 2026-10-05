import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { digest, type Result } from '../../modules/chief-of-staff/domain/contracts.js';
import type { CalendarActionRequest } from '../../modules/chief-of-staff/contracts/action-protocol.js';
import {
  GOOGLE_CALENDAR_METADATA_SCOPE,
  GOOGLE_OWNED_EVENT_WRITE_SCOPE,
  type CalendarActionWriter,
  type CalendarWriterAccess,
  type CalendarWriterInspection,
} from '../../modules/chief-of-staff/actions/writer.js';

const scope = 'action-' + randomUUID(),
  writerId = randomUUID();
const context = { scopeId: scope, ownerId: 'owner', agentGroupId: scope, sessionId: scope, ingressId: randomUUID() };
const authority = {
  bindingDigest: digest('fixture private owner binding'),
  delegationDigest: digest('fixture delegation'),
  contextGeneration: randomUUID(),
  provider: {
    profile: 'codex_subscription_cos_research_v1' as const,
    model: 'fixture-codex',
    policyDigest: digest('fixture subscription policy'),
  },
};
const writerBinding = {
  format: 'cos-calendar-writer/v1',
  provider: 'fixture',
  calendarId: 'owner@example.test',
  accountFingerprint: digest('fixture calendar account'),
  credentialGeneration: 'fixture-credentials',
  instanceId: 'fixture',
  channelId: scope,
  bindingDigest: authority.bindingDigest,
  processingProvider: 'codex',
  restoreProofDigest: digest('fixture-only sandbox restore proof'),
  scopes: [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE],
};
let admin: pg.Client, store: PriorityStore, request: CalendarActionRequest;
let enabled = true,
  busy = false;
let access: CalendarWriterAccess = {
  generation: writerBinding.credentialGeneration,
  calendarId: writerBinding.calendarId,
  accountFingerprint: writerBinding.accountFingerprint,
  scopes: writerBinding.scopes,
  auth: 'ready',
  writeEnabled: true,
};
let writes = 0;
const writer: CalendarActionWriter = {
  access: async () => structuredClone(access),
  inspect: async (requested) =>
    ({
      complete: true,
      calendarId: requested.calendar_id,
      calendarTimeZone: 'UTC',
      generation: access.generation,
      accountFingerprint: access.accountFingerprint,
      ownershipDigest: digest('owned'),
      availabilityDigest: digest({ busy, start: requested.start, end: requested.end }),
      busy: busy
        ? [
            {
              start: { kind: 'instant', instant: requested.start, timeZone: requested.time_zone },
              end: { kind: 'instant', instant: requested.end, timeZone: requested.time_zone },
              eventDigest: digest('busy'),
            },
          ]
        : [],
      observedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
    }) as CalendarWriterInspection,
  create: async () => {
    writes++;
    throw new Error('fixture execution not yet requested');
  },
  get: async () => null,
};
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'owner','fixture',$1,$1,'active')",
    [scope],
  );
  await admin.query(
    "INSERT INTO cos.action_writer_bindings(scope_id,id,owner_id,session_id,version,state) VALUES($1,$2,'owner',$1,1,'enabled')",
    [scope, writerId],
  );
  await admin.query(
    'INSERT INTO cos.action_writer_revisions(scope_id,binding_id,version,body,digest,consent_ref) VALUES($1,$2,1,$3,$4,$5)',
    [scope, writerId, JSON.stringify(writerBinding), digest(writerBinding), 'fixture-only-explicit-consent'],
  );
  store = new PriorityStore(
    BoundedDatabase.fromConfig(await fixtureDatabaseConfig()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { authority: () => (enabled ? authority : null), writer: () => writer },
  );
  const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
  const instant = (offset: number) =>
    new Date(Math.floor((now + offset) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  request = {
    kind: 'calendar_block',
    binding_id: writerId,
    calendar_id: writerBinding.calendarId,
    start: instant(3600000),
    end: instant(7200000),
    time_zone: 'UTC',
    title: 'Focus work',
    description: '',
    project_id: null,
    mission_id: null,
    attendees: [],
  };
});
after(async () => {
  if (admin) {
    for (const table of [
      'action_receipts',
      'action_request_starts',
      'actions',
      'action_intents',
      'action_writer_revisions',
      'action_writer_bindings',
      'outbox',
      'events',
      'operations',
      'proposals',
      'records',
    ])
      await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=$1', [scope]);
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
  }
  await store?.database.pool.end();
  await admin?.end();
});
async function propose(input = request, id = randomUUID()) {
  return store.requestAction(context, id, input);
}
async function decide(proposal: Result, ownerId = context.ownerId, ingressId = randomUUID()) {
  return store.decide(
    { ...context, ownerId, ingressId },
    String(proposal.proposal_id),
    String(proposal.confirmation_token),
    'approve',
  );
}

test('S09-T01 exact action preview creates no effect before durable owner approval', async () => {
  assert.equal(typeof store.requestAction, 'function');
  const proposal = await propose();
  assert.equal(proposal.status, 'ok');
  assert.deepEqual((proposal.change as { request: unknown }).request, request);
  assert.equal((await store.apply(scope, String(proposal.proposal_id))).status, 'denied');
  assert.equal(writes, 0);
  assert.equal((await decide(proposal, 'other-owner')).status, 'denied');
  assert.equal((await decide(proposal)).status, 'ok');
  assert.equal(writes, 0);
  const applied = await store.apply(scope, String(proposal.proposal_id));
  assert.equal(applied.status, 'ok');
  const action = await store.actions.inspect(context, String(applied.record_id));
  assert.equal(action.state, 'queued');
  assert.equal(writes, 0);
});
test('S09-T04 simultaneous duplicate requests retain one immutable provider identity and proposal', async () => {
  const id = randomUUID();
  const proposals = await Promise.all(Array.from({ length: 5 }, () => propose(request, id)));
  assert.equal(proposals[0].status, 'ok');
  for (const proposal of proposals) assert.deepEqual(proposal, proposals[0]);
  assert.equal((await propose({ ...request, title: 'Changed later' }, id)).status, 'conflict');
  const actionId = (proposals[0].change as { action_id: string }).action_id;
  assert.equal(
    (
      await admin.query('SELECT count(*)::int AS n FROM cos.action_intents WHERE scope_id=$1 AND id=$2', [
        scope,
        actionId,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(writes, 0);
});
test('S09-T02 changed payload and binding resources cannot borrow the original approval', async () => {
  const proposal = await propose();
  assert.equal(proposal.status, 'ok');
  const change = { ...(proposal.change as object), request: { ...request, title: 'Unapproved change' } };
  await admin.query('UPDATE cos.proposals SET change=$2,payload_hash=$3 WHERE id=$1', [
    proposal.proposal_id,
    JSON.stringify(change),
    digest(change),
  ]);
  assert.equal((await decide(proposal)).status, 'denied');
  const other = await propose();
  assert.equal(other.status, 'ok');
  await admin.query('UPDATE cos.action_writer_bindings SET version=version+1 WHERE scope_id=$1 AND id=$2', [
    scope,
    writerId,
  ]);
  assert.equal((await decide(other)).status, 'denied');
  await admin.query('UPDATE cos.action_writer_bindings SET version=1 WHERE scope_id=$1 AND id=$2', [scope, writerId]);
  assert.equal(writes, 0);
});
test('S09-T07 unavailable subscription, revoked writer and incomplete/conflicting availability deny proposals', async () => {
  enabled = false;
  assert.equal((await propose()).status, 'denied');
  enabled = true;
  access = { ...access, auth: 'revoked' };
  assert.equal((await propose()).status, 'denied');
  access = { ...access, auth: 'ready' };
  busy = true;
  assert.equal((await propose()).status, 'conflict');
  busy = false;
  const unconfigured = new PriorityStore(store.database);
  assert.equal((await unconfigured.requestAction(context, randomUUID(), request)).status, 'unavailable');
  assert.equal(writes, 0);
});
test('S09-T08 a lost approval UI acknowledgement replays the same decision and never performs an inline write', async () => {
  const proposal = await propose(),
    ingress = randomUUID();
  assert.equal(proposal.status, 'ok');
  assert.equal((await decide(proposal, context.ownerId, ingress)).status, 'ok');
  assert.equal((await decide(proposal, context.ownerId, ingress)).status, 'ok');
  assert.equal((await decide(proposal)).status, 'denied');
  assert.equal(writes, 0);
});
test('S09-T04 concurrent duplicate approvals record one owner decision and one queue transition', async () => {
  const proposal = await propose(),
    ingress = randomUUID();
  assert.equal(proposal.status, 'ok');
  const decisions = await Promise.all(Array.from({ length: 5 }, () => decide(proposal, context.ownerId, ingress)));
  assert.equal(
    decisions.every((result) => result.status === 'ok'),
    true,
  );
  const applies = await Promise.all(Array.from({ length: 5 }, () => store.apply(scope, String(proposal.proposal_id))));
  assert.equal(
    applies.every((result) => result.status === 'ok'),
    true,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM cos.events WHERE scope_id=$1 AND resource_id=$2 AND kind='approve'",
        [scope, proposal.proposal_id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(new Set(applies.map((result) => result.record_id)).size, 1);
  assert.equal(writes, 0);
});
test('S09-T09 cancel before approval prevents the decision and returns no deletion capability', async () => {
  const proposal = await propose();
  assert.equal(proposal.status, 'ok');
  const id = (proposal.change as { action_id: string }).action_id;
  const cancelled = await store.actions.cancel(context, id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.deleted, false);
  assert.equal((await decide(proposal)).status, 'denied');
  assert.equal((await store.actions.cancel({ ...context, ownerId: 'other-owner' }, id)).status, 'denied');
  assert.equal((await store.actions.inspect({ ...context, sessionId: 'other-session' }, id)).status, 'denied');
  assert.equal(writes, 0);
});
