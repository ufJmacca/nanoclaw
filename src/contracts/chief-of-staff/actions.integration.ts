import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectionFault } from './connection-fault.js';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { digest, type Result } from '../../modules/chief-of-staff/domain/contracts.js';
import type { CalendarActionRequest } from '../../modules/chief-of-staff/contracts/action-protocol.js';
import {
  GOOGLE_CALENDAR_METADATA_SCOPE,
  GOOGLE_OWNED_EVENT_WRITE_SCOPE,
  CalendarWriteError,
  type CalendarActionWriter,
  type CalendarWriterAccess,
  type CalendarWriterInspection,
} from '../../modules/chief-of-staff/actions/writer.js';
import { ActionWitness, initializeActionWitness } from '../../modules/chief-of-staff/actions/witness.js';
import type { ActionIntent } from '../../modules/chief-of-staff/actions/intent.js';
import Database from 'better-sqlite3';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import * as coordinatedBackup from '../../modules/chief-of-staff/ops/coordinated-backup.js';
const { backupCoordinatedState } = coordinatedBackup;
import { databaseFingerprint } from '../../modules/chief-of-staff/ops/target-identity.js';

const scope = 'action-' + randomUUID(),
  writerId = randomUUID();
const context = { scopeId: scope, ownerId: 'owner', agentGroupId: scope, sessionId: scope, ingressId: randomUUID() };
const authority = {
  bindingDigest: digest('fixture private owner binding'),
  actionProfileDigest: digest('cos-calendar-action/v1'),
  contextGeneration: randomUUID(),
  provider: {
    profile: 'codex-subscription/coordinator-v1',
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
let witness: ActionWitness, witnessParent: string;
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
let providerMode = 'success';
const remoteEvents = new Map<string, unknown>();
let reads = 0;
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
  create: async (intent, _approved, permit) => {
    assert.equal(permit.valid(), true);
    assert.equal(
      store.database.pool.idleCount,
      store.database.pool.totalCount,
      'provider has no PostgreSQL client checked out',
    );
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM cos.action_request_starts WHERE scope_id=$1 AND action_id=$2',
          [scope, intent.actionId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(witness.find(intent.actionId)?.intent.eventId, intent.eventId);
    writes++;
    if (providerMode === 'timeout_without_creation')
      throw new CalendarWriteError('writer_request_unavailable', 'uncertain');
    const event = { ...intent.payload, etag: '"fixture-created-1"', status: 'confirmed' };
    remoteEvents.set(intent.eventId, event);
    if (providerMode === 'timeout_after_creation')
      throw new CalendarWriteError('writer_request_unavailable', 'uncertain');
    return structuredClone(event);
  },
  get: async (intent) => {
    reads++;
    const raw = remoteEvents.get(intent.eventId) ?? null;
    return providerMode === 'mismatch' && raw
      ? { ...(raw as object), summary: 'Unexpected title' }
      : structuredClone(raw);
  },
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
  witnessParent = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-action-effects-'));
  const root = path.join(witnessParent, 'effects'),
    installation = digest('fixture installation'),
    owner = initializeActionWitness(root, installation);
  witness = new ActionWitness(root, installation, owner.generation);
  store = new PriorityStore(
    BoundedDatabase.fromConfig(await fixtureDatabaseConfig()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { authority: () => (enabled ? authority : null), writer: () => writer, witness },
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
  if (witnessParent) fs.rmSync(witnessParent, { recursive: true, force: true });
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
async function queued(offsetHours: number) {
  const input = {
    ...request,
    start: new Date(Date.parse(request.start) + offsetHours * 3600000).toISOString().replace('.000Z', 'Z'),
    end: new Date(Date.parse(request.end) + offsetHours * 3600000).toISOString().replace('.000Z', 'Z'),
  };
  const proposal = await propose(input);
  assert.equal(proposal.status, 'ok');
  assert.equal((await decide(proposal)).status, 'ok');
  const applied = await store.apply(scope, String(proposal.proposal_id));
  assert.equal(applied.status, 'ok');
  return { id: String(applied.record_id), input };
}
test('S09-T04 the durable queue grants one active executor lease across independent contenders', async () => {
  assert.equal(typeof store.actions.runs?.claim, 'function');
  const action = await queued(3),
    results = await Promise.all(
      Array.from({ length: 5 }, () => store.actions.runs.claim(context, action.id, randomUUID())),
    );
  assert.equal(results.filter((result) => result.status === 'ok').length, 1);
  assert.equal(results.filter((result) => result.status === 'pending').length, 4);
  assert.equal(writes, 0);
});
test('S09-PG02 an expired lease cannot record request-start or admit a provider call', async () => {
  const action = await queued(5),
    claim = await store.actions.runs.claim(context, action.id, randomUUID());
  assert.equal(claim.status, 'ok');
  await admin.query(
    "UPDATE cos.actions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND id=$2",
    [scope, action.id],
  );
  const started = await store.actions.runs.start(
    context,
    claim.lease as import('../../modules/chief-of-staff/actions/run-store.js').ActionLease,
    await writer.inspect(action.input),
  );
  assert.equal(started.status, 'denied');
  assert.equal(
    (
      await admin.query('SELECT count(*)::int AS n FROM cos.action_request_starts WHERE scope_id=$1 AND action_id=$2', [
        scope,
        action.id,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(writes, 0);
});
test('S09-T09/T10 a retained started-effect witness prevents cancellation from claiming an unwritten effect after receipt loss', async () => {
  const action = await queued(7),
    row = (
      await admin.query('SELECT body,digest,proposal_id FROM cos.action_intents WHERE scope_id=$1 AND id=$2', [
        scope,
        action.id,
      ])
    ).rows[0];
  const decision = (await admin.query('SELECT decision_ingress_id FROM cos.proposals WHERE id=$1', [row.proposal_id]))
    .rows[0].decision_ingress_id;
  witness.begin({
    format: 'cos-action-start-witness/v1',
    intent: row.body as ActionIntent,
    approvedDigest: row.digest,
    proposalId: row.proposal_id,
    decisionIngressId: decision,
    leaseOwner: randomUUID(),
    fence: 1,
    recordedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
  });
  const result = await store.actions.cancel(context, action.id);
  assert.equal(result.state, 'outcome_uncertain');
  assert.equal(result.deleted, false);
  assert.equal(writes, 0);
});
test('S09-T08 trusted matching read-back requires confirmed request-start and records one verified receipt', async () => {
  const action = await queued(9),
    claimed = await store.actions.runs.claim(context, action.id, randomUUID());
  assert.equal(claimed.status, 'ok');
  const lease = claimed.lease as import('../../modules/chief-of-staff/actions/run-store.js').ActionLease;
  const raw = { ...lease.intent.payload, etag: '"fixture-readback-1"', status: 'confirmed' };
  assert.equal((await store.actions.runs.complete(context, lease, raw)).status, 'pending');
  assert.equal((await store.actions.runs.start(context, lease, await writer.inspect(action.input))).status, 'ok');
  const result = await store.actions.runs.complete(context, lease, raw);
  assert.equal(result.state, 'verified');
  assert.equal((result.result as { event_id: string }).event_id, lease.intent.eventId);
  assert.equal((await store.actions.runs.complete(context, lease, raw)).status, 'pending');
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM cos.action_receipts WHERE scope_id=$1 AND action_id=$2 AND kind='verified'",
        [scope, action.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(writes, 0);
});
test('S09-T06 mismatch and unresolved absence never become verified or queued for a new write', async () => {
  for (const [offset, rawKind] of [
    [11, 'mismatch'],
    [13, 'missing'],
  ] as const) {
    const action = await queued(offset),
      claimed = await store.actions.runs.claim(context, action.id, randomUUID());
    assert.equal(claimed.status, 'ok');
    const lease = claimed.lease as import('../../modules/chief-of-staff/actions/run-store.js').ActionLease;
    assert.equal((await store.actions.runs.start(context, lease, await writer.inspect(action.input))).status, 'ok');
    const result = await store.actions.runs.complete(
      context,
      lease,
      rawKind === 'missing'
        ? null
        : { ...lease.intent.payload, summary: 'Unexpected title', etag: '"fixture-version"' },
    );
    assert.equal(result.state, rawKind === 'missing' ? 'outcome_uncertain' : 'blocked');
    assert.equal((await store.actions.inspect(context, action.id)).event_id, lease.intent.eventId);
  }
  assert.equal(writes, 0);
});
test('S09-PG02 loss of a real request-start COMMIT acknowledgement returns pending and permits only same-ID reconciliation', async () => {
  const action = await queued(15),
    claimed = await store.actions.runs.claim(context, action.id, randomUUID());
  assert.equal(claimed.status, 'ok');
  const lease = claimed.lease as import('../../modules/chief-of-staff/actions/run-store.js').ActionLease;
  const pool = new pg.Pool(await fixtureDatabaseConfig()),
    connection = await pool.connect(),
    original = connection.query.bind(connection);
  let inserted = false,
    dropped = false;
  connection.query = (async (...args: unknown[]) => {
    const result = await (original as (...params: unknown[]) => Promise<unknown>)(...args);
    if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO cos.action_request_starts')) inserted = true;
    if (args[0] === 'COMMIT' && inserted && !dropped) {
      dropped = true;
      throw new Error('fixture request-start acknowledgement lost');
    }
    return result;
  }) as typeof connection.query;
  connection.release();
  const faulted = new PriorityStore(
    new BoundedDatabase(pool),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store.actions.dependencies,
  );
  try {
    assert.equal(
      (await faulted.actions.runs.start(context, lease, await writer.inspect(action.input))).status,
      'pending',
    );
    assert.equal(dropped, true);
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM cos.action_request_starts WHERE scope_id=$1 AND action_id=$2',
          [scope, action.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(writes, 0);
    await admin.query(
      "UPDATE cos.actions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND id=$2",
      [scope, action.id],
    );
    const recovered = await store.actions.runs.claim(context, action.id, randomUUID());
    assert.equal(recovered.status, 'ok');
    const recoveredLease = recovered.lease as typeof lease;
    assert.equal(recoveredLease.mode, 'reconcile');
    assert.equal(recoveredLease.intent.eventId, lease.intent.eventId);
    assert.equal(
      (await store.actions.runs.start(context, recoveredLease, await writer.inspect(action.input))).status,
      'denied',
    );
    assert.equal(writes, 0);
  } finally {
    await pool.end();
  }
});
test('S09-T10 a retained witness routes a restored pre-approval projection to reconciliation without granting a new write', async () => {
  const action = await queued(17),
    row = (
      await admin.query('SELECT body,digest,proposal_id FROM cos.action_intents WHERE scope_id=$1 AND id=$2', [
        scope,
        action.id,
      ])
    ).rows[0];
  const decision = (await admin.query('SELECT decision_ingress_id FROM cos.proposals WHERE id=$1', [row.proposal_id]))
    .rows[0].decision_ingress_id;
  witness.begin({
    format: 'cos-action-start-witness/v1',
    intent: row.body as ActionIntent,
    approvedDigest: row.digest,
    proposalId: row.proposal_id,
    decisionIngressId: decision,
    leaseOwner: randomUUID(),
    fence: 1,
    recordedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
  });
  await admin.query("UPDATE cos.actions SET state='waiting_approval' WHERE scope_id=$1 AND id=$2", [scope, action.id]);
  await admin.query("UPDATE cos.proposals SET state='pending',decision_ingress_id=NULL WHERE id=$1", [row.proposal_id]);
  const recovered = await store.actions.runs.claim(context, action.id, randomUUID());
  assert.equal(recovered.status, 'ok');
  const lease = recovered.lease as import('../../modules/chief-of-staff/actions/run-store.js').ActionLease;
  assert.equal(lease.mode, 'reconcile');
  assert.equal(lease.intent.eventId, row.body.eventId);
  assert.equal((await store.actions.runs.start(context, lease, await writer.inspect(action.input))).status, 'denied');
  assert.equal(writes, 0);
});
const nativeAdmission = { admitted: async () => enabled, local: () => enabled };
test('S09-T01 the executor cannot perform a provider request for an unapproved action', async () => {
  assert.equal(typeof store.actions.executor?.run, 'function');
  const proposal = await propose({
    ...request,
    start: new Date(Date.parse(request.start) + 19 * 3600000).toISOString().replace('.000Z', 'Z'),
    end: new Date(Date.parse(request.end) + 19 * 3600000).toISOString().replace('.000Z', 'Z'),
  });
  assert.equal(proposal.status, 'ok');
  assert.equal(
    (await store.actions.executor.run(context, (proposal.change as { action_id: string }).action_id, nativeAdmission))
      .status,
    'denied',
  );
  assert.equal(writes, 0);
});
test('S09 full fixture executor commits start, releases PostgreSQL, sends once and verifies the original event', async () => {
  const action = await queued(21),
    beforeWrites = writes,
    beforeReads = reads;
  const result = await store.actions.executor.run(context, action.id, nativeAdmission);
  assert.equal(result.state, 'verified');
  const original = witness.find(action.id)!;
  assert.equal((result.result as { event_id: string }).event_id, original.intent.eventId);
  assert.equal(writes, beforeWrites + 1);
  assert.equal(reads, beforeReads + 1);
  assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'verified');
  assert.equal(writes, beforeWrites + 1);
});
test('S09-T05 timeout after fixture creation reads back the same ID without another POST', async () => {
  const action = await queued(23),
    beforeWrites = writes;
  providerMode = 'timeout_after_creation';
  try {
    const result = await store.actions.executor.run(context, action.id, nativeAdmission);
    assert.equal(result.state, 'verified');
    assert.equal(remoteEvents.has(witness.find(action.id)!.intent.eventId), true);
    assert.equal(writes, beforeWrites + 1);
  } finally {
    providerMode = 'success';
  }
});
test('S09-T06 unresolved fixture absence remains uncertain through same-ID reconciliation', async () => {
  const action = await queued(25),
    beforeWrites = writes;
  providerMode = 'timeout_without_creation';
  try {
    assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'outcome_uncertain');
    assert.equal(writes, beforeWrites + 1);
    const original = witness.find(action.id)!.intent.eventId;
    await admin.query(
      "UPDATE cos.actions SET next_reconcile_at=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND id=$2",
      [scope, action.id],
    );
    assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'outcome_uncertain');
    assert.equal(writes, beforeWrites + 1);
    assert.equal(witness.find(action.id)!.intent.eventId, original);
  } finally {
    providerMode = 'success';
  }
});
test('S09-T06 a mismatched fixture event is blocked without modification or deletion', async () => {
  const action = await queued(27),
    beforeWrites = writes;
  providerMode = 'mismatch';
  try {
    assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'blocked');
    assert.equal(writes, beforeWrites + 1);
    assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'blocked');
    assert.equal(writes, beforeWrites + 1);
  } finally {
    providerMode = 'success';
  }
});
test('S09-T07 fresh conflicts and loss of native/model admission prevent approved execution', async () => {
  const action = await queued(29),
    beforeWrites = writes;
  busy = true;
  try {
    assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'blocked');
    assert.equal(writes, beforeWrites);
  } finally {
    busy = false;
  }
  const other = await queued(31);
  enabled = false;
  try {
    assert.equal((await store.actions.executor.run(context, other.id, nativeAdmission)).status, 'denied');
    assert.equal(writes, beforeWrites);
  } finally {
    enabled = true;
  }
});
test('S09-PG02 executor loses the real request-start COMMIT acknowledgement without contacting the provider', async () => {
  const action = await queued(33),
    beforeWrites = writes,
    beforeReads = reads;
  const pool = new pg.Pool(await fixtureDatabaseConfig()),
    connection = await pool.connect(),
    original = connection.query.bind(connection);
  let inserted = false,
    dropped = false;
  connection.query = (async (...args: unknown[]) => {
    const result = await (original as (...params: unknown[]) => Promise<unknown>)(...args);
    if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO cos.action_request_starts')) inserted = true;
    if (args[0] === 'COMMIT' && inserted && !dropped) {
      dropped = true;
      throw new Error('fixture executor acknowledgement lost');
    }
    return result;
  }) as typeof connection.query;
  connection.release();
  const faulted = new PriorityStore(
    new BoundedDatabase(pool),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store.actions.dependencies,
  );
  try {
    assert.equal((await faulted.actions.executor.run(context, action.id, nativeAdmission)).status, 'pending');
    assert.equal(dropped, true);
    assert.equal(writes, beforeWrites);
    assert.equal(reads, beforeReads);
    assert.equal(witness.find(action.id), null);
    await admin.query(
      "UPDATE cos.actions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND id=$2",
      [scope, action.id],
    );
    assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'outcome_uncertain');
    assert.equal(writes, beforeWrites);
    assert.equal(reads, beforeReads + 1);
  } finally {
    await pool.end();
  }
});
test('S09-PG01 actual PostgreSQL loss after fixture creation reconciles the original ID after reconnect without another POST', async () => {
  const action = await queued(35),
    beforeWrites = writes;
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    pool = new pg.Pool(relay.config);
  const partitioningWriter: CalendarActionWriter = {
    ...writer,
    create: async (...args) => {
      assert.equal(pool.idleCount, pool.totalCount, 'no test PostgreSQL client is held across provider execution');
      const raw = await writer.create(...args);
      relay.partition();
      return raw;
    },
  };
  const faulted = new PriorityStore(
    new BoundedDatabase(pool, 1000, 25),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { ...store.actions.dependencies!, writer: () => partitioningWriter },
  );
  try {
    const result = await faulted.actions.executor.run(context, action.id, nativeAdmission);
    assert.equal(result.status, 'pending');
    const original = witness.find(action.id)!;
    assert.equal(remoteEvents.has(original.intent.eventId), true);
    assert.equal(writes, beforeWrites + 1);
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM cos.action_request_starts WHERE scope_id=$1 AND action_id=$2',
          [scope, action.id],
        )
      ).rows[0].n,
      1,
    );
    relay.restore();
    await delay(1100);
    await admin.query(
      "UPDATE cos.actions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND id=$2",
      [scope, action.id],
    );
    const recovered = await store.actions.executor.run(context, action.id, nativeAdmission);
    assert.equal(recovered.state, 'verified');
    assert.equal((recovered.result as { event_id: string }).event_id, original.intent.eventId);
    assert.equal(writes, beforeWrites + 1);
  } finally {
    relay.restore();
    await pool.end();
    await relay.close();
  }
});
test('S09 authority callback failures cannot expose private diagnostics or contact the provider', async () => {
  const action = await queued(37),
    beforeWrites = writes;
  for (const failing of ['authority', 'native_local']) {
    const faulted = new PriorityStore(store.database, undefined, undefined, undefined, undefined, undefined, {
      ...store.actions.dependencies!,
      authority: () => {
        if (failing === 'authority') throw new Error('private fixture account diagnostic');
        return authority;
      },
    });
    const result = await faulted.actions.executor.run(context, action.id, {
      admitted: async () => true,
      local: () => {
        if (failing === 'native_local') throw new Error('private fixture native diagnostic');
        return true;
      },
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(JSON.stringify(result).includes('private fixture'), false);
    assert.equal(writes, beforeWrites);
  }
});
test('S09-T10 an event whose entire PostgreSQL intent was lost is recovered only through its target-owned original witness', async () => {
  const action = await queued(39),
    beforeWrites = writes;
  assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'verified');
  const original = witness.find(action.id)!;
  await admin.query('BEGIN');
  try {
    for (const table of ['action_receipts', 'action_request_starts', 'actions', 'action_intents'])
      await admin.query(
        'DELETE FROM cos.' +
          table +
          ' WHERE scope_id=$1 AND ' +
          (table === 'action_receipts' || table === 'action_request_starts' ? 'action_id' : 'id') +
          '=$2',
        [scope, action.id],
      );
    await admin.query("DELETE FROM cos.outbox WHERE scope_id=$1 AND payload->>'proposal_id'=$2", [
      scope,
      original.proposalId,
    ]);
    await admin.query('DELETE FROM cos.proposals WHERE scope_id=$1 AND id=$2', [scope, original.proposalId]);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  assert.equal((await store.actions.runs.claim(context, action.id, randomUUID())).status, 'denied');
  assert.equal(typeof store.actions.runs.recoverWitnesses, 'function');
  const recovered = await store.actions.runs.recoverWitnesses(context);
  assert.equal(recovered.status, 'ok');
  const proposal = (await admin.query('SELECT state FROM cos.proposals WHERE id=$1', [original.proposalId])).rows[0];
  assert.equal(proposal.state, 'expired', 'recovery cannot restore a pending or applied owner permission');
  assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'verified');
  assert.equal(writes, beforeWrites + 1);
  assert.equal(witness.find(action.id)?.intent.eventId, original.intent.eventId);
});
test('S09 renewed main-context authority may reconcile an original effect but cannot renew its write permission', async () => {
  const action = await queued(41),
    beforeWrites = writes;
  assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'verified');
  const policy = authority.provider.policyDigest,
    generation = authority.contextGeneration;
  await admin.query("UPDATE cos.actions SET state='outcome_uncertain',result=NULL WHERE scope_id=$1 AND id=$2", [
    scope,
    action.id,
  ]);
  authority.provider.policyDigest = digest('freshly granted fixture model policy');
  authority.contextGeneration = randomUUID();
  try {
    assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'verified');
    assert.equal(writes, beforeWrites + 1);
  } finally {
    authority.provider.policyDigest = policy;
    authority.contextGeneration = generation;
  }
});
async function restoreOnlyOwnedFixtureScope(
  snapshot: import('../../modules/chief-of-staff/ops/coordinated-backup.js').ScopeCheckpoint,
) {
  assert.equal(snapshot.scopeId, scope);
  assert.match(scope, /^action-[a-f0-9-]{36}$/);
  assert.equal(enabled, false);
  assert.equal(store.database.pool.idleCount, store.database.pool.totalCount);
  const tables = coordinatedBackup.CHECKPOINT_TABLES.filter((table) => table !== 'scopes');
  await admin.query('BEGIN');
  try {
    await admin.query('SET CONSTRAINTS ALL DEFERRED');
    for (const mode of ['delete', 'insert']) {
      let remaining = [...tables];
      while (remaining.length) {
        const retry: string[] = [];
        for (const table of remaining) {
          await admin.query('SAVEPOINT fixture_restore_table');
          try {
            if (mode === 'delete') await admin.query(`DELETE FROM cos."${table}" WHERE scope_id=$1`, [scope]);
            else if (snapshot.rows[table].length) {
              const fields = snapshot.columns[table].map((name) => '"' + name + '"').join(',');
              await admin.query(
                `INSERT INTO cos."${table}"(${fields}) SELECT ${fields} FROM jsonb_populate_recordset(NULL::cos."${table}",$1::jsonb)`,
                [JSON.stringify(snapshot.rows[table])],
              );
            }
            await admin.query('RELEASE SAVEPOINT fixture_restore_table');
          } catch (error) {
            await admin.query('ROLLBACK TO SAVEPOINT fixture_restore_table');
            await admin.query('RELEASE SAVEPOINT fixture_restore_table');
            if ((error as { code?: string }).code !== '23503') {
              // eslint-disable-next-line preserve-caught-error -- Private database diagnostics must not escape the fixture restore boundary.
              throw new Error('fixture_scope_restore_failed');
            }
            retry.push(table);
          }
        }
        if (retry.length === remaining.length) throw new Error('fixture_scope_restore_dependency_failed');
        remaining = retry;
      }
    }
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}
test('S09-T10 coordinated sandbox restore reconciles a fixture event created after the actual remote/local backup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-coordinated-backup-'));
  try {
    fs.chmodSync(root, 0o700);
    const receiptRoot = path.join(root, 'receipt'),
      artifactsRoot = path.join(root, 'artifacts'),
      stagingRoot = path.join(root, 'staging');
    for (const dir of [receiptRoot, artifactsRoot, stagingRoot]) fs.mkdirSync(dir, { mode: 0o700 });
    const sqlite = path.join(root, 'native.sqlite'),
      db = new Database(sqlite);
    db.pragma('journal_mode=WAL');
    db.exec(
      "CREATE TABLE fixture_history(id TEXT PRIMARY KEY,body TEXT); INSERT INTO fixture_history VALUES('before','preserved native owner message')",
    );
    fs.chmodSync(sqlite, 0o600);
    const artifacts = new KnowledgeArtifacts(artifactsRoot, stagingRoot);
    const beforeArtifact = await artifacts.exclusive(async (lease) =>
      artifacts.publishText(scope, 'preserved pre-backup artifact', lease),
    );
    const restriction = path.join(root, 'binding.json');
    fs.writeFileSync(
      restriction,
      JSON.stringify({ scopeId: scope, bindingDigest: authority.bindingDigest, paused: true }),
      { mode: 0o600 },
    );
    const options = {
      client: admin,
      context,
      databaseFingerprint: await databaseFingerprint(admin, await fixtureDatabaseConfig(process.env, 'migration')),
      operationId: randomUUID(),
      receiptRoot,
      nativeDatabases: [sqlite],
      artifacts,
      restrictionFiles: [restriction],
      witness,
      quiescent: async () => {
        assert.equal(enabled, false);
        assert.equal(store.database.pool.idleCount, store.database.pool.totalCount);
        return {
          generation: 1,
          activeWorkers: 0 as const,
          activeOperations: 0 as const,
          nativeWriters: 0 as const,
          effectsEnabled: false as const,
        };
      },
    };
    enabled = false;
    let checkpoint;
    try {
      checkpoint = await backupCoordinatedState(options);
    } finally {
      enabled = true;
    }
    assert.equal(checkpoint.format, 'cos-coordinated-backup/v1');
    assert.equal(checkpoint.schemaVersion, 16);
    assert.equal(checkpoint.admissionRestored, false);
    const native = new Database(path.join(receiptRoot, 'coordinated', 'sqlite', '0', 'native.sqlite'), {
      readonly: true,
    });
    try {
      assert.equal((native.prepare('SELECT count(*) AS n FROM fixture_history').get() as { n: number }).n, 1);
    } finally {
      native.close();
      db.close();
    }
    const remote = JSON.parse(fs.readFileSync(path.join(receiptRoot, 'coordinated', 'remote.json'), 'utf8'));
    assert.equal(remote.scopeId, scope);
    assert.equal(remote.rows.scopes[0].owner_id, 'owner');
    assert.ok(remote.rows.action_request_starts.length > 0);
    assert.equal(
      fs.existsSync(path.join(receiptRoot, 'coordinated', 'witness')),
      false,
      'deny journal remains independently target-owned',
    );
    const action = await queued(43),
      beforeWrites = writes;
    assert.equal((await store.actions.executor.run(context, action.id, nativeAdmission)).state, 'verified');
    const original = witness.find(action.id)!;
    const liveNative = new Database(sqlite);
    liveNative.exec("INSERT INTO fixture_history VALUES('after','later native message')");
    liveNative.close();
    const afterArtifact = await artifacts.exclusive(async (lease) =>
      artifacts.publishText(scope, 'later artifact', lease),
    );
    assert.equal(typeof coordinatedBackup.restoreCoordinatedSandbox, 'function');
    enabled = false;
    try {
      const destination = path.join(root, 'sandbox');
      const restored = await coordinatedBackup.restoreCoordinatedSandbox(options, destination);
      assert.equal(restored.admissionRestored, false);
      assert.equal(restored.eventJournalRestored, false);
      const isolated = new Database(path.join(destination, 'sqlite', '0', 'native.sqlite'), { readonly: true });
      try {
        assert.equal((isolated.prepare('SELECT count(*) AS n FROM fixture_history').get() as { n: number }).n, 1);
      } finally {
        isolated.close();
      }
      assert.equal(
        fs.readFileSync(path.join(destination, 'artifacts', beforeArtifact.id + '.blob'), 'utf8'),
        'preserved pre-backup artifact',
      );
      assert.equal(fs.existsSync(path.join(destination, 'artifacts', afterArtifact.id + '.blob')), false);
      const stillLive = new Database(sqlite, { readonly: true });
      try {
        assert.equal((stillLive.prepare('SELECT count(*) AS n FROM fixture_history').get() as { n: number }).n, 2);
      } finally {
        stillLive.close();
      }
      await restoreOnlyOwnedFixtureScope(remote);
      assert.equal(
        (await admin.query('SELECT 1 FROM cos.action_intents WHERE scope_id=$1 AND id=$2', [scope, action.id]))
          .rowCount,
        0,
      );
      assert.equal(witness.find(action.id)?.intent.eventId, original.intent.eventId);
    } finally {
      enabled = true;
    }
    assert.equal((await store.actions.runs.recoverWitnesses(context)).status, 'ok');
    const recovered = await store.actions.executor.run(context, action.id, nativeAdmission);
    assert.equal(recovered.state, 'verified');
    assert.equal((recovered.result as { event_id: string }).event_id, original.intent.eventId);
    assert.equal(writes, beforeWrites + 1, 'backup restoration never admits a second provider POST');
  } finally {
    enabled = true;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
