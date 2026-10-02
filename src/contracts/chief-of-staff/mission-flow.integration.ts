/** Full owner/worker/review flow using native containers and an admitted external test database. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import type { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { createConversationState } from '../../modules/chief-of-staff/bridge/conversation-state.js';
import { ensureModelBudget } from '../../modules/chief-of-staff/bridge/model-policy.js';
import { issueActivation } from '../../modules/chief-of-staff/ops/model-activation.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import { HostFixture } from './host-fixture-client.js';
import { McpFixture } from './mcp-fixture.js';

test(
  'S05 demo owner approves research, native specialist submits, main context reviews and notifies once',
  { timeout: 120000 },
  async (t) => {
    const repository = process.cwd(),
      hostRepository = process.env.COS_FIXTURE_HOST_ROOT,
      image = process.env.COS_FIXTURE_IMAGE;
    assert.ok(hostRepository && path.isAbsolute(hostRepository) && image);
    const parent = path.join(repository, '.cos-plan-state/fixtures');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'flow-s05-')),
      knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-knowledge-demo-')),
      scope = 'demo-mission-' + randomUUID();
    for (const name of ['artifacts', 'staging']) fs.mkdirSync(path.join(knowledgeRoot, name), { mode: 0o700 });
    process.chdir(root);
    const { PriorityStore } = await import('../../modules/chief-of-staff/store/priorities.js');
    const { initDb, closeDb } = await import('../../db/connection.js'),
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
      const knowledge = new KnowledgeStore(
          database,
          new KnowledgeArtifacts(path.join(knowledgeRoot, 'artifacts'), path.join(knowledgeRoot, 'staging')),
        ),
        store = new PriorityStore(database, knowledge);
      const db = initDb(path.join(root, 'central.db'));
      runMigrations(db);
      const sub = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: scope }),
        session = resolveSession(sub.agentGroup.id, sub.messagingGroup.id, null, 'shared').session,
        other = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: scope + '-ordinary' }),
        ordinary = resolveSession(other.agentGroup.id, other.messagingGroup.id, null, 'shared').session;
      const binding = {
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
        bindScope: (value) => store.bindScope(value),
      });
      const generation = createConversationState(knowledgeRoot, db).prepare(binding, 'a'.repeat(64)).generation;
      ensureModelBudget(db);
      issueActivation(
        { root: knowledgeRoot, db, binding, accountFingerprint: 'a'.repeat(64), assertAuthority() {} },
        {
          version: 2,
          runtime: 'codex-subscription/v1',
          activationId: randomUUID().replaceAll('-', ''),
          consentRef: 'Synthetic S05 fixture only; no provider access',
          scopeId: scope,
          provider: 'codex',
          model: 'fixture-model',
          maxAttempts: 8,
          expiresAt: new Date(Date.now() + 180000).toISOString(),
          accountFingerprint: 'a'.repeat(64),
          contextGeneration: generation,
        },
      );
      db.prepare('UPDATE cos_identity_boundaries SET paused=0 WHERE scope_id=?').run(scope);
      const coordinatorDirectory = sessionDir(session.agent_group_id, session.id);
      assert.ok(coordinatorDirectory.startsWith(root + '/'));
      const ordinaryDirectory = sessionDir(ordinary.agent_group_id, ordinary.id);
      fs.mkdirSync(ordinaryDirectory, { recursive: true });
      openInboundDb(ordinary.agent_group_id, ordinary.id).close();
      closeDb();
      await admin.query(
        'INSERT INTO cos.mission_template_versions(scope_id,id,version,body,digest,reviewed_by,provenance) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          scope,
          RESEARCH_TEMPLATE.id,
          RESEARCH_TEMPLATE.version,
          JSON.stringify(RESEARCH_TEMPLATE),
          digest(RESEARCH_TEMPLATE),
          'fixture-operator',
          '{}',
        ],
      );
      fs.writeFileSync(
        path.join(knowledgeRoot, 'staging', 'note.md'),
        'Pilot Alpha: Option A costs less; Option B has more capacity.',
        { mode: 0o600 },
      );
      const source = await knowledge.importSource({ ...binding, ingressId: 'fixture-import' }, randomUUID(), {
        sourceKey: 'note',
        filename: 'note.md',
        title: 'Pilot Alpha alternatives',
        processingProviders: ['codex'],
        expectedVersion: 0,
      });
      assert.equal(source.status, 'ok');
      host = new HostFixture();
      const hostInput = {
        root,
        binding,
        ordinarySessionId: ordinary.id,
        knowledgeRoot,
        mission: {
          repository,
          hostRepository,
          image,
          sourceRoot: process.env.COS_FIXTURE_SOURCE_ROOT,
          runnerVolume: process.env.COS_FIXTURE_RUNNER_VOLUME,
          authority: {
            bindingDigest: digest(binding),
            delegationDigest: digest('fixture-reviewed-delegation'),
            contextGeneration: generation,
            provider: {
              profile: RESEARCH_TEMPLATE.providerProfile,
              model: 'fixture-model',
              policyDigest: digest('fixture-model-consent'),
            },
          },
        },
      };
      await host.request('start', hostInput);
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
      const ingress = async (text: string) => {
        await host!.request('ingress', { id: randomUUID(), text });
      };
      const complete = async () => {
        const ids = await client!.completePending();
        await host!.request('sync-acks');
        return ids;
      };
      const pump = async () => {
        try {
          return await host!.request('pump');
        } catch (error) {
          // Docker may still be removing an exact stopped orphan; observe again under the flow deadline.
          if (error instanceof Error && error.message === 'fixture_host_command_failed:mission_recovery_pending')
            return false;
          throw new Error(
            'mission_flow_failed:' +
              (error instanceof Error ? error.message : 'unknown') +
              ':' +
              JSON.stringify(await host!.request('mission-diagnostics')),
            {
              cause: error,
            },
          );
        }
      };
      const wait = async (check: () => Promise<boolean>) => {
        const end = Date.now() + 15000;
        while (Date.now() < end) {
          await pump();
          if (await check()) return;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        assert.fail('mission flow deadline');
      };
      await ingress('Compare the alternatives in the admitted note and recommend an approach for Pilot Alpha.');
      const requested = await client.call('cos_mission_request', {
        request_id: randomUUID(),
        request: {
          question: 'Compare alternatives for Pilot Alpha.',
          goal_id: null,
          project_id: null,
          sources: [{ source_id: String(source.source_id), revision_id: String(source.revision_id) }],
          acceptance_criteria: [{ id: 'tradeoff', description: 'Cite the cost and capacity comparison.' }],
          limits: { ...MISSION_DEFAULT_LIMITS },
        },
      });
      assert.equal(requested.status, 'ok');
      const missionId = String(requested.result.mission_id);
      const attempts = async () =>
        (
          await admin!.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1 AND mission_id=$2', [
            scope,
            missionId,
          ])
        ).rows;
      assert.equal(
        (await attempts()).length,
        0,
        'request returns promptly and does not allocate before owner approval',
      );
      await complete();
      await pump();
      const preview = host.delivered.find((row) => row.id === 'cos-' + requested.result.proposal_id);
      assert.ok(preview);
      const command = preview.text.split('\n').find((line) => line.startsWith('cos approve '));
      assert.ok(command);
      await ingress(command);
      await pump();
      await complete();
      await wait(async () => {
        const rows = await attempts();
        return rows.length === 1 && rows[0].state === 'submitted' && rows[0].allocation.stop_confirmed === true;
      });
      const attempt = (await attempts())[0];
      assert.equal(attempt.allocation.stop_confirmed, true, 'completed native worker reconciled before review');
      assert.equal(
        await host.request('ordinary-ingress', { id: randomUUID(), text: 'Ordinary chat remains available' }),
        true,
      );
      assert.equal(
        (await admin.query('SELECT count(*) FROM cos.mission_reviews WHERE scope_id=$1', [scope])).rows[0].count,
        '0',
      );
      const submission = (
        await admin.query('SELECT * FROM cos.mission_result_submissions WHERE scope_id=$1 AND mission_id=$2', [
          scope,
          missionId,
        ])
      ).rows[0];
      assert.ok(submission);
      await wait(async () => await host!.request('mission-review-ready'));
      assert.equal(await host.request('reserve-fixture-review', randomUUID()), true);
      const read = await client.call('cos_mission_result_get', { mission_id: missionId, submission_id: submission.id });
      assert.equal(read.status, 'ok');
      const reviewed = await client.call('cos_mission_review', {
        request_id: randomUUID(),
        review: {
          mission_id: missionId,
          submission_id: submission.id,
          result_digest: submission.digest,
          expected_version: read.result.mission.version,
          decision: 'accept',
          criteria: [{ id: 'tradeoff', verdict: 'satisfied' }],
        },
      });
      assert.equal(reviewed.status, 'ok');
      assert.ok((await complete()).some((id) => id.startsWith('cos-mission-review-')));
      await wait(async () => host!.delivered.some((row) => row.id === 'mission-review-' + reviewed.result.review_id));
      await pump();
      await pump();
      const notices = host.delivered.filter((row) => row.id === 'mission-review-' + reviewed.result.review_id);
      assert.equal(notices.length, 1);
      assert.match(notices[0].text, /Pilot Alpha/);
      assert.equal(notices[0].platform, sub.messagingGroup.platform_id);
      assert.equal(
        (await admin.query('SELECT state FROM cos.missions WHERE scope_id=$1 AND id=$2', [scope, missionId])).rows[0]
          .state,
        'completed',
      );
      assert.equal((await attempts()).length, 1);
      assert.equal((await attempts())[0].id, attempt.id);
      const finished = (await host.request('mission-states')).find((row: any) => row.identity.attemptId === attempt.id);
      assert.deepEqual(finished.isolation, { databaseNetworkDenied: true, databaseEnvironmentAbsent: true });
      t.diagnostic('Reviewed notification delivered once; worker database network and credential checks passed.');
      for (const failure of ['cancel', 'outage', 'crash'] as const) {
        await host.request('mission-hold-next');
        await ingress('Compare Pilot Alpha again; exercise fixture ' + failure + '.');
        const proposal: any = await client.call('cos_mission_request', {
          request_id: randomUUID(),
          request: {
            question: 'Compare alternatives for Pilot Alpha: ' + failure + '.',
            goal_id: null,
            project_id: null,
            sources: [{ source_id: String(source.source_id), revision_id: String(source.revision_id) }],
            acceptance_criteria: [{ id: 'tradeoff', description: 'Cite the cost and capacity comparison.' }],
            limits: { ...MISSION_DEFAULT_LIMITS },
          },
        });
        assert.equal(proposal.status, 'ok');
        await complete();
        await pump();
        const approval = host.delivered
          .find((row) => row.id === 'cos-' + proposal.result.proposal_id)
          ?.text.split('\n')
          .find((line) => line.startsWith('cos approve '));
        assert.ok(approval);
        await ingress(approval);
        await pump();
        await complete();
        const heldState = async () =>
          (await host!.request('mission-states')).find(
            (row: any) => row.identity.missionId === proposal.result.mission_id,
          );
        await wait(async () => {
          const current = await heldState();
          return !!current?.draft && current.running;
        });
        const held = await heldState(),
          identity = held.identity;
        assert.deepEqual(held.isolation, { databaseNetworkDenied: true, databaseEnvironmentAbsent: true });
        const before: any = (
          await admin.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1 AND id=$2', [
            scope,
            identity.attemptId,
          ])
        ).rows[0];
        const budget = async () =>
          (
            await admin!.query(
              'SELECT * FROM cos.mission_budget_reservations WHERE scope_id=$1 AND mission_id=$2 ORDER BY call_id',
              [scope, identity.missionId],
            )
          ).rows;
        const charged = await budget();
        assert.ok(charged.length >= 2, 'real model and context calls charged before failure');
        assert.equal(
          await host.request('ordinary-ingress', { id: randomUUID(), text: 'Ordinary chat while specialist runs' }),
          true,
        );
        if (failure === 'cancel') {
          await ingress('Cancel this running research mission.');
          const cancelled: any = await client.call('cos_mission_cancel', {
            mission_id: identity.missionId,
          });
          assert.equal(cancelled.status, 'ok');
          await complete();
          await pump();
        } else if (failure === 'outage') {
          await host.request('partition');
          await assert.rejects(pump, /mission_flow_failed/);
          assert.equal((await heldState()).running, false, 'database uncertainty stops the exact running specialist');
          assert.equal(
            await host.request('ordinary-ingress', { id: randomUUID(), text: 'Ordinary chat during database loss' }),
            true,
          );
          await host.request('restore');
          await pump();
        } else {
          await host.close(true);
          host = new HostFixture();
          await host.request('start', hostInput);
          await pump();
        }
        await wait(async () => {
          const row = (
            await admin!.query('SELECT allocation FROM cos.mission_attempts WHERE scope_id=$1 AND id=$2', [
              scope,
              identity.attemptId,
            ])
          ).rows[0];
          return row.allocation.stop_confirmed === true && !(await heldState()).running;
        });
        assert.deepEqual(await budget(), charged, 'recovery preserves consumed root budget');
        const late = await host.request('mission-stale-submit', {
          identity,
          lease: { owner: before.lease_owner, fence: before.allocation.dispatch_fence },
          requestId: randomUUID(),
          callId: randomUUID(),
          result: held.draft,
        });
        assert.equal(late.status, 'denied', 'fenced generation refuses the original worker result');
        const after: any[] = (
          await admin.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1 AND mission_id=$2', [
            scope,
            identity.missionId,
          ])
        ).rows;
        assert.equal(after.length, 1);
        assert.equal(after[0].id, before.id);
        assert.equal(after[0].input_id, before.input_id);
        assert.equal(
          (
            await admin.query(
              'SELECT count(*) FROM cos.mission_result_submissions WHERE scope_id=$1 AND mission_id=$2',
              [scope, identity.missionId],
            )
          ).rows[0].count,
          '0',
        );
        assert.equal(
          (await admin.query('SELECT state FROM cos.missions WHERE scope_id=$1 AND id=$2', [scope, identity.missionId]))
            .rows[0].state,
          failure === 'cancel' ? 'cancelled' : 'failed',
        );
        assert.equal(
          await host.request('ordinary-ingress', { id: randomUUID(), text: 'Ordinary chat after recovery' }),
          true,
        );
        assert.ok(
          (await ordinaryClient.request('tools/list', {})).tools.length > 0,
          'unrelated native fixture container remains responsive',
        );
        t.diagnostic(failure + ': exact stop confirmed, attempt and budget retained, stale submission denied.');
      }
    } finally {
      await ordinaryClient?.close();
      await client?.close();
      await host?.close();
      closeDb();
      await database?.pool.end();
      if (admin) {
        await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
        for (const table of [
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
          await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
        await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
        await admin.end();
      }
      process.chdir(repository);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(knowledgeRoot, { recursive: true, force: true });
    }
  },
);
