/** S06 vertical demonstrations: native workers, the original main context and fixture-only delivery. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { createConversationState } from '../../modules/chief-of-staff/bridge/conversation-state.js';
import { ensureModelBudget } from '../../modules/chief-of-staff/bridge/model-policy.js';
import { issueActivation } from '../../modules/chief-of-staff/ops/model-activation.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import { TEAM_DEFAULT_LIMITS, type TeamRequest } from '../../modules/chief-of-staff/contracts/team-protocol.js';
import { TEAM_TEMPLATES } from '../../modules/chief-of-staff/contracts/team-templates.js';
import { TEAM_ADMISSION_POLICY } from '../../modules/chief-of-staff/missions/team-admission.js';
import { installReviewedTeamTemplates } from '../../modules/chief-of-staff/missions/template-admin.js';
import { HostFixture } from './host-fixture-client.js';
import { McpFixture } from './mcp-fixture.js';

test('S06 native team demonstrations', { timeout: 360000 }, async (t) => {
  const repository = process.cwd(),
    hostRepository = process.env.COS_FIXTURE_HOST_ROOT,
    image = process.env.COS_FIXTURE_IMAGE;
  assert.ok(hostRepository && path.isAbsolute(hostRepository) && image);
  const parent = path.join(repository, '.cos-plan-state/fixtures');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'flow-s06-')),
    knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-knowledge-demo-')),
    scope = 'demo-team-' + randomUUID();
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
      bindScope: (v) => store.bindScope(v),
    });
    const generation = createConversationState(knowledgeRoot, db).prepare(binding, 'a'.repeat(64)).generation;
    ensureModelBudget(db);
    issueActivation(
      { root: knowledgeRoot, db, binding, accountFingerprint: 'a'.repeat(64), assertAuthority() {} },
      {
        version: 2,
        runtime: 'codex-subscription/v1',
        activationId: randomUUID().replaceAll('-', ''),
        consentRef: 'Synthetic S06 fixture only; no provider access',
        scopeId: scope,
        provider: 'codex',
        model: 'fixture-model',
        maxAttempts: 8,
        expiresAt: new Date(Date.now() + 420000).toISOString(),
        accountFingerprint: 'a'.repeat(64),
        contextGeneration: generation,
      },
    );
    db.prepare('UPDATE cos_identity_boundaries SET paused=0 WHERE scope_id=?').run(scope);
    const coordinatorDirectory = sessionDir(session.agent_group_id, session.id),
      ordinaryDirectory = sessionDir(ordinary.agent_group_id, ordinary.id);
    assert.ok(coordinatorDirectory.startsWith(root + '/'));
    fs.mkdirSync(ordinaryDirectory, { recursive: true });
    openInboundDb(ordinary.agent_group_id, ordinary.id).close();
    closeDb();
    await installReviewedTeamTemplates(admin, binding, randomUUID(), {
      expectedRevision: 0,
      enabled: true,
      templateBundleDigest: digest(TEAM_TEMPLATES),
      policyDigest: digest(TEAM_ADMISSION_POLICY),
      reviewRef: 'fixture-reviewed-S06-team',
    });
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
    host = new HostFixture({ nativeCapacity: 3 });
    await host.request('start', {
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
        team: { templateBundleDigest: digest(TEAM_TEMPLATES), teamPolicyDigest: digest('fixture-reviewed-team') },
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
    });
    client = new McpFixture(
      repository,
      coordinatorDirectory,
      hostRepository,
      image,
      process.env.COS_FIXTURE_RUNNER_VOLUME ?? '',
    );
    ordinaryClient = new McpFixture(
      repository,
      ordinaryDirectory,
      hostRepository,
      image,
      process.env.COS_FIXTURE_RUNNER_VOLUME ?? '',
    );
    await client.start();
    await ordinaryClient.start();
    const ingress = (text: string) => host!.request('ingress', { id: randomUUID(), text }),
      complete = async () => {
        const ids = await client!.completePending();
        await host!.request('sync-acks');
        return ids;
      },
      pump = async () => {
        try {
          await host!.request('pump');
        } catch (error) {
          if (error instanceof Error && error.message === 'fixture_host_command_failed:mission_recovery_pending')
            return;
          throw new Error(
            'team_flow_failed:' +
              (error instanceof Error ? error.message : 'unknown') +
              ':' +
              JSON.stringify(await host!.request('mission-diagnostics')),
            { cause: error },
          );
        }
      },
      wait = async (check: () => Promise<boolean>) => {
        const end = Date.now() + 45000;
        while (Date.now() < end) {
          await pump();
          if (await check()) return;
          await new Promise((r) => setTimeout(r, 30));
        }
        const native = (await host!.request('mission-states')).map((s: any) => ({
          attempt: s.identity.attemptId,
          running: s.running,
          released: s.released,
          draft: !!s.draft,
          submission: s.submission?.status,
          diagnostic: s.diagnostic,
        }));
        assert.fail(
          'team flow deadline:' + JSON.stringify({ ...(await host!.request('mission-diagnostics')), native }),
        );
      },
      rows = async (table: string, teamId: string) =>
        (
          await admin!.query(
            `SELECT * FROM cos.${table} WHERE scope_id=$1 AND ${table === 'mission_team_roots' ? 'id' : 'team_id'}=$2`,
            [scope, teamId],
          )
        ).rows,
      attempts = async (teamId: string) =>
        (
          await admin!.query(
            `SELECT a.*,c.step_id FROM cos.mission_attempts a JOIN cos.mission_team_children c ON c.scope_id=a.scope_id AND c.mission_id=a.mission_id WHERE c.scope_id=$1 AND c.team_id=$2 ORDER BY c.step_id,a.id`,
            [scope, teamId],
          )
        ).rows,
      responsive = async () => {
        assert.equal(
          await host!.request('ordinary-ingress', { id: randomUUID(), text: 'Ordinary chat while the team runs' }),
          true,
        );
        assert.ok((await ordinaryClient!.request('tools/list', {})).tools.length > 0);
      };
    const request = (scenario: string): TeamRequest => {
      const sources = [{ source_id: String(source.source_id), revision_id: String(source.revision_id) }],
        acceptance_criteria = [{ id: 'tradeoff', description: 'Compare cost and capacity, preserving disagreement.' }],
        step = (step_id: string, template_id: keyof typeof TEAM_TEMPLATES, depends_on: string[] = []) => ({
          step_id,
          template_id,
          template_version: 1 as const,
          depends_on,
          input_artifact_refs: depends_on.map((step_id) => ({ step_id, result_schema: 'cos-research-result/v1' })),
          sources,
          required: true,
          acceptance_criteria,
          result_schema: TEAM_TEMPLATES[template_id].resultSchema as 'cos-research-result/v1' | 'cos-team-review/v1',
          max_rework_count: 0 as const,
          limits: { ...MISSION_DEFAULT_LIMITS, max_attempts: 1 },
        });
      return {
        question: 'Compare Pilot Alpha: ' + scenario + '.',
        goal_id: null,
        project_id: null,
        sources,
        acceptance_criteria,
        limits: { ...TEAM_DEFAULT_LIMITS },
        partial_policy: scenario === 'failure' ? 'allow_labelled' : 'block',
        steps: [
          step('technical', 'team-technical-analyst'),
          step('operations', 'team-operational-analyst'),
          step('synthesis', 'team-writer', ['technical', 'operations']),
          step('review', 'team-reviewer', ['technical', 'operations', 'synthesis']),
        ],
      };
    };
    for (const scenario of ['success', 'failure', 'cancel'] as const)
      await t.test(scenario, async () => {
        await host!.request('mission-hold-next');
        if (scenario === 'failure') await host!.request('mission-fail-step', 'technical');
        await ingress('Compare technical and operational alternatives for Pilot Alpha: ' + scenario + '.');
        const requested = await client!.call('cos_team_request', {
          request_id: randomUUID(),
          request: request(scenario),
        });
        assert.equal(requested.status, 'ok', JSON.stringify(requested));
        const teamId = String(requested.result.team_id);
        assert.equal((await attempts(teamId)).length, 0, 'no worker before owner approval');
        await complete();
        await pump();
        const command = host!.delivered
          .find((r) => r.id === 'cos-' + requested.result.proposal_id)
          ?.text.split('\n')
          .find((l) => l.startsWith('cos approve '));
        assert.ok(command);
        await ingress(command);
        await pump();
        await complete();
        const states = async () => {
          const ids = new Set((await attempts(teamId)).map((a) => a.id));
          return (await host!.request('mission-states')).filter((s: any) => ids.has(s.identity.attemptId));
        };
        await wait(
          async () =>
            (await attempts(teamId)).length === 2 &&
            (await states()).filter((s: any) => s.draft && s.running).length === (scenario === 'failure' ? 1 : 2),
        );
        const initial = await attempts(teamId);
        assert.deepEqual(
          initial.map((a) => a.step_id).sort(),
          ['operations', 'technical'],
          'only independent analysts admitted',
        );
        const held = await states();
        for (const s of held)
          assert.deepEqual(s.isolation, { databaseNetworkDenied: true, databaseEnvironmentAbsent: true });
        if (scenario !== 'failure')
          assert.equal(held.filter((s: any) => s.running).length, 2, 'two native containers run concurrently');
        const budget = async () =>
          (
            await admin!.query(
              `SELECT b.* FROM cos.mission_budget_reservations b JOIN cos.mission_team_children c ON c.scope_id=b.scope_id AND c.mission_id=b.mission_id WHERE c.scope_id=$1 AND c.team_id=$2 ORDER BY b.call_id`,
              [scope, teamId],
            )
          ).rows;
        await responsive();
        if (scenario === 'cancel') {
          const charged = await budget();
          await ingress('Cancel the whole team graph.');
          const cancelled = await client!.call('cos_team_cancel', { team_id: teamId });
          assert.ok(['ok', 'pending'].includes(cancelled.status));
          await complete();
          await wait(async () => (await rows('mission_team_roots', teamId))[0].state === 'cancelled');
          assert.ok((await attempts(teamId)).every((a) => a.allocation.stop_confirmed === true));
          assert.ok((await states()).every((s: any) => !s.running));
          assert.deepEqual(await budget(), charged, 'cancellation retains every consumed original call');
          for (const s of held) {
            const a = initial.find((a) => a.id === s.identity.attemptId)!;
            assert.equal(
              (
                await host!.request('mission-stale-submit', {
                  identity: s.identity,
                  lease: { owner: a.lease_owner, fence: a.allocation.dispatch_fence },
                  requestId: randomUUID(),
                  callId: randomUUID(),
                  result: s.draft,
                })
              ).status,
              'denied',
            );
          }
          await pump();
          await pump();
          assert.equal((await attempts(teamId)).length, 2);
          assert.equal(
            (await rows('mission_team_children', teamId)).length,
            2,
            'no descendant allocation after cancellation',
          );
          assert.equal((await rows('mission_team_reviews', teamId)).length, 0);
          assert.equal(
            (await rows('mission_team_root_budget_events', teamId)).filter((e) => e.kind === 'released').length,
            1,
          );
        } else {
          await host!.request('mission-release-held');
          await wait(async () => (await rows('mission_team_roots', teamId))[0].state === 'awaiting_review');
          const done = await attempts(teamId);
          assert.equal(done.length, 4);
          assert.ok(done.every((a) => a.allocation.stop_confirmed === true));
          assert.equal(new Set(done.map((a) => a.session_id)).size, 4, 'every specialist has a fresh native context');
          await wait(async () => await host!.request('mission-review-ready'));
          assert.equal(await host!.request('reserve-fixture-review', randomUUID()), true);
          const reviewer = done.find((a) => a.step_id === 'review')!,
            submission = (
              await admin!.query('SELECT id FROM cos.mission_result_submissions WHERE scope_id=$1 AND attempt_id=$2', [
                scope,
                reviewer.id,
              ])
            ).rows[0];
          assert.ok(submission, JSON.stringify({ attempts: done, native: await states() }));
          const read = await client!.call('cos_mission_result_get', {
            mission_id: teamId,
            submission_id: submission.id,
          });
          assert.equal(read.status, 'ok');
          assert.equal(read.result.result.format, 'cos-team-brief/v1');
          assert.equal(read.result.result.outputs.length, 4);
          if (scenario === 'failure') {
            assert.ok(
              read.result.result.outputs.some(
                (s: any) => s.step_id === 'technical' && s.state === 'failed' && s.required,
              ),
            );
            assert.match(read.result.result.limitations.join(' '), /Missing required step technical/);
            const completeJudgement = await client!.call('cos_mission_review', {
              request_id: randomUUID(),
              review: {
                mission_id: teamId,
                submission_id: submission.id,
                result_digest: read.result.submission.digest,
                expected_version: read.result.mission.version,
                decision: 'accept',
                criteria: [{ id: 'tradeoff', verdict: 'satisfied' }],
              },
            });
            assert.equal(completeJudgement.status, 'denied', 'required missing work cannot be approved as complete');
          } else assert.deepEqual(read.result.result.limitations, []);
          const reviewed = await client!.call('cos_mission_review', {
            request_id: randomUUID(),
            review: {
              mission_id: teamId,
              submission_id: submission.id,
              result_digest: read.result.submission.digest,
              expected_version: read.result.mission.version,
              decision: scenario === 'failure' ? 'partial' : 'accept',
              criteria: [{ id: 'tradeoff', verdict: scenario === 'failure' ? 'partial' : 'satisfied' }],
            },
          });
          assert.equal(reviewed.status, 'ok');
          assert.equal(reviewed.result.state, scenario === 'failure' ? 'partial' : 'completed');
          assert.ok((await complete()).some((id) => id.startsWith('cos-mission-review-')));
          await wait(async () => host!.delivered.some((r) => r.id === 'team-review-' + reviewed.result.review_id));
          await pump();
          await pump();
          const notices = host!.delivered.filter((r) => r.id === 'team-review-' + reviewed.result.review_id);
          assert.equal(notices.length, 1);
          assert.equal(notices[0].platform, sub.messagingGroup.platform_id);
          assert.match(notices[0].text, /Pilot Alpha/);
          assert.match(notices[0].text, /more capacity/);
          if (scenario === 'failure') assert.match(notices[0].text, /partial|Missing required/i);
          else {
            assert.match(notices[0].text, /costs less/);
            assert.match(notices[0].text, /disagree/i);
          }
          const history = await client!.call('cos_team_get', { team_id: teamId });
          assert.equal(history.status, 'ok');
          assert.ok(history.result.budget);
          assert.equal((await rows('mission_team_children', teamId)).length, 4);
          assert.equal((await rows('mission_team_reviews', teamId)).length, 1);
        }
        await responsive();
        assert.equal(
          await host!.request('main-context-generation'),
          generation,
          'original main provider context retained across the graph',
        );
        t.diagnostic(scenario + ': native workers, stopped lineage, original budget and ordinary chat checked.');
      });
  } finally {
    await ordinaryClient?.close();
    await client?.close();
    await host?.close();
    closeDb();
    await database?.pool.end();
    if (admin) {
      await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
      for (const table of [
        'mission_team_root_budget_events',
        'mission_team_root_reservations',
        'mission_team_budget_events',
        'mission_team_calls',
        'mission_team_reviews',
        'mission_team_reworks',
        'mission_team_children',
        'mission_team_reservations',
        'mission_team_dependencies',
        'mission_team_steps',
        'mission_team_roots',
        'mission_team_work_orders',
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
});
