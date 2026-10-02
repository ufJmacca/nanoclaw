/** Scripted provider: real owner routing, MCP containers, native queue and external PostgreSQL. */
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
import { CalendarStore } from '../../modules/chief-of-staff/calendar/store.js';
import { CalendarAccessFences } from '../../modules/chief-of-staff/calendar/access-fences.js';
import { GOOGLE_EVENT_READ_SCOPE } from '../../modules/chief-of-staff/calendar/reader.js';
import { createConversationState } from '../../modules/chief-of-staff/bridge/conversation-state.js';
import { ensureModelBudget } from '../../modules/chief-of-staff/bridge/model-policy.js';
import { issueActivation } from '../../modules/chief-of-staff/ops/model-activation.js';
import { McpFixture } from './mcp-fixture.js';
import { HostFixture } from './host-fixture-client.js';
import type { BriefSnapshot } from '../../modules/chief-of-staff/automation/brief-snapshot.js';

test(
  'S04 owner approves recurring mornings, confirms and completes work, with native restart and outage recovery',
  { timeout: 120000 },
  async () => {
    const repository = process.cwd(),
      hostRepository = process.env.COS_FIXTURE_HOST_ROOT,
      image = process.env.COS_FIXTURE_IMAGE;
    assert.ok(hostRepository && path.isAbsolute(hostRepository) && image);
    const parent = path.join(repository, '.cos-plan-state/fixtures');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'flow-s04-')),
      knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-knowledge-demo-')),
      scope = 'demo-brief-' + randomUUID();
    for (const name of ['artifacts', 'staging', 'calendar-fences'])
      fs.mkdirSync(path.join(knowledgeRoot, name), { mode: 0o700 });
    CalendarAccessFences.initialize(path.join(knowledgeRoot, 'calendar-fences'));
    // The next Monday is always after the real approval timestamp and within the connector window.
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7) + 7);
    monday.setUTCHours(9, 0, 0, 0);
    // The third morning follows a week of downtime: missed occurrences must coalesce.
    const morning = (day: number) => new Date(monday.getTime() + (day >= 2 ? day + 7 : day) * 86400000).toISOString();
    let clock = new Date(monday.getTime() - 3600000).toISOString();
    process.chdir(root);
    const { PriorityStore } = await import('../../modules/chief-of-staff/store/priorities.js');
    const { initDb, closeDb } = await import('../../db/connection.js');
    const { runMigrations } = await import('../../db/migrations/index.js');
    const { subscribeMattermostChannelStrict } = await import('../../channels/mattermost-subscription.js');
    const { resolveSession, sessionDir } = await import('../../session-manager.js');
    const { bindCoordinator } = await import('../../modules/chief-of-staff/ops/bind.js');
    let admin: Awaited<ReturnType<typeof connectFixtureDatabase>> | undefined,
      database: BoundedDatabase | undefined,
      host: HostFixture | undefined,
      client: McpFixture | undefined;
    const delivered: Array<{ text: string; id: string; platform: string }> = [];
    try {
      admin = await connectFixtureDatabase(process.env, 'migration');
      assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
      await migrate(admin, fixtureRuntimeUser());
      database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
      const priorities = new PriorityStore(database),
        calendar = new CalendarStore(database);
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
        bindScope: (value) => priorities.bindScope(value),
      });
      const accountFingerprint = 'a'.repeat(64);
      const generation = createConversationState(knowledgeRoot, db).prepare(binding, accountFingerprint).generation;
      ensureModelBudget(db);
      issueActivation(
        { root: knowledgeRoot, db, binding, accountFingerprint, assertAuthority() {} },
        {
          version: 2,
          runtime: 'codex-subscription/v1',
          activationId: randomUUID().replaceAll('-', ''),
          consentRef: 'Synthetic S04 fixture only; no provider access',
          scopeId: scope,
          provider: 'codex',
          model: 'fixture-model',
          maxAttempts: 6,
          expiresAt: new Date(Date.now() + 180000).toISOString(),
          accountFingerprint,
          contextGeneration: generation,
        },
      );
      db.prepare('UPDATE cos_identity_boundaries SET paused=0 WHERE scope_id=?').run(scope);
      const coordinatorDirectory = sessionDir(session.agent_group_id, session.id);
      assert.ok(coordinatorDirectory.startsWith(root + '/'), 'fixture session paths must be isolated');
      closeDb();
      const calendarId = randomUUID();
      assert.equal(
        (
          await calendar.bind(
            { ...binding, ingressId: 'fixture-account-admission' },
            {
              id: calendarId,
              provider: 'fixture',
              calendarIds: ['selected'],
              scopes: [GOOGLE_EVENT_READ_SCOPE],
              timeZone: 'UTC',
              processingProviders: ['codex'],
            },
          )
        ).status,
        'ok',
      );
      const events = [0, 1, 2].map((day) => ({
        id: 'review-' + day,
        etag: 'v1',
        summary: 'Fixture review ' + day,
        start: { dateTime: new Date(Date.parse(morning(day)) + 3600000).toISOString() },
        end: { dateTime: new Date(Date.parse(morning(day)) + 5400000).toISOString() },
      }));
      const start = async () => {
        host = new HostFixture();
        await host.request('start', {
          root,
          binding,
          ordinarySessionId: ordinary.id,
          knowledgeRoot,
          calendar: true,
          brief: { clock, events },
        });
        client = new McpFixture(
          repository,
          coordinatorDirectory,
          hostRepository,
          image,
          process.env.COS_FIXTURE_RUNNER_VOLUME ?? '',
        );
        await client.start();
      };
      const stop = async (crash = false) => {
        await client?.close();
        client = undefined;
        if (host) delivered.push(...host.delivered);
        await host?.close(crash);
        host = undefined;
      };
      const ingress = async (text: string) => {
        await host!.request('ingress', { id: randomUUID(), text });
      };
      const complete = async () => {
        const ids = await client!.completePending();
        await host!.request('sync-acks');
        return ids;
      };
      const approve = async (proposalId: string) => {
        await host!.request('pump');
        const preview = host!.delivered.find((row) => row.id === 'cos-' + proposalId);
        assert.ok(preview, 'private correlated approval preview');
        const command = preview.text.split('\n').find((line) => line.startsWith('cos approve '));
        assert.ok(command);
        await ingress(command);
        await host!.request('pump');
        assert.equal(await host!.request('approval', preview.id), null);
      };
      const runs = async () =>
        (await admin!.query('SELECT * FROM cos.brief_runs WHERE scope_id=$1 ORDER BY intended_at', [scope])).rows;
      await start();
      await ingress('Please propose a weekday briefing at 09:00 UTC.');
      const scheduled = await client!.call('cos_brief_schedule_propose', {
        request_id: randomUUID(),
        change: {
          kind: 'brief_schedule',
          title: 'Weekday morning',
          reason: 'Fixture owner request',
          expected_version: 0,
          policy: {
            state: 'active',
            time_zone: 'UTC',
            local_time: '09:00',
            weekdays: [1, 2, 3, 4, 5],
            quiet_hours: { start: '08:00', end: '09:15' },
            snooze_until: new Date(monday.getTime() + 30 * 60000).toISOString().replace('.000Z', 'Z'),
          },
          limits: { max_turns: 1, max_tool_calls: 4, deadline_seconds: 120, refresh_seconds: 10 },
        },
      });
      assert.equal(scheduled.status, 'ok', JSON.stringify(await host!.request('brief-diagnostics')));
      await complete();
      await approve(scheduled.result.proposal_id);
      await complete();
      assert.equal((await runs()).length, 0);
      const briefs: Array<{ artifact_id: string; snapshot: BriefSnapshot; text: string }> = [];
      let workId = '';
      for (const day of [0, 1, 2]) {
        clock = morning(day);
        await host!.request('clock', clock);
        await host!.request('pump');
        assert.equal((await runs()).length, day, 'quiet hours prevent dispatch');
        clock = new Date(Date.parse(morning(day)) + 20 * 60000).toISOString();
        if (day === 0) {
          await host!.request('clock', clock);
          await host!.request('pump');
          assert.equal((await runs()).length, 0, 'snooze remains effective after quiet hours');
        }
        clock = new Date(Date.parse(morning(day)) + 30 * 60000).toISOString();
        await host!.request('clock', clock);
        if (day === 2) {
          await host!.request('partition');
          await host!.request('pump');
          assert.equal((await runs()).length, 2);
          assert.equal(
            await host!.request('ordinary-ingress', { id: randomUUID(), text: 'Ordinary chat during database outage' }),
            true,
          );
          await host!.request('restore');
        }
        await host!.request('pump');
        let current = (await runs())[day];
        assert.ok(current);
        assert.equal(current.state, 'dispatched');
        if (day === 0) {
          const id = current.id;
          await stop(true); // Actual host death after dispatch, before worker output/receipt.
          await start();
          await host!.request('pump');
          current = (await runs())[0];
          assert.equal(current.id, id);
          assert.equal((await runs()).length, 1);
        }
        assert.equal(await host!.request('reserve-fixture-turn', randomUUID()), true);
        assert.equal(await host!.request('reserve-fixture-turn', randomUUID()), false);
        const prepared = await client!.call('cos_brief_request', { request_id: randomUUID(), time_zone: 'UTC' });
        assert.equal(prepared.status, 'ok');
        assert.equal(Date.parse(prepared.result.snapshot.generated_at), Date.parse(clock));
        assert.ok(prepared.result.snapshot.attention.length <= 3);
        assert.match(prepared.result.text, /Fixture review/);
        assert.equal(prepared.result.snapshot.coverage.refresh, 'complete');
        briefs.push(prepared.result);
        assert.ok(
          (await complete()).includes('cos-brief-' + current.id),
          'worker reads and acknowledges real native task',
        );
        await host!.request('pump');
        await host!.request('pump');
        await host!.request('pump');
        assert.equal((await runs())[day].state, 'delivered');
        const notifications = [...delivered, ...host!.delivered].filter((row) => row.id === 'brief-' + current.id);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].text, prepared.result.text);
        assert.equal(notifications[0].platform, sub.messagingGroup.platform_id);
        if (day < 2) {
          await ingress(
            day === 0
              ? 'I will prepare the review pack; please propose that commitment.'
              : 'The review pack is complete.',
          );
          const changed = await client!.call('cos_work_change_propose', {
            request_id: randomUUID(),
            change: {
              kind: 'commitment',
              title: 'Prepare review pack',
              description: 'Fixture owner work',
              reason: 'Explicit owner request',
              state: day === 0 ? 'confirmed' : 'completed',
              project_id: null,
              due: null,
              defer_until: null,
              evidence: [],
              expected_version: day,
              ...(day === 1 ? { record_id: workId } : {}),
            },
          });
          assert.equal(changed.status, 'ok');
          const before = await client!.call('cos_work_read', { view: 'open' });
          assert.equal(before.result.items.length, day);
          await complete();
          await approve(changed.result.proposal_id);
          const after = await client!.call('cos_work_read', { view: 'all' });
          assert.equal(after.result.items.length, 1);
          workId = after.result.items[0].id;
          assert.equal(after.result.items[0].state, day === 0 ? 'confirmed' : 'completed');
          await complete();
        }
      }
      assert.equal(briefs[0].snapshot.commitments.length, 0);
      assert.equal(briefs[1].snapshot.commitments[0].id, workId);
      assert.equal(briefs[2].snapshot.commitments.length, 0);
      assert.equal((await runs()).length, 3);
      console.log(
        JSON.stringify({
          demonstration: 'S04',
          provider: 'scripted_fixture',
          liveCalls: false,
          authenticatedOwnerApprovals: 3,
          recurringBriefs: 3,
          sharedSession: true,
          actualHostCrash: true,
          actualDatabasePartition: true,
          nativeAcknowledgements: true,
          quietHours: true,
          snooze: true,
          missedMorningsCoalesced: true,
          modelQualityEvaluated: false,
        }),
      );
      await stop();
    } finally {
      await client?.close();
      await host?.close();
      await database?.pool.end();
      if (admin)
        try {
          await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [scope]);
          await admin.query(
            'UPDATE cos.calendar_states SET current_snapshot=NULL,last_attempt=NULL WHERE scope_id=$1',
            [scope],
          );
          for (const table of [
            'calendar_event_revisions',
            'calendar_observations',
            'calendar_snapshots',
            'calendar_states',
            'calendar_bindings',
            'brief_notifications',
            'brief_call_reservations',
            'brief_runs',
            'brief_schedule_revisions',
            'brief_schedules',
            'work_revisions',
            'work_items',
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
