/** Scripted owner conversation through native routing, isolated MCP, approval and the existing action pump. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { createConversationState } from '../../modules/chief-of-staff/bridge/conversation-state.js';
import { ensureModelBudget } from '../../modules/chief-of-staff/bridge/model-policy.js';
import { issueActivation } from '../../modules/chief-of-staff/ops/model-activation.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import type { CalendarActionRequest } from '../../modules/chief-of-staff/contracts/action-protocol.js';
import type { ActionWriterBinding } from '../../modules/chief-of-staff/actions/binding.js';
import {
  GOOGLE_OWNED_EVENT_WRITE_SCOPE,
  GOOGLE_CALENDAR_METADATA_SCOPE,
} from '../../modules/chief-of-staff/actions/writer.js';
import { HostFixture } from './host-fixture-client.js';
import { McpFixture } from './mcp-fixture.js';

test(
  'S09 native owner approves an exact private block and receives its verified result in the retained main conversation',
  { timeout: 120000 },
  async (t) => {
    const repository = process.cwd(),
      hostRepository = process.env.COS_FIXTURE_HOST_ROOT,
      image = process.env.COS_FIXTURE_IMAGE;
    assert.ok(hostRepository && path.isAbsolute(hostRepository) && image);
    const parent = path.join(repository, '.cos-plan-state/fixtures');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'flow-s09-')),
      knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-knowledge-demo-')),
      scope = 'demo-actions-' + randomUUID(),
      writerId = randomUUID();
    for (const name of ['artifacts', 'staging']) fs.mkdirSync(path.join(knowledgeRoot, name), { mode: 0o700 });
    process.chdir(root);
    const { PriorityStore } = await import('../../modules/chief-of-staff/store/priorities.js'),
      { initDb, closeDb } = await import('../../db/connection.js'),
      { runMigrations } = await import('../../db/migrations/index.js'),
      { subscribeMattermostChannelStrict } = await import('../../channels/mattermost-subscription.js'),
      { resolveSession, sessionDir, openInboundDb } = await import('../../session-manager.js'),
      { bindCoordinator } = await import('../../modules/chief-of-staff/ops/bind.js');
    let admin: Awaited<ReturnType<typeof connectFixtureDatabase>> | undefined,
      database: BoundedDatabase | undefined,
      host: HostFixture | undefined,
      client: McpFixture | undefined,
      ordinaryClient: McpFixture | undefined;
    try {
      admin = await connectFixtureDatabase(process.env, 'migration');
      assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
      await migrate(admin, fixtureRuntimeUser());
      database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
      const priorities = new PriorityStore(database),
        db = initDb(path.join(root, 'central.db'));
      runMigrations(db);
      const sub = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: scope }),
        session = resolveSession(sub.agentGroup.id, sub.messagingGroup.id, null, 'shared').session,
        other = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: scope + '-ordinary' }),
        ordinary = resolveSession(other.agentGroup.id, other.messagingGroup.id, null, 'shared').session,
        binding = {
          scopeId: scope,
          agentGroupId: session.agent_group_id,
          messagingGroupId: sub.messagingGroup.id,
          sessionId: session.id,
          instanceId: 'fixture',
          channelId: scope,
          ownerId: 'fixture-owner',
          botId: 'fixture-bot',
          provider: 'codex' as const,
        };
      await bindCoordinator(binding, {
        facts: async () => ({
          id: scope,
          type: 'P',
          delete_at: 0,
          members: [binding.ownerId, binding.botId],
          activeSubscription: true,
        }),
        bindScope: (value) => priorities.bindScope(value),
      });
      const generation = createConversationState(knowledgeRoot, db).prepare(binding, 'a'.repeat(64)).generation;
      ensureModelBudget(db);
      const policy = {
        version: 2 as const,
        runtime: 'codex-subscription/v1' as const,
        activationId: randomUUID().replaceAll('-', ''),
        consentRef: 'Synthetic S09 fixture only; no model access',
        scopeId: scope,
        provider: 'codex' as const,
        model: 'fixture-model',
        maxAttempts: 4,
        expiresAt: new Date(Date.now() + 180000).toISOString(),
        accountFingerprint: 'a'.repeat(64),
        contextGeneration: generation,
      };
      issueActivation(
        { root: knowledgeRoot, db, binding, accountFingerprint: policy.accountFingerprint, assertAuthority() {} },
        policy,
      );
      db.prepare('UPDATE cos_identity_boundaries SET paused=0 WHERE scope_id=?').run(scope);
      const coordinatorDirectory = sessionDir(session.agent_group_id, session.id),
        ordinaryDirectory = sessionDir(ordinary.agent_group_id, ordinary.id);
      fs.mkdirSync(ordinaryDirectory, { recursive: true });
      openInboundDb(ordinary.agent_group_id, ordinary.id).close();
      closeDb();
      const authority = {
          bindingDigest: digest(binding),
          contextGeneration: generation,
          actionProfileDigest: digest('cos-calendar-action/v1'),
          provider: { profile: 'codex-subscription/coordinator-v1', model: policy.model, policyDigest: digest(policy) },
        },
        writerBinding: ActionWriterBinding = {
          format: 'cos-calendar-writer/v1',
          provider: 'fixture',
          calendarId: 'owner@example.test',
          accountFingerprint: digest('fixture calendar account'),
          credentialGeneration: randomUUID(),
          instanceId: binding.instanceId,
          channelId: binding.channelId,
          bindingDigest: digest(binding),
          processingProvider: 'codex',
          restoreProofDigest: digest('fixture proof only; cannot enable Google'),
          scopes: [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE],
        };
      await admin.query(
        "INSERT INTO cos.action_writer_bindings(scope_id,id,owner_id,session_id,version,state) VALUES($1,$2,$3,$4,1,'enabled')",
        [scope, writerId, binding.ownerId, binding.sessionId],
      );
      await admin.query(
        'INSERT INTO cos.action_writer_revisions(scope_id,binding_id,version,body,digest,consent_ref) VALUES($1,$2,1,$3,$4,$5)',
        [scope, writerId, JSON.stringify(writerBinding), digest(writerBinding), 'fixture-only-explicit-consent'],
      );
      const hostInput = {
        root,
        binding,
        ordinarySessionId: ordinary.id,
        knowledgeRoot,
        actions: { authority, writerId, binding: writerBinding },
      };
      const start = async () => {
        host = new HostFixture();
        await host.request('start', hostInput);
      };
      await start();
      client = new McpFixture(
        repository,
        coordinatorDirectory,
        hostRepository,
        image,
        process.env.COS_FIXTURE_RUNNER_VOLUME ?? '',
      );
      await client.start();
      ordinaryClient = new McpFixture(
        repository,
        ordinaryDirectory,
        hostRepository,
        image,
        process.env.COS_FIXTURE_RUNNER_VOLUME ?? '',
      );
      await ordinaryClient.start();
      const ingress = async (text: string, senderId = binding.ownerId) =>
        host!.request('ingress', { id: randomUUID(), text, senderId });
      const complete = async () => {
        await client!.completePending();
        await host!.request('sync-acks');
      };
      const pump = () => host!.request('pump');
      const stats = () => host!.request('action-fixture-state');
      const state = async (id: string) =>
        (await admin!.query('SELECT state FROM cos.actions WHERE scope_id=$1 AND id=$2', [scope, id])).rows[0]?.state;
      const wait = async (check: () => Promise<boolean>) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          await pump();
          if (await check()) return;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        assert.fail(
          'action flow deadline:' +
            JSON.stringify({
              actions: (
                await admin!.query('SELECT state,reason FROM cos.actions WHERE scope_id=$1 ORDER BY id', [scope])
              ).rows,
              proposals: (await admin!.query('SELECT state FROM cos.proposals WHERE scope_id=$1 ORDER BY id', [scope]))
                .rows,
              provider: await stats(),
            }),
        );
      };
      const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime(),
        at = (offset: number) => new Date(Math.floor((now + offset) / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
        request: CalendarActionRequest = {
          kind: 'calendar_block',
          binding_id: writerId,
          calendar_id: writerBinding.calendarId,
          start: at(86400000),
          end: at(90000000),
          time_zone: 'Australia/Sydney',
          title: 'Focus work',
          description: '',
          project_id: null,
          mission_id: null,
          attendees: [],
        };
      let slot = 0;
      const propose = async (input?: CalendarActionRequest, requestId = randomUUID()) => {
        const offset = slot++ * 7200000;
        const selected = input ?? { ...request, start: at(86400000 + offset), end: at(90000000 + offset) };
        await ingress('Find an hour tomorrow for Pilot Alpha.');
        const result = await client!.call('cos_action_propose', { request_id: requestId, request: selected });
        assert.equal(result.status, 'ok');
        await complete();
        await pump();
        const preview = host!.delivered.find((row) => row.id === 'cos-' + result.result.proposal_id);
        assert.ok(preview);
        assert.match(preview.text, /Focus work/);
        const command = preview.text.split('\n').find((line) => line.startsWith('cos approve '));
        assert.ok(command);
        return { result: result.result, command, requestId };
      };
      const approve = async (proposal: Awaited<ReturnType<typeof propose>>) => {
        await ingress(proposal.command);
        await pump();
        await complete();
      };
      await t.test('S09-T03 native MCP rejects guests and arbitrary provider fields', async () => {
        await ingress('Propose a private focus block without guests.');
        for (const patch of [
          { attendees: ['guest@example.test'] },
          { url: 'https://example.test/action' },
          { recurrence: ['RRULE:FREQ=DAILY'] },
        ]) {
          const denied = await client!.call('cos_action_propose', {
            request_id: randomUUID(),
            request: { ...request, ...patch },
          });
          assert.equal(denied.status, 'denied');
        }
        assert.equal((await stats()).writes, 0);
      });
      await t.test(
        'S09-T01/T04 native private approval creates exactly the previewed block; its notice is passive in the main session',
        async () => {
          await ingress('Find an hour tomorrow for Pilot Alpha.');
          const context = await client!.call('cos_context_get', { view: 'today' });
          assert.equal(context.status, 'ok');
          assert.equal(context.result.action_writer_bindings[0].binding_id, writerId);
          const tools = (await client!.request('tools/list', {})).tools.map((tool: { name: string }) => tool.name);
          assert.deepEqual(tools.filter((name: string) => name.startsWith('cos_action_')).sort(), [
            'cos_action_cancel',
            'cos_action_get',
            'cos_action_propose',
          ]);
          const proposal = await propose();
          assert.equal((await stats()).writes, 0);
          await ingress(proposal.command, 'fixture-outsider');
          await pump();
          assert.equal((await stats()).writes, 0);
          await approve(proposal);
          const id = proposal.result.change.action_id;
          await wait(async () => (await state(id)) === 'verified');
          const provider = await stats();
          assert.equal(provider.writes, 1);
          assert.equal(provider.reads, 1);
          assert.equal(provider.events[0].id, proposal.result.change.event_id);
          assert.equal(provider.events[0].summary, request.title);
          assert.equal(provider.events[0].start.dateTime, request.start);
          assert.deepEqual(provider.events[0].attendees, []);
          await wait(async () => host!.delivered.some((row) => row.text.startsWith('Calendar block verified.')));
          const notice = host!.delivered.find((row) => row.text.startsWith('Calendar block verified.'))!;
          assert.equal(notice.platform, sub.messagingGroup.platform_id);
          initDb(path.join(root, 'central.db'));
          const inbound = openInboundDb(session.agent_group_id, session.id);
          const projected = inbound
            .prepare('SELECT trigger,content FROM messages_in WHERE id=?')
            .get(notice.id + ':' + session.agent_group_id) as { trigger: number; content: string };
          assert.equal(projected.trigger, 0);
          assert.match(projected.content, /Calendar block verified/);
          inbound.close();
          closeDb();
          await ingress(proposal.command);
          await pump();
          assert.equal((await stats()).writes, 1, 'replayed approval cannot create again');
          const moved = await client!.call('cos_action_propose', {
            request_id: proposal.requestId,
            request: { ...request, start: at(93600000), end: at(97200000) },
          });
          assert.equal(moved.status, 'conflict');
          const cancelled = await client!.call('cos_action_cancel', { action_id: id });
          assert.equal(cancelled.status, 'ok');
          assert.equal(cancelled.result.deleted, false);
          assert.equal((await stats()).events.length, 1, 'cancel after creation never deletes');
        },
      );
      await t.test('S09-T07 fresh conflict and revoked credentials stop an approved action', async () => {
        for (const mode of ['busy', 'revoked']) {
          await host!.request('action-fixture-mode', 'success');
          const proposal = await propose();
          await host!.request('action-fixture-mode', mode);
          const before = (await stats()).writes;
          await approve(proposal);
          await wait(async () => (await state(proposal.result.change.action_id)) === 'blocked');
          assert.equal((await stats()).writes, before);
        }
        await host!.request('action-fixture-mode', 'success');
      });
      await t.test('S09-T09 cancelled pending action cannot use its original approval', async () => {
        const proposal = await propose(),
          before = (await stats()).writes;
        const cancelled = await client!.call('cos_action_cancel', { action_id: proposal.result.change.action_id });
        assert.equal(cancelled.status, 'ok');
        assert.equal(cancelled.result.state, 'cancelled');
        await approve(proposal);
        await pump();
        assert.equal((await stats()).writes, before);
      });
      await t.test('S09-T07 subscription removal after owner decision prevents the queued effect', async () => {
        const proposal = await propose(),
          before = (await stats()).writes;
        await ingress(proposal.command);
        await host!.request('action-fixture-subscription', false);
        await pump();
        assert.equal((await stats()).writes, before);
        await host!.request('action-fixture-subscription', true);
        const cancelled = await client!.call('cos_action_cancel', { action_id: proposal.result.change.action_id });
        assert.equal(cancelled.status, 'ok');
        await complete();
        await pump();
        assert.equal((await stats()).writes, before);
      });
      await t.test(
        'S09-T05/T06 restart reconciles the original event after a lost create response without another POST',
        async () => {
          const proposal = await propose(),
            before = (await stats()).writes;
          await host!.request('action-fixture-mode', 'timeout-after-create');
          await approve(proposal);
          assert.equal(await state(proposal.result.change.action_id), 'outcome_uncertain');
          assert.equal((await stats()).writes, before + 1);
          await host!.close(true);
          await start();
          await host!.request('action-fixture-mode', 'success');
          await wait(async () => (await state(proposal.result.change.action_id)) === 'verified');
          const provider = await stats();
          assert.equal(provider.writes, before + 1);
          assert.ok(provider.events.some((event: { id: string }) => event.id === proposal.result.change.event_id));
        },
      );
      await t.test('S09-T08 a host crash after durable owner decision is repaired by the normal outbox', async () => {
        const proposal = await propose(),
          before = (await stats()).writes;
        await host!.request('crash-after-decision');
        await assert.rejects(ingress(proposal.command), /fixture_host_exited/);
        await start();
        await wait(async () => (await state(proposal.result.change.action_id)) === 'verified');
        assert.equal((await stats()).writes, before + 1);
        await complete();
      });
      await t.test(
        'S09-T06 a mismatched provider readback stays blocked and never triggers another create',
        async () => {
          const proposal = await propose(),
            before = (await stats()).writes;
          await host!.request('action-fixture-mode', 'mismatch');
          await approve(proposal);
          await wait(async () => (await state(proposal.result.change.action_id)) === 'blocked');
          await pump();
          await pump();
          assert.equal((await stats()).writes, before + 1);
          await host!.request('action-fixture-mode', 'success');
        },
      );
      await t.test(
        'S09-T07/T11 native pause closes actions while ordinary routing and tools remain available',
        async () => {
          const proposal = await propose(),
            before = (await stats()).writes;
          await ingress('cos pause automation');
          await pump();
          assert.equal(await host!.request('paused'), true);
          await ingress(proposal.command);
          await pump();
          assert.equal((await stats()).writes, before);
          assert.equal(
            await host!.request('ordinary-ingress', {
              id: randomUUID(),
              text: 'Ordinary NanoClaw chat remains available.',
            }),
            true,
          );
          const ordinaryAction = await ordinaryClient!.call('cos_action_propose', {
            request_id: randomUUID(),
            request,
          });
          assert.equal(
            ordinaryAction.status,
            'unavailable',
            'ordinary chat has no CoS RPC context even when the test directly invokes its MCP entry point',
          );
        },
      );
      const preserved = initDb(path.join(root, 'central.db'));
      assert.equal(
        (
          preserved.prepare('SELECT generation FROM cos_conversation_states WHERE scope_id=?').get(scope) as {
            generation: string;
          }
        ).generation,
        generation,
      );
      assert.equal(
        (
          preserved.prepare('SELECT used FROM cos_model_budgets WHERE activation_id=?').get(policy.activationId) as {
            used: number;
          }
        ).used,
        0,
      );
      closeDb();
      t.diagnostic(
        'This demonstration uses only native fixture routing and simulated provider state. No live provider, model or Mattermost post was used.',
      );
    } finally {
      await ordinaryClient?.close();
      await client?.close();
      await host?.close();
      closeDb();
      await database?.pool.end();
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
        await admin.end();
      }
      process.chdir(repository);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(knowledgeRoot, { recursive: true, force: true });
    }
  },
);
