/** Action resource permissions use the existing source policy and retained main context on real PostgreSQL. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { digest, type Result } from '../../modules/chief-of-staff/domain/contracts.js';
import { RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import { installReviewedMissionTemplate } from '../../modules/chief-of-staff/missions/template-admin.js';
import type { CalendarActionRequest } from '../../modules/chief-of-staff/contracts/action-protocol.js';
import type { ActionWriterBinding } from '../../modules/chief-of-staff/actions/binding.js';
import {
  GOOGLE_OWNED_EVENT_WRITE_SCOPE,
  GOOGLE_CALENDAR_METADATA_SCOPE,
  type CalendarActionWriter,
} from '../../modules/chief-of-staff/actions/writer.js';
import { initializeActionWitness, ActionWitness } from '../../modules/chief-of-staff/actions/witness.js';
const scope = 'action-resources-' + randomUUID(),
  writerId = randomUUID(),
  context = { scopeId: scope, ownerId: 'owner', agentGroupId: scope, sessionId: scope, ingressId: randomUUID() },
  binding = {
    ...context,
    messagingGroupId: 'fixture-messaging',
    instanceId: 'fixture',
    channelId: scope,
    botId: 'fixture-bot',
    provider: 'codex' as const,
  },
  authority = {
    bindingDigest: digest(binding),
    contextGeneration: randomUUID(),
    actionProfileDigest: digest('cos-calendar-action/v1'),
    provider: {
      profile: 'codex-subscription/coordinator-v1',
      model: 'fixture-model',
      policyDigest: digest('fixture policy'),
    },
  },
  writerBinding: ActionWriterBinding = {
    format: 'cos-calendar-writer/v1',
    provider: 'fixture',
    calendarId: 'owner@example.test',
    accountFingerprint: digest('fixture account'),
    credentialGeneration: 'fixture-only',
    instanceId: 'fixture',
    channelId: scope,
    bindingDigest: authority.bindingDigest,
    processingProvider: 'codex',
    restoreProofDigest: digest('fixture-only proof'),
    scopes: [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE],
  };
let admin: pg.Client,
  store: PriorityStore,
  knowledge: KnowledgeStore,
  base: string,
  slot = 0,
  writes = 0;
const events = new Map<string, unknown>();
const writer: CalendarActionWriter = {
  access: async () => ({
    calendarId: writerBinding.calendarId,
    generation: writerBinding.credentialGeneration,
    accountFingerprint: writerBinding.accountFingerprint,
    scopes: writerBinding.scopes,
    auth: 'ready',
    writeEnabled: true,
  }),
  inspect: async (request) => ({
    complete: true,
    calendarId: request.calendar_id,
    calendarTimeZone: 'UTC',
    accountFingerprint: writerBinding.accountFingerprint,
    generation: writerBinding.credentialGeneration,
    ownershipDigest: digest('owned'),
    availabilityDigest: digest({ start: request.start, end: request.end }),
    busy: [],
    observedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
  }),
  create: async (intent, _digest, permit) => {
    assert.equal(permit.valid(), true);
    writes++;
    const event = { ...intent.payload, etag: 'fixture-v1', status: 'confirmed' };
    events.set(intent.eventId, event);
    return event;
  },
  get: async (intent) => events.get(intent.eventId) ?? null,
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
  await admin.query('BEGIN');
  await installReviewedMissionTemplate(admin, binding, randomUUID(), {
    expectedRevision: 0,
    enabled: true,
    templateDigest: digest(RESEARCH_TEMPLATE),
    reviewRef: 'fixture-reviewed-template',
  });
  await admin.query('COMMIT');
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-action-resources-'));
  for (const name of ['artifacts', 'staging']) fs.mkdirSync(path.join(base, name), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
  knowledge = new KnowledgeStore(database, new KnowledgeArtifacts(base + '/artifacts', base + '/staging'));
  const installation = digest('fixture installation'),
    root = base + '/effects',
    owner = initializeActionWitness(root, installation);
  store = new PriorityStore(
    database,
    knowledge,
    undefined,
    undefined,
    () => ({
      ...authority,
      delegationDigest: digest('fixture delegation'),
      provider: { ...authority.provider, profile: RESEARCH_TEMPLATE.providerProfile },
    }),
    undefined,
    {
      authority: () => authority,
      writer: () => writer,
      witness: new ActionWitness(root, installation, owner.generation),
    },
  );
});
after(async () => {
  await store?.database.pool.end();
  if (admin) {
    await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
    for (const table of [
      'action_receipts',
      'action_request_starts',
      'actions',
      'action_intents',
      'action_writer_revisions',
      'action_writer_bindings',
      'mission_reviews',
      'mission_result_submissions',
      'mission_budget_reservations',
      'mission_attempts',
      'missions',
      'mission_work_orders',
      'mission_context_manifests',
      'mission_template_versions',
      'derivation_links',
      'evidence_refs',
      'chunks',
      'revocation_tombstones',
      'source_revisions',
      'sources',
      'artifacts',
      'outbox',
      'events',
      'operations',
      'proposals',
      'records',
    ])
      await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=$1', [scope]);
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
    await admin.end();
  }
  if (base) fs.rmSync(base, { recursive: true, force: true });
});
async function note() {
  const key = randomUUID();
  fs.writeFileSync(
    base + '/staging/' + key + '.md',
    'Pilot Alpha admitted notes. PRIVATE_SOURCE_CANARY: do not copy this text into an event.',
    { mode: 0o600 },
  );
  const source = await knowledge.importSource(context, randomUUID(), {
    sourceKey: key,
    filename: key + '.md',
    title: 'Pilot Alpha notes',
    processingProviders: ['codex'],
    expectedVersion: 0,
  });
  assert.equal(source.status, 'ok');
  return { source_id: String(source.source_id), revision_id: String(source.revision_id) };
}
async function approve(proposal: Result) {
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(proposal.proposal_id),
        String(proposal.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  const applied = await store.apply(scope, String(proposal.proposal_id));
  assert.equal(applied.status, 'ok');
  return String(applied.record_id);
}
async function mission() {
  const source = await note(),
    proposal = await store.requestMission(context, randomUUID(), {
      question: 'Compare Pilot Alpha options.',
      goal_id: null,
      project_id: null,
      sources: [source],
      acceptance_criteria: [{ id: 'comparison', description: 'Give private preparation advice.' }],
      limits: { ...MISSION_DEFAULT_LIMITS },
    });
  assert.equal(proposal.status, 'ok');
  const id = await approve(proposal);
  // Only this owned synthetic mission is marked complete; no specialist or model is invoked.
  await admin.query("UPDATE cos.missions SET state='completed' WHERE scope_id=$1 AND id=$2", [scope, id]);
  return { source, id };
}
async function request(patch: Partial<CalendarActionRequest> = {}): Promise<CalendarActionRequest> {
  const now =
      (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime() + 86400000 + slot++ * 7200000,
    at = (offset: number) => new Date(Math.floor((now + offset) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  return {
    kind: 'calendar_block',
    binding_id: writerId,
    calendar_id: writerBinding.calendarId,
    start: at(0),
    end: at(3600000),
    time_zone: 'UTC',
    title: 'Focus work',
    description: '',
    project_id: null,
    mission_id: null,
    attendees: [],
    ...patch,
  };
}
const native = { local: () => true, admitted: async () => true };
test('S09-T01 a completed admitted mission can propose a minimal block without copying source text or launching work', async () => {
  const m = await mission();
  const beforeAttempts = (
    await admin.query('SELECT count(*)::int AS n FROM cos.mission_attempts WHERE scope_id=$1', [scope])
  ).rows[0].n;
  const proposal = await store.requestAction(context, randomUUID(), await request({ mission_id: m.id }));
  assert.equal(proposal.status, 'ok');
  assert.doesNotMatch(JSON.stringify(proposal), /PRIVATE_SOURCE_CANARY/);
  const id = await approve(proposal);
  assert.equal(writes, 0);
  assert.equal((await store.actions.executor.run(context, id, native)).state, 'verified');
  assert.equal(writes, 1);
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM cos.mission_attempts WHERE scope_id=$1', [scope])).rows[0].n,
    beforeAttempts,
  );
});
test('S09-T02/T07 source revision, processing permission and revocation changes invalidate an approved mission action', async () => {
  for (const kind of ['revision', 'permission', 'revoked']) {
    const m = await mission(),
      proposal = await store.requestAction(context, randomUUID(), await request({ mission_id: m.id }));
    assert.equal(proposal.status, 'ok');
    const id = await approve(proposal),
      before = writes;
    if (kind === 'revision')
      await admin.query('UPDATE cos.sources SET version=version+1 WHERE scope_id=$1 AND id=$2', [
        scope,
        m.source.source_id,
      ]);
    if (kind === 'permission')
      await admin.query("UPDATE cos.sources SET processing_providers=ARRAY['claude'] WHERE scope_id=$1 AND id=$2", [
        scope,
        m.source.source_id,
      ]);
    if (kind === 'revoked')
      await admin.query("UPDATE cos.sources SET status='revoked' WHERE scope_id=$1 AND id=$2", [
        scope,
        m.source.source_id,
      ]);
    assert.equal((await store.actions.executor.run(context, id, native)).status, 'denied');
    assert.equal(writes, before);
    if (kind !== 'revision')
      assert.equal(
        (await store.requestAction(context, randomUUID(), await request({ mission_id: m.id }))).status,
        'denied',
      );
  }
});
test('S09-T02 project-version changes and foreign mission/context identities cannot borrow an approval', async () => {
  const project = await store.propose(context, randomUUID(), {
    kind: 'project',
    lifecycle: 'active',
    reason: 'Owner fixture approval',
    expected_version: 0,
    title: 'Pilot Alpha',
    description: 'Approved fixture project',
  });
  assert.equal(project.status, 'ok');
  const projectId = await approve(project),
    m = await mission();
  const proposal = await store.requestAction(
    context,
    randomUUID(),
    await request({ project_id: projectId, mission_id: m.id }),
  );
  assert.equal(proposal.status, 'ok');
  const id = await approve(proposal),
    before = writes;
  await admin.query('UPDATE cos.records SET version=version+1 WHERE scope_id=$1 AND id=$2', [scope, projectId]);
  assert.equal((await store.actions.executor.run(context, id, native)).status, 'denied');
  assert.equal(writes, before);
  assert.equal(
    (await store.requestAction({ ...context, sessionId: 'foreign' }, randomUUID(), await request({ mission_id: m.id })))
      .status,
    'denied',
  );
  assert.equal(
    (await store.requestAction(context, randomUUID(), await request({ mission_id: 'mission-' + 'f'.repeat(64) })))
      .status,
    'denied',
  );
});
test('S09-T07 a retained main context exposed to revoked text cannot avoid the restriction by omitting a mission', async () => {
  const source = await note(),
    retained = { ...context, provider: 'codex', generation: authority.contextGeneration };
  assert.equal((await knowledge.search(retained, { query: 'Pilot Alpha', sourceId: source.source_id })).status, 'ok');
  await admin.query("UPDATE cos.sources SET status='revoked' WHERE scope_id=$1 AND id=$2", [scope, source.source_id]);
  const before = writes;
  assert.equal((await store.requestAction(context, randomUUID(), await request())).status, 'denied');
  assert.equal(writes, before);
});
