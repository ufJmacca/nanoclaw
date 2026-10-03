import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtureDatabaseConfig, connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import type { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { McpFixture } from './mcp-fixture.js';
import { HostFixture } from './host-fixture-client.js';
import { renderPriorities } from '../../modules/chief-of-staff/domain/render.js';

test(
  'S01 conversation survives a host-process crash and a database partition while unrelated chat works',
  { timeout: 90000 },
  async () => {
    const repository = process.cwd(),
      hostRepository = process.env.COS_FIXTURE_HOST_ROOT,
      image = process.env.COS_FIXTURE_IMAGE;
    assert.ok(hostRepository && path.isAbsolute(hostRepository), 'explicit fixture host root required');
    assert.ok(image, 'explicit local fixture image required');
    const fixtureParent = path.join(repository, '.cos-plan-state/fixtures');
    fs.mkdirSync(fixtureParent, { recursive: true });
    const root = fs.mkdtempSync(path.join(fixtureParent, 'flow-')),
      scope = 'fixture-' + randomUUID();
    process.chdir(root);
    const { PriorityStore } = await import('../../modules/chief-of-staff/store/priorities.js');
    const { initDb, closeDb } = await import('../../db/connection.js');
    const { runMigrations } = await import('../../db/migrations/index.js');
    const { subscribeMattermostChannelStrict } = await import('../../channels/mattermost-subscription.js');
    const { resolveSession, sessionDir } = await import('../../session-manager.js');
    const { bindCoordinator } = await import('../../modules/chief-of-staff/ops/bind.js');
    let admin: Awaited<ReturnType<typeof connectFixtureDatabase>> | undefined, store: PriorityStore | undefined;
    let host: HostFixture | undefined, client: McpFixture | undefined, ordinaryClient: McpFixture | undefined;
    try {
      admin = await connectFixtureDatabase(process.env, 'migration');
      assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
      await migrate(admin, fixtureRuntimeUser());
      const runtimeCheck = await connectFixtureDatabase(process.env);
      await runtimeCheck.end();
      store = new PriorityStore(BoundedDatabase.fromConfig(await fixtureDatabaseConfig(process.env)));
      const db = initDb(path.join(root, 'central.db'));
      runMigrations(db);
      const subscription = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: scope });
      const { session } = resolveSession(subscription.agentGroup.id, subscription.messagingGroup.id, null, 'shared');
      const binding = {
        scopeId: scope,
        agentGroupId: session.agent_group_id,
        messagingGroupId: subscription.messagingGroup.id,
        sessionId: session.id,
        instanceId: 'fixture',
        channelId: scope,
        ownerId: 'fixture-owner',
        botId: 'fixture-bot',
        provider: 'codex' as const,
      };
      const facts = async () => ({
        id: scope,
        type: 'P',
        delete_at: 0,
        members: [binding.ownerId, binding.botId],
        activeSubscription: true,
      });
      await bindCoordinator(binding, { facts, bindScope: (value) => store!.bindScope(value) });
      db.exec('UPDATE cos_identity_boundaries SET paused=0');
      const ordinarySubscription = subscribeMattermostChannelStrict({
        instanceKey: 'fixture',
        channelId: scope + '-ordinary',
      });
      const ordinary = resolveSession(
        ordinarySubscription.agentGroup.id,
        ordinarySubscription.messagingGroup.id,
        null,
        'shared',
      ).session;
      const coordinatorDirectory = sessionDir(session.agent_group_id, session.id),
        ordinaryDirectory = sessionDir(ordinary.agent_group_id, ordinary.id);
      closeDb();
      const start = async () => {
        host = new HostFixture();
        await host.request('start', { root, binding, ordinarySessionId: ordinary.id });
      };
      await start();
      const ingress = (text: string, id = randomUUID()) => host!.request('ingress', { text, id });
      await ingress(
        'My goal is to launch a pilot. The active project is Pilot Alpha. Reliability is more important than adding features.',
      );
      client = new McpFixture(
        repository,
        coordinatorDirectory,
        hostRepository,
        image,
        process.env.COS_FIXTURE_RUNNER_VOLUME ?? '',
      );
      await client.start();
      const listed = await client.request('tools/list', {});
      assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name).sort(), [
        'cos_answer_get',
        'cos_answer_prepare',
        'cos_brief_request',
        'cos_brief_schedule_propose',
        'cos_calendar_read',
        'cos_change_propose',
        'cos_context_get',
        'cos_knowledge_search',
        'cos_mission_cancel',
        'cos_mission_get',
        'cos_mission_request',
        'cos_mission_result_get',
        'cos_mission_review',
        'cos_proactive_batch',
        'cos_proactive_disposition_propose',
        'cos_proactive_history',
        'cos_proactive_policy_propose',
        'cos_proactive_submit',
        'cos_request_status',
        'cos_source_change_propose',
        'cos_source_get',
        'cos_team_cancel',
        'cos_team_get',
        'cos_team_request',
        'cos_work_change_propose',
        'cos_work_read',
      ]);
      const ids: string[] = [];
      for (const [kind, title] of [
        ['charter', 'Reliability before features'],
        ['goal', 'Launch a pilot'],
        ['project', 'Pilot Alpha'],
      ] as const) {
        const proposed = await client.call('cos_change_propose', {
          request_id: randomUUID(),
          change: {
            kind,
            title,
            description: 'Fixture owner direction',
            lifecycle: 'active',
            reason: 'Explicit fixture request',
            expected_version: 0,
          },
        });
        assert.equal(proposed.status, 'ok');
        assert.equal(proposed.result.confirmation_token, undefined);
        const before = await client.call('cos_context_get', { view: 'today' });
        assert.equal(before.status, 'ok');
        assert.equal(before.result.records.length, ids.length);
        await host!.request('pump');
        const preview = host!.delivered.find((item) => item.id === 'cos-' + proposed.result.proposal_id);
        assert.ok(preview);
        assert.ok(await host!.request('approval', preview.id));
        const command = preview.text.split('\n').find((line) => line.startsWith('cos approve '));
        assert.ok(command);
        const approvalId = randomUUID();
        if (kind === 'charter') {
          await host!.request('crash-after-decision');
          await assert.rejects(ingress(command, approvalId), /fixture_host_exited/);
          await start();
          assert.ok(
            await host!.request('approval', preview.id),
            'durable decision preceded its lost UI acknowledgement',
          );
        } else await ingress(command, approvalId);
        await ingress(command, approvalId);
        assert.equal(await host!.request('approval', preview.id), null);
        await host!.request('pump');
        ids.push(proposed.result.proposal_id);
      }
      await ingress('What should I focus on?');
      const beforeRestart = await client.call('cos_context_get', { view: 'today' });
      assert.equal(beforeRestart.status, 'ok');
      assert.equal(beforeRestart.result.records.length, 3);
      assert.ok(
        beforeRestart.result.records.every((record: { provenance: { proposal_id: string } }) =>
          ids.includes(record.provenance.proposal_id),
        ),
      );
      const oldPid = host!.process.pid;
      await host!.close(true);
      await start();
      assert.notEqual(host!.process.pid, oldPid);
      await ingress('What should I focus on after restarting?');
      const afterRestart = await client.call('cos_context_get', { view: 'today' });
      assert.deepEqual(afterRestart.result, beforeRestart.result);
      const brief = renderPriorities({ status: afterRestart.status, ...afterRestart.result });
      await client.reply(brief, subscription.messagingGroup.platform_id);
      const waitForReply = async (text: string) => {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline && !host!.delivered.some((item) => item.text === text))
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(host!.delivered.some((item) => item.text === text));
      };
      await waitForReply(brief);
      ordinaryClient = new McpFixture(
        repository,
        ordinaryDirectory,
        hostRepository,
        image,
        process.env.COS_FIXTURE_RUNNER_VOLUME ?? '',
      );
      await ordinaryClient.start();
      await host!.request('partition');
      const unavailable = client.call('cos_context_get', { view: 'today' });
      assert.ok(await host!.request('ordinary-ingress', { text: 'Unrelated fixture chat', id: randomUUID() }));
      await ordinaryClient.reply('Unrelated chat remains available.', ordinarySubscription.messagingGroup.platform_id);
      await waitForReply('Unrelated chat remains available.');
      assert.equal((await unavailable).status, 'unavailable');
      await host!.request('restore');
      const restored = await client.call('cos_context_get', { view: 'today' });
      assert.deepEqual(restored.result, beforeRestart.result);
      await ingress('cos pause automation');
      assert.equal(await host!.request('paused'), true);
      console.log(
        JSON.stringify({
          scenario: 'S01',
          hostProcessRestart: 'passed',
          lostApprovalAcknowledgement: 'passed',
          partitionWithUnrelatedChat: 'passed',
          approvedRecords: 3,
          transport: 'container-mcp',
          model: 'fixture',
        }),
      );
    } finally {
      await ordinaryClient?.close();
      await client?.close();
      await host?.close();
      await store?.database.pool.end();
      if (admin) {
        try {
          for (const table of ['outbox', 'events', 'operations', 'proposals', 'records'])
            await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
          await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
        } finally {
          await admin.end();
        }
      }
      closeDb();
      process.chdir(repository);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
