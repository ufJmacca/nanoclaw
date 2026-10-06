/** Scripted native owner conversation: real private routing, isolated tools, PostgreSQL and exact approvals.
 * No live model, Mattermost account, calendar write or specialist invocation is authorised by this fixture. */
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
import type { ReviewDraft } from '../../modules/chief-of-staff/contracts/strategy-protocol.js';
import { outcomeStatus, type ReviewSnapshot } from '../../modules/chief-of-staff/strategy/review.js';
import { HostFixture } from './host-fixture-client.js';
import { McpFixture } from './mcp-fixture.js';

test(
  'S10 native strategic review distinguishes outcomes, preserves disagreement and learns after an exact owner choice',
  { timeout: 180000 },
  async (t) => {
    const repository = process.cwd(),
      hostRepository = process.env.COS_FIXTURE_HOST_ROOT,
      image = process.env.COS_FIXTURE_IMAGE;
    assert.ok(hostRepository && path.isAbsolute(hostRepository) && image);
    const parent = path.join(repository, '.cos-plan-state/fixtures');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'flow-s10-')),
      knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-knowledge-demo-'));
    for (const name of ['artifacts', 'staging']) fs.mkdirSync(path.join(knowledgeRoot, name), { mode: 0o700 });
    const scope = 'demo-strategy-' + randomUUID();
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
        store = new PriorityStore(database, knowledge),
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
        bindScope: (value) => store.bindScope(value),
      });
      const generation = createConversationState(knowledgeRoot, db).prepare(binding, 'a'.repeat(64)).generation,
        coordinatorDirectory = sessionDir(session.agent_group_id, session.id),
        ordinaryDirectory = sessionDir(ordinary.agent_group_id, ordinary.id);
      fs.mkdirSync(ordinaryDirectory, { recursive: true });
      openInboundDb(ordinary.agent_group_id, ordinary.id).close();
      db.prepare('UPDATE cos_identity_boundaries SET paused=0 WHERE scope_id=?').run(scope);
      closeDb();
      const start = async () => {
        host = new HostFixture();
        await host.request('start', { root, binding, ordinarySessionId: ordinary.id, knowledgeRoot });
      };
      await start();
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
      const ingress = (text: string) => host!.request('ingress', { id: randomUUID(), text });
      const wait = async (predicate: () => Promise<boolean>) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          await host!.request('pump');
          if (await predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        assert.fail('strategy_native_state_deadline');
      };
      const propose = async (tool: string, args: Record<string, unknown>) => {
        await ingress('Owner requests the exact synthetic change below.');
        const response = await client!.call(tool, { request_id: randomUUID(), ...args });
        assert.equal(response.status, 'ok');
        assert.equal(response.result.confirmation_token, undefined);
        await wait(async () => host!.delivered.some((row) => row.id === 'cos-' + response.result.proposal_id));
        const card = host!.delivered.find((row) => row.id === 'cos-' + response.result.proposal_id)!;
        assert.equal(card.platform, sub.messagingGroup.platform_id);
        const command = card.text.split('\n').find((line) => line.startsWith('cos approve '));
        assert.ok(command);
        return { proposal: response.result, command, preview: card.text };
      };
      const decide = async (
        proposal: Awaited<ReturnType<typeof propose>>,
        choice: 'approve' | 'reject' = 'approve',
      ) => {
        await ingress(
          choice === 'approve' ? proposal.command : proposal.command.replace('cos approve ', 'cos reject '),
        );
        await wait(
          async () =>
            (
              await admin!.query('SELECT state FROM cos.proposals WHERE scope_id=$1 AND id=$2', [
                scope,
                proposal.proposal.proposal_id,
              ])
            ).rows[0]?.state === (choice === 'approve' ? 'applied' : 'rejected'),
        );
      };
      const change = async (tool: string, value: unknown) => {
        const proposed = await propose(tool, { change: value });
        await decide(proposed);
        return proposed;
      };
      const initiatives: string[] = [];
      for (const title of [
        'Busy initiative: many tasks, result unknown',
        'Useful initiative: fewer tasks, observed benefit',
      ]) {
        await change('cos_change_propose', {
          kind: 'project',
          title,
          description: 'Synthetic owner-approved initiative',
          lifecycle: 'active',
          reason: 'Review useful results',
          expected_version: 0,
        });
        const row = (await admin.query('SELECT id FROM cos.records WHERE scope_id=$1 AND title=$2', [scope, title]))
          .rows[0];
        initiatives.push(row.id);
      }
      const [busy, useful] = initiatives;
      const sources: string[] = [];
      for (const [key, text] of [
        [
          'selected',
          'Synthetic comparison: the useful initiative reduced repeated work. The busy initiative completed tasks, but no useful decision is observed. More tasks could help, while repeated reporting could consume attention.',
        ],
        ['unselected', 'UnselectedNativeStrategyCanary: private material must never enter the review.'],
      ]) {
        fs.writeFileSync(path.join(knowledgeRoot, 'staging', key + '.md'), text, { mode: 0o600 });
        const imported = await knowledge.importSource({ ...binding, ingressId: 'fixture-owner-import' }, randomUUID(), {
          sourceKey: key,
          filename: key + '.md',
          title: key,
          processingProviders: ['codex'],
          expectedVersion: 0,
        });
        assert.equal(imported.status, 'ok');
        sources.push(String(imported.source_id));
      }
      const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime(),
        at = (offset: number) => new Date(now + offset).toISOString();
      await change('cos_review_charter_propose', {
        kind: 'review_charter',
        expected_version: 0,
        reason: 'Exact owner review scope',
        definition: {
          title: 'Useful outcomes before more activity',
          initiative_ids: initiatives,
          source_ids: [sources[0]],
          starts_at: at(-86400000),
          ends_at: at(30 * 86400000),
          cadence: 'manual',
          resource_constraints: 'Six hours per week',
          evidence_limits: 'Only selected synthetic observations; outside progress may be missing',
          exploration_minutes_per_week: 60,
          measures: [
            {
              id: 'busy-result',
              initiative_id: busy,
              outcome: 'A decision the owner can use',
              test: 'Record a useful decision',
            },
            {
              id: 'useful-result',
              initiative_id: useful,
              outcome: 'Less repeated effort',
              test: 'Compare observed repeated work',
            },
          ],
          assumptions: [
            { id: 'more-tasks', initiative_id: busy, statement: 'More completed tasks lead to useful results' },
            {
              id: 'hidden-result',
              initiative_id: busy,
              statement: 'Outside work may already have produced the desired result',
            },
          ],
        },
      });
      for (let n = 0; n < 8; n++) {
        const work = {
          kind: 'commitment',
          title: 'Synthetic finished task ' + (n + 1),
          description: '',
          state: 'confirmed',
          project_id: busy,
          due: null,
          defer_until: null,
          evidence: [],
          expected_version: 0,
          reason: 'Owner confirms recorded activity',
        };
        await change('cos_work_change_propose', work);
        const row = (
          await admin.query('SELECT id,version FROM cos.work_items WHERE scope_id=$1 AND title=$2', [scope, work.title])
        ).rows[0];
        await change('cos_work_change_propose', {
          ...work,
          state: 'completed',
          record_id: row.id,
          expected_version: row.version,
        });
      }
      await change('cos_work_change_propose', {
        kind: 'commitment',
        title: 'Keep this approved obligation',
        description: '',
        state: 'confirmed',
        project_id: busy,
        due: null,
        defer_until: null,
        evidence: [],
        expected_version: 0,
        reason: 'This obligation needs its own explicit change',
      });
      await ingress('Use only my selected comparison note.');
      const searched = await client.call('cos_knowledge_search', {
        query: 'Synthetic comparison',
        source_id: sources[0],
      });
      assert.equal(searched.status, 'ok');
      const evidence_id = searched.result.items[0].evidence_id;
      const observe = (
        initiative_id: string,
        target: { kind: 'outcome' | 'assumption' | 'attention_cost'; id: string },
        signal: 'supported' | 'challenged',
        statement: string,
        selfReported = false,
      ) =>
        change('cos_strategy_observation_propose', {
          kind: 'strategy_observation',
          charter_version: 1,
          initiative_id,
          target,
          basis: selfReported ? 'self_reported' : 'evidence_backed',
          signal,
          statement,
          observed_at: at(-1000),
          evidence: selfReported ? [] : [{ kind: 'source', evidence_id }],
          reason: 'Retain this exact observation for review',
        });
      await observe(
        useful,
        { kind: 'outcome', id: 'useful-result' },
        'supported',
        'The selected comparison records less repeated work',
      );
      await observe(
        busy,
        { kind: 'assumption', id: 'more-tasks' },
        'supported',
        'More tasks may uncover a useful decision',
      );
      await observe(
        busy,
        { kind: 'assumption', id: 'more-tasks' },
        'challenged',
        'Completed tasks have not demonstrated a useful decision',
      );
      await observe(
        busy,
        { kind: 'attention_cost', id: busy },
        'supported',
        'The owner reports that repeated reporting consumes attention',
        true,
      );
      let initialText = '',
        laterText = '',
        reviewId = '';
      const buildDraft = (snapshot: ReviewSnapshot, later: boolean): ReviewDraft => ({
        findings: [
          {
            kind: 'fact',
            domain: 'activity',
            initiative_id: busy,
            statement: 'Eight recorded tasks are completed',
            evidence: [
              {
                kind: 'work',
                work_id: snapshot.work.find((w) => w.state === 'completed')!.id,
                version: snapshot.work.find((w) => w.state === 'completed')!.version,
              },
            ],
            uncertainty: 'Task count does not prove a useful outcome',
          },
          {
            kind: 'fact',
            domain: 'outcome',
            initiative_id: useful,
            statement: 'An approved observation records reduced repeated work',
            evidence: [
              {
                kind: 'observation',
                observation_id: snapshot.observations.find((o) => o.initiative_id === useful)!.id,
              },
            ],
            uncertainty: 'One comparison does not prove causation or lasting benefit',
          },
          {
            kind: 'self_report',
            domain: 'attention_cost',
            initiative_id: busy,
            statement: 'The owner reports attention cost from repeated reporting',
            evidence: [
              {
                kind: 'observation',
                observation_id: snapshot.observations.find((o) => o.basis === 'self_reported')!.id,
              },
            ],
            uncertainty: 'No independent effort measurement',
          },
          {
            kind: 'assumption',
            domain: 'outcome',
            initiative_id: busy,
            statement: 'Outside work may have produced an unseen result',
            evidence: [],
            uncertainty: 'Unconnected activity is unknown',
          },
          {
            kind: 'recommendation',
            domain: 'other',
            initiative_id: busy,
            statement: later
              ? 'Reassess the smaller experiment against observed results'
              : 'Pause expansion and keep existing obligations while testing a useful result',
            evidence: [],
            uncertainty: 'The contradictory assumption is unresolved',
          },
        ],
        options: [
          {
            id: 'busy-continue',
            initiative_id: busy,
            direction: 'continue',
            title: 'Continue unchanged',
            trade_off: 'Keep the current investment',
            opportunity_cost: 'Less exploration time',
            next_action: 'Observe a useful outcome',
          },
          {
            id: 'useful-continue',
            initiative_id: useful,
            direction: 'continue',
            title: 'Continue the useful initiative unchanged',
            trade_off: 'Retain the observed benefit',
            opportunity_cost: 'Less time for other work',
            next_action: 'Check whether the benefit persists',
          },
          {
            id: 'busy-pause',
            initiative_id: busy,
            direction: 'pause',
            title: 'Pause expansion of the busy initiative',
            trade_off: 'Avoid adding work without a demonstrated result',
            opportunity_cost: 'An untested opportunity may be delayed',
            next_action: 'Keep approved obligations; propose each consequence separately',
          },
          {
            id: 'busy-change',
            initiative_id: busy,
            direction: 'change',
            title: 'Try one smaller outcome experiment',
            trade_off: 'Test the useful-result assumption',
            opportunity_cost: 'Use some of the six-hour allocation',
            next_action: 'Choose a separately approved bounded experiment; preserve exploration time',
          },
        ],
        recommended_option_id: later ? 'busy-continue' : 'busy-pause',
        rationale: later
          ? 'The earlier approved experiment has not yet demonstrated the hoped-for result'
          : 'Protect useful work and exploration while the busy initiative has an unknown outcome',
        confidence: 'low',
        uncertainty: 'Connected sources are incomplete and opposing observations remain',
        evidence_would_change: 'A useful decision that persists without excessive attention cost',
        forecast_until: at(7 * 86400000),
      });
      const review = async (later: boolean) => {
        await ingress(
          later
            ? 'Compare the original advice with my actual choice and the later result.'
            : 'Review my two initiatives and challenge the useful-result assumptions.',
        );
        const captured = await client!.call('cos_review_request', {
          request_id: randomUUID(),
          request: { charter_version: 1, previous_review_id: later ? reviewId : null },
        });
        assert.equal(captured.status, 'ok');
        const snapshot = captured.result.snapshot as ReviewSnapshot;
        assert.equal(JSON.stringify(snapshot).includes('UnselectedNativeStrategyCanary'), false);
        assert.equal(
          snapshot.source_coverage.some((source) => source.source_id === sources[1]),
          false,
        );
        assert.equal(outcomeStatus(snapshot, busy, 'busy-result'), later ? 'challenged' : 'unknown');
        assert.equal(outcomeStatus(snapshot, useful, 'useful-result'), 'evidence_backed');
        const submitted = await client!.call('cos_review_submit', {
          request_id: randomUUID(),
          review_id: captured.result.review_id,
          revision: captured.result.revision,
          draft: buildDraft(snapshot, later),
        });
        assert.equal(submitted.status, 'ok');
        await client!.reply(submitted.result.text, sub.messagingGroup.platform_id);
        await wait(async () => host!.delivered.some((row) => row.text === submitted.result.text));
        assert.match(submitted.result.text, /Challenged: conflicting observations/);
        assert.match(submitted.result.text, /Untested/);
        assert.match(submitted.result.text, /Calendar allocation does not establish actual effort/);
        const rendered = String(submitted.result.text),
          evidenceStart = rendered.indexOf('## Outcomes and evidence'),
          decision = rendered.slice(0, evidenceStart);
        assert.ok(evidenceStart > 0);
        assert.ok(
          decision.includes(
            'Recommendation: ' + (later ? 'Continue unchanged' : 'Pause expansion of the busy initiative'),
          ),
        );
        assert.ok(
          decision.includes('Next action: ' + (later ? 'Observe a useful outcome' : 'Keep approved obligations')),
        );
        assert.match(rendered, /\n\n## Options for owner decision\n\n/);
        if (later) {
          assert.ok(decision.includes('## Since the previous review'));
          assert.ok(decision.includes('Previous recommendation: Pause expansion of the busy initiative'));
          assert.ok(decision.includes('rejected pause'));
          assert.ok(decision.includes('approved change'));
        }
        return {
          snapshot,
          text: String(submitted.result.text),
          id: String(captured.result.review_id),
          revision: Number(captured.result.revision),
        };
      };
      await t.test(
        'S10-T01/T02/T03/T06/T07/T08 complete checked review reaches only the bound owner channel',
        async () => {
          const first = await review(false);
          reviewId = first.id;
          initialText = first.text;
          assert.equal(first.revision, 1);
          for (const label of ['Fact:', 'Self-report:', 'Assumption:', 'Recommendation:'])
            assert.ok(initialText.includes(label));
          const outside = await ordinaryClient!.call('cos_review_get', { review_id: reviewId, revision: 1 });
          assert.equal(outside.status, 'unavailable');
          assert.equal(outside.result, undefined);
          const captured = await client!.call('cos_review_get', { review_id: reviewId, revision: 1 });
          assert.equal(captured.status, 'ok');
          assert.equal(captured.result.text, initialText);
        },
      );
      const protectedState = async () => ({
        records: (await admin!.query('SELECT * FROM cos.records WHERE scope_id=$1 ORDER BY id', [scope])).rows,
        work: (await admin!.query('SELECT * FROM cos.work_items WHERE scope_id=$1 ORDER BY id', [scope])).rows,
      });
      await t.test(
        'S10-T04/T10 reject and revised exact approval preserve existing obligations and approved priorities',
        async () => {
          const before = await protectedState();
          const request = {
            review_id: reviewId,
            revision: 1,
            option_id: 'busy-pause',
            expected_record_version: 1,
            expected_direction_version: 0,
            reason: 'Original advice: pause expansion',
          };
          const rejected = await propose('cos_strategy_direction_propose', { request });
          await decide(rejected, 'reject');
          assert.deepEqual(await protectedState(), before);
          assert.equal(
            (await admin!.query('SELECT count(*)::int AS n FROM cos.strategy_directions WHERE scope_id=$1', [scope]))
              .rows[0].n,
            0,
          );
          const accepted = await propose('cos_strategy_direction_propose', {
            request: {
              ...request,
              option_id: 'busy-change',
              reason: 'Owner chooses one smaller outcome experiment instead',
            },
          });
          assert.match(
            accepted.preview,
            /Existing commitments, missions and calendar events keep their approved states/,
          );
          await decide(accepted);
          assert.deepEqual(await protectedState(), before);
          const head = (
            await admin!.query('SELECT direction,version FROM cos.strategy_directions WHERE scope_id=$1', [scope])
          ).rows[0];
          assert.deepEqual(head, { direction: 'change', version: 1 });
          await ingress(accepted.command);
          await host!.request('pump');
          assert.equal(
            (
              await admin!.query('SELECT count(*)::int AS n FROM cos.strategy_direction_revisions WHERE scope_id=$1', [
                scope,
              ])
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'S10-T09 later evidence preserves the original advice and actual owner choices without labelling approval a success',
        async () => {
          await observe(
            busy,
            { kind: 'outcome', id: 'busy-result' },
            'challenged',
            'The smaller experiment did not yet produce the hoped-for useful decision',
          );
          const second = await review(true);
          laterText = second.text;
          assert.equal(second.id, reviewId);
          assert.equal(second.revision, 2);
          assert.equal(second.snapshot.previous_review?.recommended_option.id, 'busy-pause');
          assert.equal(second.snapshot.decisions.length, 2);
          assert.equal(second.snapshot.directions[0].version, 1);
          assert.match(laterText, /rejected pause/);
          assert.match(laterText, /approved change/);
          assert.match(laterText, /Owner approval is a decision, not a success label/);
          assert.match(laterText, /did not yet produce the hoped-for useful decision/);
          const historical = await client!.call('cos_review_get', {
            review_id: reviewId,
            revision: 1,
            historical: true,
          });
          assert.equal(historical.status, 'ok');
          assert.ok(historical.result.text.endsWith(initialText));
          const revised = await propose('cos_strategy_direction_propose', {
            request: {
              review_id: reviewId,
              revision: 2,
              option_id: 'busy-continue',
              expected_record_version: 1,
              expected_direction_version: 1,
              reason: 'Retain current obligations while reassessing the unsuccessful experiment',
            },
          });
          await decide(revised);
          const revisions = (
            await admin!.query(
              'SELECT version,body FROM cos.strategy_direction_revisions WHERE scope_id=$1 ORDER BY version',
              [scope],
            )
          ).rows;
          assert.equal(revisions.length, 2);
          assert.equal(revisions[1].body.superseded_version, 1);
          assert.equal(revisions[0].body.change.option.id, 'busy-change');
        },
      );
      await t.test('S10 restart retains the main context and immutable review history', async () => {
        await host!.close();
        host = undefined;
        await start();
        await ingress('Show the original review with its historical label after restarting.');
        const historical = await client!.call('cos_review_get', { review_id: reviewId, revision: 1, historical: true });
        assert.equal(historical.status, 'ok');
        assert.ok(historical.result.text.endsWith(initialText));
        await client!.reply(historical.result.text, sub.messagingGroup.platform_id);
        await wait(async () => host!.delivered.some((row) => row.text === historical.result.text));
        const native = initDb(path.join(root, 'central.db'));
        try {
          assert.equal(
            (
              native.prepare('SELECT generation FROM cos_conversation_states WHERE scope_id=?').get(scope) as {
                generation: string;
              }
            ).generation,
            generation,
          );
          assert.equal(
            (
              native
                .prepare('SELECT count(*) AS n FROM sessions WHERE agent_group_id=?')
                .get(session.agent_group_id) as { n: number }
            ).n,
            1,
          );
        } finally {
          closeDb();
        }
      });
      console.log(
        JSON.stringify({
          demonstration: 'S10',
          provider: 'scripted_fixture',
          initial_review: initialText,
          later_review: laterText,
          checks: [
            'two_initiatives',
            'unknown_outcome',
            'confirmed_useful_result',
            'contradiction_retained',
            'unsupported_assumption',
            'owner_rejected',
            'revised_owner_approved',
            'version_superseded',
            'later_result_not_success',
            'retained_main_context',
          ],
          live_model_messages_accounts: false,
          owner_usefulness: 'pending_actual_owner_assessment',
        }),
      );
    } finally {
      await ordinaryClient?.close();
      await client?.close();
      await host?.close();
      await database?.pool.end();
      if (admin)
        try {
          await admin.query('BEGIN');
          await admin.query('SET CONSTRAINTS ALL DEFERRED');
          await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
          for (const table of [
            'strategy_directions',
            'strategy_direction_revisions',
            'strategy_decisions',
            'strategy_review_results',
            'strategy_review_snapshots',
            'strategy_observations',
            'review_charters',
            'review_charter_revisions',
            'derivation_links',
            'evidence_refs',
            'chunks',
            'revocation_tombstones',
            'source_revisions',
            'sources',
            'artifacts',
            'work_revisions',
            'work_items',
            'outbox',
            'events',
            'operations',
            'proposals',
            'records',
          ])
            await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=$1', [scope]);
          await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
          await admin.query('COMMIT');
        } finally {
          await admin.end();
        }
      closeDb();
      process.chdir(repository);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(knowledgeRoot, { recursive: true, force: true });
    }
  },
);
