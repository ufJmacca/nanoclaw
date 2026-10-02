import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import pg from 'pg';
import type { CosBinding } from '../../cos-boundary.js';
import { fixtureDatabaseConfig, connectFixtureDatabase } from './fixture-database.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import type { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { connectionFault } from './connection-fault.js';
import { CalendarStore } from '../../modules/chief-of-staff/calendar/store.js';
import { CalendarAccessFences } from '../../modules/chief-of-staff/calendar/access-fences.js';
import { CalendarView } from '../../modules/chief-of-staff/calendar/view.js';
import { CalendarEvidence } from '../../modules/chief-of-staff/calendar/evidence.js';
import { CalendarConnector } from '../../modules/chief-of-staff/calendar/connector.js';
import { fixtureCalendarReader } from '../../modules/chief-of-staff/calendar/fixture-reader.js';
import { renewBriefContext } from '../../modules/chief-of-staff/bridge/brief-context-renewal.js';
import {
  reserveSubscriptionAttempt,
  subscriptionActivation,
} from '../../modules/chief-of-staff/bridge/model-policy.js';
import { readPrivate } from '../../modules/chief-of-staff/ops/target-state.js';
import type { MissionAuthority } from '../../modules/chief-of-staff/missions/proposal-store.js';

if (process.env.COS_FIXTURE_HOST_PROCESS !== 'S01' || !process.send) throw new Error('fixture_only');
let handle: ((command: string, value: any) => Promise<unknown>) | undefined;
async function start(input: {
  root: string;
  binding: CosBinding;
  ordinarySessionId: string;
  knowledgeRoot?: string;
  calendar?: boolean;
  brief?: { clock: string; events: unknown[] };
  mission?: {
    repository: string;
    hostRepository: string;
    image: string;
    sourceRoot?: string;
    runnerVolume?: string;
    authority: MissionAuthority;
    team?: { templateBundleDigest: string; teamPolicyDigest: string };
  };
}) {
  if (!path.isAbsolute(input.root) || !input.root.includes('/.cos-plan-state/fixtures/flow-'))
    throw new Error('fixture_root_required');
  process.chdir(input.root);
  const { PriorityStore } = await import('../../modules/chief-of-staff/store/priorities.js');
  const { initDb, closeDb } = await import('../../db/connection.js');
  const { runMigrations } = await import('../../db/migrations/index.js');
  const { getSession, getPendingApproval } = await import('../../db/sessions.js');
  const { getMessagingGroup } = await import('../../db/messaging-groups.js');
  const { sessionDir } = await import('../../session-manager.js');
  const { openInboundDb, openOutboundDb, syncProcessingAcks } = await import('../../db/session-db.js');
  const { stopContainerAdmissions } = await import('../../container-runner.js');
  const { createCosRuntime } = await import('../../modules/chief-of-staff/runtime.js');
  const { setDeliveryAdapter, startDeliveryIntake, deliverSessionMessages, stopAndDrainDeliveryPolls } =
    await import('../../delivery.js');
  const { routeInbound } = await import('../../router.js');
  stopContainerAdmissions(); // Fixture providers are explicit containers; no native provider or paid wake is allowed.
  const check = await connectFixtureDatabase(process.env);
  await check.end();
  const relay = await connectionFault(await fixtureDatabaseConfig(process.env));
  if (
    input.knowledgeRoot &&
    (!path.isAbsolute(input.knowledgeRoot) ||
      path.resolve(input.knowledgeRoot) !== input.knowledgeRoot ||
      !input.knowledgeRoot.startsWith(path.join(os.tmpdir(), 'cos-knowledge-demo-')))
  )
    throw new Error('fixture_knowledge_root_required');
  // Real Docker ownership probes can occupy this fixture event loop for over 600 ms.
  // Keep outage detection bounded without changing production database deadlines.
  const database = new BoundedDatabase(new pg.Pool(relay.config), input.mission ? 3000 : 600);
  const databaseFailures: Array<{ code: string; frame: string; elapsed: number }> = [];
  if (input.mission) {
    const run = database.run.bind(database);
    database.run = ((operation, mutation, signal) => {
      const started = Date.now();
      let captured = false;
      const capture = (error: unknown) => {
        captured = true;
        const code = String((error as { code?: unknown })?.code ?? 'operation');
        const frame =
          error instanceof Error
            ? (error.stack
                ?.match(/\/([a-zA-Z0-9-]+)\.(?:js|ts):(\d+):\d+/)
                ?.slice(1)
                .join(':') ?? 'unknown')
            : 'unknown';
        databaseFailures.push({
          code: /^[a-zA-Z0-9_]{1,40}$/.test(code) ? code : 'unknown',
          frame,
          elapsed: Date.now() - started,
        });
        if (databaseFailures.length > 8) databaseFailures.shift();
      };
      return run(
        async (client) => {
          try {
            return await operation(client);
          } catch (error) {
            capture(error);
            throw error;
          }
        },
        mutation,
        signal,
      ).catch((error) => {
        if (!captured) capture(error);
        throw error;
      });
    }) as typeof database.run;
  }

  if (input.calendar && !input.knowledgeRoot) throw new Error('fixture_calendar_requires_knowledge_root');
  if (input.brief && (!input.calendar || !Number.isFinite(Date.parse(input.brief.clock))))
    throw new Error('fixture_brief_requires_calendar_clock');
  let fixtureClock = input.brief?.clock;
  const calendar = input.calendar
    ? new CalendarStore(
        database,
        {},
        input.brief
          ? new CalendarEvidence(
              new KnowledgeArtifacts(
                path.join(input.knowledgeRoot!, 'artifacts'),
                path.join(input.knowledgeRoot!, 'staging'),
              ),
            )
          : undefined,
      )
    : undefined;
  const fences = input.calendar
    ? new CalendarAccessFences(path.join(input.knowledgeRoot!, 'calendar-fences'))
    : undefined;
  const knowledge = input.knowledgeRoot
    ? new KnowledgeStore(
        database,
        new KnowledgeArtifacts(path.join(input.knowledgeRoot, 'artifacts'), path.join(input.knowledgeRoot, 'staging')),
        {},
        {
          calendarEnabled: () => !!calendar,
          calendarAccess: (scope, binding) => {
            if (!fences) return false;
            fences.assertOpen(scope, binding);
            return true;
          },
        },
      )
    : undefined;
  const view =
    calendar && knowledge && fences
      ? new CalendarView({
          store: calendar,
          knowledge,
          enabled: () => true,
          assertOpen: (scope, binding) => fences.assertOpen(scope, binding),
        })
      : undefined;
  const connector =
    input.brief && calendar && fences
      ? new CalendarConnector({
          store: calendar,
          fences,
          admitted: () => true,
          fixtureReader: (binding) =>
            fixtureCalendarReader({
              access: {
                generation: binding.id + ':' + binding.version,
                calendarIds: binding.calendarIds,
                scopes: binding.scopes,
                auth: binding.auth,
              },
              calendars: { selected: input.brief!.events },
            }).reader,
        })
      : undefined;
  const authority = input.mission
    ? (context: { scopeId: string; ownerId: string; agentGroupId: string; sessionId: string }) =>
        context.scopeId === input.binding.scopeId &&
        context.ownerId === input.binding.ownerId &&
        context.agentGroupId === input.binding.agentGroupId &&
        context.sessionId === input.binding.sessionId
          ? input.mission!.authority
          : null
    : undefined;
  const teamAuthority =
    input.mission?.team && authority
      ? (context: Parameters<NonNullable<typeof authority>>[0]) => {
          const single = authority(context);
          return single ? { ...single, ...input.mission!.team! } : null;
        }
      : undefined;
  const store = new PriorityStore(database, knowledge, connector, view, authority, teamAuthority);
  if (input.brief) {
    store.briefs.options.clock = () => new Date(fixtureClock!);
    store.briefArtifacts!.collector.options.clock = () => new Date(fixtureClock!);
  }
  let crashAfterDecision = false;
  const decide = store.decide.bind(store);
  store.decide = async (...args: Parameters<PriorityStore['decide']>) => {
    const result = await decide(...args);
    if (crashAfterDecision && result.status === 'ok') {
      process.kill(process.pid, 'SIGKILL');
      await new Promise<never>(() => {});
    }
    return result;
  };
  const db = initDb(path.join(input.root, 'central.db'));
  runMigrations(db);
  const binding = input.binding,
    session = getSession(binding.sessionId)!,
    ordinary = getSession(input.ordinarySessionId)!;
  if (!session || !ordinary) throw new Error('fixture_session_missing');
  const facts = async () => ({
    id: binding.channelId,
    type: 'P',
    delete_at: 0,
    members: [binding.ownerId, binding.botId],
    activeSubscription: true,
  });
  const specialists =
    input.mission && authority
      ? await (
          await import('./mission-fixture-host.js')
        ).createMissionFixtureHost({
          root: input.root,
          repository: input.mission.repository,
          hostRepository: input.mission.hostRepository,
          image: input.mission.image,
          sourceRoot: input.mission.sourceRoot,
          runnerVolume: input.mission.runnerVolume,
          db,
          store,
          authority,
          binding,
          teams: !!teamAuthority,
        })
      : undefined;
  const runtime = createCosRuntime({
    db,
    enabled: true,
    store,
    facts,
    session: getSession,
    destination: getMessagingGroup,
    missionExecution: specialists?.execution,
    stop: (id) => {
      specialists?.stopSession(id);
    },
    wake: async () => {},
    ...(input.brief || input.mission
      ? {
          running: () => false,
          launcher: {
            ready: () => true, // Synthetic provider only. prepare cannot launch a real model.
            prepare: async () => {
              throw new Error('fixture_native_provider_forbidden');
            },
            renewBriefContext: (currentBinding, request, current) =>
              renewBriefContext(
                {
                  root: input.knowledgeRoot!,
                  db,
                  binding: currentBinding,
                  accountFingerprint: 'a'.repeat(64),
                  assertIdle() {
                    if (!current()) throw new Error('fixture_context_changed');
                  },
                },
                request,
              ),
          } satisfies import('../../modules/chief-of-staff/bridge/coordinator-launcher.js').CoordinatorLauncher,
        }
      : {}),
  });
  setDeliveryAdapter({
    deliver: async (type, platform, _thread, _kind, content, _files, id) => {
      if (type !== 'mattermost') throw new Error('fixture_destination_mismatch');
      const expected = [
        getMessagingGroup(session.messaging_group_id!)!.platform_id,
        getMessagingGroup(ordinary.messaging_group_id!)!.platform_id,
      ];
      if (!expected.includes(platform)) throw new Error('fixture_destination_mismatch');
      process.send!({ event: 'delivered', value: { text: JSON.parse(content).text, id, platform } });
      return id;
    },
  });
  startDeliveryIntake();
  const drains = new Map<string, Promise<void>>();
  let deliveryFailed = false;
  const timer = setInterval(() => {
    for (const current of [session, ordinary, ...(specialists?.sessions() ?? [])])
      if (!drains.has(current.id)) {
        const drain = deliverSessionMessages(current)
          .then(
            () => {},
            () => {
              deliveryFailed = true;
            },
          )
          .finally(() => drains.delete(current.id));
        drains.set(current.id, drain);
      }
  }, 20);
  handle = async (command, value) => {
    if (deliveryFailed) throw new Error('fixture_delivery_failed');
    if (command === 'ingress' || command === 'ordinary-ingress') {
      const current = command === 'ingress' ? session : ordinary,
        destination = getMessagingGroup(current.messaging_group_id!)!;
      await routeInbound({
        channelType: 'mattermost',
        platformId: destination.platform_id,
        threadId: null,
        message: {
          id: value.id,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ senderId: 'mattermost:' + binding.ownerId, text: value.text }),
        },
      });
      if (command === 'ordinary-ingress') {
        const inbound = openInboundDb(path.join(sessionDir(current.agent_group_id, current.id), 'inbound.db'));
        try {
          return !!inbound.prepare('SELECT 1 FROM messages_in WHERE id=?').get(value.id + ':' + current.agent_group_id);
        } finally {
          inbound.close();
        }
      }
      return true;
    }
    if (command === 'pump') {
      specialists?.check();
      await specialists?.host.pump(binding);
      await runtime.pump(binding);
      return true;
    }
    if (input.brief && command === 'clock') {
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('fixture_clock_invalid');
      fixtureClock = value;
      return true;
    }
    if ((input.brief || input.mission) && command === 'sync-acks') {
      const directory = sessionDir(session.agent_group_id, session.id),
        inbound = openInboundDb(path.join(directory, 'inbound.db')),
        outbound = openOutboundDb(path.join(directory, 'outbound.db'));
      try {
        syncProcessingAcks(inbound, outbound);
      } finally {
        inbound.close();
        outbound.close();
      }
      return true;
    }
    if (input.mission && command === 'mission-review-ready') {
      return (await runtime.controller.context(session))?.origin?.kind === 'mission_review';
    }
    if (input.mission && command === 'mission-hold-next') {
      specialists!.holdNext();
      return true;
    }
    if (input.mission?.team && command === 'mission-release-held') {
      specialists!.releaseHeld();
      return true;
    }
    if (input.mission?.team && command === 'mission-fail-step') {
      if (value !== 'technical') throw Error('invalid_fixture_failure');
      specialists!.failStep(value);
      return true;
    }
    if (input.mission && command === 'main-context-generation')
      return (
        db.prepare('SELECT generation FROM cos_conversation_states WHERE scope_id=?').get(binding.scopeId) as {
          generation: string;
        }
      )?.generation;
    if (input.mission && command === 'mission-states') return specialists!.states();
    if (input.mission && command === 'mission-stale-submit')
      return store.missionRuns.submitResult(value.identity, value.lease, value.requestId, value.callId, value.result);
    if (input.mission && command === 'mission-diagnostics')
      return { worker: specialists?.diagnostics(), database: databaseFailures };
    if (input.mission && command === 'reserve-fixture-review') {
      const context = await runtime.controller.context(session);
      if (context?.origin?.kind !== 'mission_review') return false;
      const { resolveKnowledgeContext } = await import('../../modules/chief-of-staff/knowledge/context.js');
      const retained = resolveKnowledgeContext(session, context, db),
        origin = context.origin;
      if (!retained) return false;
      const { CoordinatorReviewRuns } =
        await import('../../modules/chief-of-staff/missions/coordinator-review-runs.js');
      const result = await new CoordinatorReviewRuns(store.missionReviewRuns!, store.teamFinalReviews).reserve(
        retained,
        origin.runId,
        origin.submissionId,
        { owner: origin.owner, fence: origin.fence },
        value,
        'model',
      );
      return result.status === 'ok' && result.reserved === true;
    }
    if (input.brief && command === 'brief-diagnostics') {
      const directory = sessionDir(session.agent_group_id, session.id);
      if (!fs.existsSync(path.join(directory, 'outbound.db')))
        return {
          isolated: directory.startsWith(input.root + '/'),
          outboundExists: false,
          inboundExists: fs.existsSync(path.join(directory, 'inbound.db')),
        };
      const inbound = openInboundDb(path.join(directory, 'inbound.db')),
        outbound = openOutboundDb(path.join(directory, 'outbound.db'));
      try {
        return {
          isolated: directory.startsWith(input.root + '/'),
          context: !!(await runtime.controller.context(session)),
          outbound: outbound.prepare('SELECT kind,count(*) AS n FROM messages_out GROUP BY kind').all(),
          inbound: inbound.prepare('SELECT kind,status,count(*) AS n FROM messages_in GROUP BY kind,status').all(),
        };
      } finally {
        inbound.close();
        outbound.close();
      }
    }
    if (input.brief && command === 'reserve-fixture-turn') {
      const context = await runtime.controller.context(session);
      if (!context?.origin || typeof value !== 'string') return false;
      const reserved = await store.briefs.reserveCall(
        context,
        context.origin.runId,
        context.origin.generation,
        'model',
        value,
      );
      if (reserved.status !== 'ok') return false;
      const policy = subscriptionActivation(
        readPrivate(path.join(input.knowledgeRoot!, 'model-activation.json')),
        binding.scopeId,
        'a'.repeat(64),
      );
      return !!policy && reserveSubscriptionAttempt(db, policy, context.ingressId, value);
    }
    if (command === 'approval') return getPendingApproval(value) ?? null;
    if (command === 'partition') {
      relay.partition();
      return true;
    }
    if (command === 'crash-after-decision') {
      crashAfterDecision = true;
      return true;
    }
    if (command === 'restore') {
      relay.restore();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return true;
    }
    if (command === 'paused')
      return (
        (
          db.prepare('SELECT paused FROM cos_identity_boundaries WHERE scope_id=?').get(binding.scopeId) as {
            paused: number;
          }
        ).paused === 1
      );
    if (command === 'shutdown') {
      clearInterval(timer);
      await stopAndDrainDeliveryPolls();
      await Promise.all(drains.values());
      await specialists?.close();
      runtime.dispose();
      await store.database.pool.end();
      await relay.close();
      closeDb();
      return true;
    }
    throw new Error('unknown_fixture_command');
  };
  return { pid: process.pid };
}
let queue = Promise.resolve();
process.on('message', (message: any) => {
  queue = queue.then(async () => {
    try {
      const value =
        message.command === 'start' && !handle
          ? await start(message.value)
          : await handle?.(message.command, message.value);
      process.send!({ id: message.id, value }, () => {
        if (message.command === 'shutdown') process.disconnect();
      });
    } catch (error) {
      const reason =
        error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
          ? error.message
          : typeof (error as { code?: unknown })?.code === 'string' &&
              /^[A-Z_]{1,40}$/.test(String((error as { code: string }).code))
            ? (error as { code: string }).code
            : 'unavailable';
      process.send!({ id: message.id, error: 'fixture_host_command_failed', reason }, () => {
        if (message.command === 'start') process.exit(1);
      });
    }
  });
});
