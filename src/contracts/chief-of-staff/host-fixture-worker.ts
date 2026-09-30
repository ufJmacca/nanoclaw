import path from 'node:path';
import pg from 'pg';
import type { CosBinding } from '../../cos-boundary.js';
import { fixtureDatabaseConfig, connectFixtureDatabase } from './fixture-database.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { connectionFault } from './connection-fault.js';

if (process.env.COS_FIXTURE_HOST_PROCESS !== 'S01' || !process.send) throw new Error('fixture_only');
let handle: ((command: string, value: any) => Promise<unknown>) | undefined;
async function start(input: { root: string; binding: CosBinding; ordinarySessionId: string }) {
  if (!path.isAbsolute(input.root) || !input.root.includes('/.cos-plan-state/fixtures/flow-'))
    throw new Error('fixture_root_required');
  process.chdir(input.root);
  const { initDb, closeDb } = await import('../../db/connection.js');
  const { runMigrations } = await import('../../db/migrations/index.js');
  const { getSession, getPendingApproval } = await import('../../db/sessions.js');
  const { getMessagingGroup } = await import('../../db/messaging-groups.js');
  const { sessionDir } = await import('../../session-manager.js');
  const { openInboundDb } = await import('../../db/session-db.js');
  const { stopContainerAdmissions } = await import('../../container-runner.js');
  const { createCosRuntime } = await import('../../modules/chief-of-staff/runtime.js');
  const { setDeliveryAdapter, startDeliveryIntake, deliverSessionMessages, stopAndDrainDeliveryPolls } =
    await import('../../delivery.js');
  const { routeInbound } = await import('../../router.js');
  stopContainerAdmissions(); // Fixture providers are explicit containers; no native provider or paid wake is allowed.
  const check = await connectFixtureDatabase(process.env);
  await check.end();
  const relay = await connectionFault(await fixtureDatabaseConfig(process.env));
  const store = new PriorityStore(new BoundedDatabase(new pg.Pool(relay.config), 600));
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
