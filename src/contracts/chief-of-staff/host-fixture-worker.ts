import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import pg from 'pg';
import type { CosBinding } from '../../cos-boundary.js';
import { fixtureDatabaseConfig, connectFixtureDatabase } from './fixture-database.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
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

if (process.env.COS_FIXTURE_HOST_PROCESS !== 'S01' || !process.send) throw new Error('fixture_only');
let handle: ((command: string, value: any) => Promise<unknown>) | undefined;
async function start(input: {
  root: string;
  binding: CosBinding;
  ordinarySessionId: string;
  knowledgeRoot?: string;
  calendar?: boolean;
  brief?: { clock: string; events: unknown[] };
}) {
  if (!path.isAbsolute(input.root) || !input.root.includes('/.cos-plan-state/fixtures/flow-'))
    throw new Error('fixture_root_required');
  process.chdir(input.root);
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
  const database = new BoundedDatabase(new pg.Pool(relay.config), 600);
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
  const store = new PriorityStore(database, knowledge, connector, view);
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
  const runtime = createCosRuntime({
    db,
    enabled: true,
    store,
    facts,
    session: getSession,
    destination: getMessagingGroup,
    stop: () => {},
    wake: async () => {},
    ...(input.brief
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
    for (const current of [session, ordinary])
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
      await runtime.pump(binding);
      return true;
    }
    if (input.brief && command === 'clock') {
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('fixture_clock_invalid');
      fixtureClock = value;
      return true;
    }
    if (input.brief && command === 'sync-acks') {
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
    } catch {
      process.send!({ id: message.id, error: 'fixture_host_command_failed' }, () => {
        if (message.command === 'start') process.exit(1);
      });
    }
  });
});
