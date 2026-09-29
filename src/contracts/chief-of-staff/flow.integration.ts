import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDatabaseConfig } from '../../modules/chief-of-staff/store/config.js';
import { connectChecked } from '../../modules/chief-of-staff/store/preflight.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { McpFixture } from './mcp-fixture.js';
import { renderPriorities } from '../../modules/chief-of-staff/domain/render.js';

test(
  'S01 fixture conversation traverses container MCP, native delivery, SQLite approvals and external PostgreSQL',
  { timeout: 90000 },
  async () => {
    const repository = process.cwd();
    const hostRepository = process.env.COS_FIXTURE_HOST_ROOT;
    assert.ok(hostRepository && path.isAbsolute(hostRepository), 'explicit fixture host root required');
    const image = process.env.COS_FIXTURE_IMAGE;
    assert.ok(image, 'explicit local fixture image required');
    const fixtureParent = path.join(repository, '.cos-plan-state/fixtures');
    fs.mkdirSync(fixtureParent, { recursive: true });
    const root = fs.mkdtempSync(path.join(fixtureParent, 'flow-'));
    process.chdir(root);
    const { initDb, closeDb } = await import('../../db/connection.js');
    const { runMigrations } = await import('../../db/migrations/index.js');
    const { subscribeMattermostChannelStrict } = await import('../../channels/mattermost-subscription.js');
    const { resolveSession, sessionDir } = await import('../../session-manager.js');
    const { getSession, getPendingApproval } = await import('../../db/sessions.js');
    const { getMessagingGroup } = await import('../../db/messaging-groups.js');
    const { bindCoordinator } = await import('../../modules/chief-of-staff/ops/bind.js');
    const { createCosRuntime } = await import('../../modules/chief-of-staff/runtime.js');
    const { setDeliveryAdapter, startDeliveryIntake, deliverSessionMessages, stopAndDrainDeliveryPolls } =
      await import('../../delivery.js');
    const { routeInbound } = await import('../../router.js');
    const db = initDb(path.join(root, 'central.db'));
    runMigrations(db);
    const scope = 'fixture-' + randomUUID();
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
    const admin = await connectChecked(process.env, 'test', 'migration');
    assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
    await migrate(admin, process.env.COS_TEST_PGUSER!);
    const runtimeCheck = await connectChecked(process.env, 'test');
    await runtimeCheck.end();
    const store = new PriorityStore(BoundedDatabase.fromConfig(parseDatabaseConfig(process.env, 'test')));
    const facts = async () => ({
      id: scope,
      type: 'P',
      delete_at: 0,
      members: [binding.ownerId, binding.botId],
      activeSubscription: true,
    });
    assert.deepEqual(await bindCoordinator(binding, { facts, bindScope: (value) => store.bindScope(value) }), binding);
    session.agent_provider = 'codex';
    // Fixture-only admission after setup; the real target helper owns live maintenance admission.
    db.exec('UPDATE cos_identity_boundaries SET paused=0');
    const delivered: Array<{ text: string; id: string }> = [];
    setDeliveryAdapter({
      deliver: async (type, platform, _thread, _kind, content, _files, id) => {
        assert.equal(type, 'mattermost');
        assert.equal(platform, subscription.messagingGroup.platform_id);
        if (!delivered.some((item) => item.id === id)) delivered.push({ text: JSON.parse(content).text, id: id! });
        return id;
      },
    });
    startDeliveryIntake();
    const dependencies = {
      db,
      enabled: true,
      store,
      facts,
      session: getSession,
      destination: getMessagingGroup,
      stop: () => {},
    };
    let runtime = createCosRuntime(dependencies);
    const ingress = async (text: string, id = randomUUID()) =>
      routeInbound({
        channelType: 'mattermost',
        platformId: subscription.messagingGroup.platform_id,
        threadId: null,
        message: {
          id,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ senderId: 'mattermost:' + binding.ownerId, text }),
        },
      });
    let client: McpFixture | undefined;
    let draining = false;
    const timer = setInterval(() => {
      if (!draining) {
        draining = true;
        void deliverSessionMessages(session).finally(() => {
          draining = false;
        });
      }
    }, 20);
    try {
      await ingress(
        'My goal is to launch a pilot. The active project is Pilot Alpha. Reliability is more important than adding features.',
      );
      client = new McpFixture(
        repository,
        sessionDir(session.agent_group_id, session.id),
        hostRepository,
        image,
        process.env.COS_FIXTURE_RUNNER_VOLUME ?? '',
      );
      await client.start();
      const listed = await client.request('tools/list', {});
      assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name).sort(), [
        'cos_change_propose',
        'cos_context_get',
        'cos_request_status',
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
        await runtime.pump(binding);
        const preview = delivered.find((item) => item.id === 'cos-' + proposed.result.proposal_id);
        assert.ok(preview);
        assert.ok(getPendingApproval(preview.id));
        const command = preview.text.split('\n').find((line) => line.startsWith('cos approve '));
        assert.ok(command);
        const approvalId = randomUUID();
        await ingress(command, approvalId);
        await ingress(command, approvalId);
        assert.equal(getPendingApproval(preview.id), undefined);
        await runtime.pump(binding);
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
      runtime.dispose();
      runtime = createCosRuntime(dependencies);
      const afterRestart = await client.call('cos_context_get', { view: 'today' });
      assert.deepEqual(afterRestart.result, beforeRestart.result);
      const brief = renderPriorities({ status: afterRestart.status, ...afterRestart.result });
      await client.reply(brief, subscription.messagingGroup.platform_id);
      const replyDeadline = Date.now() + 2000;
      while (Date.now() < replyDeadline && !delivered.some((message) => message.text === brief)) {
        await deliverSessionMessages(session);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(
        delivered.some(
          (message) => message.text.includes('Deterministic priority view') && message.text.includes('Pilot Alpha'),
        ),
      );
      await ingress('cos pause automation');
      assert.equal(
        db.prepare('SELECT paused FROM cos_identity_boundaries').get() &&
          (db.prepare('SELECT paused FROM cos_identity_boundaries').get() as { paused: number }).paused,
        1,
      );
    } finally {
      clearInterval(timer);
      await stopAndDrainDeliveryPolls();
      await client?.close();
      runtime.dispose();
      await store.database.pool.end();
      for (const table of ['outbox', 'events', 'operations', 'proposals', 'records'])
        await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
      await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
      await admin.end();
      closeDb();
      process.chdir(repository);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
