/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { DATA_DIR } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import {
  acquireHostExecutionLease,
  releaseHostExecutionLease as releaseHostLease,
  type HostExecutionLease,
} from './db/host-execution-lease.js';
import { updateMessagingGroupMetadataByPlatform } from './db/messaging-groups.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import {
  awaitDeliveryDrains,
  startActiveDeliveryPoll,
  startDeliveryIntake,
  startSweepDeliveryPoll,
  setDeliveryAdapter,
  stopDeliveryPolls,
} from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import {
  awaitContainerSpawns,
  startContainerAdmissions,
  stopAllActiveContainers,
  stopContainerAdmissions,
} from './container-runner.js';
import { performHostShutdown, prepareHostExecutionOwnership, runHostStartupStages } from './host-shutdown.js';
import { routeInbound } from './router.js';
import { log } from './log.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  initChannelAdapters,
  requireChannelAdapterInstances,
  teardownChannelAdapters,
} from './channels/channel-registry.js';
import { createChannelDeliveryBridge } from './channels/delivery-bridge.js';
import { handleMattermostBotRemoved } from './channels/mattermost-subscription.js';

const startupAbortController = new AbortController();
let hostExecutionOwnership: { db: ReturnType<typeof initDb>; lease: HostExecutionLease } | null = null;

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  const startupComplete = await runHostStartupStages(
    [
      // 0. Circuit breaker — backoff on rapid restarts
      async () => enforceStartupBackoff(),
      () => {
        // 1. Init/migrate the central DB and acquire exclusive host execution
        // ownership before any shared filesystem/runtime mutation or intake.
        const dbPath = path.join(DATA_DIR, 'v2.db');
        hostExecutionOwnership = prepareHostExecutionOwnership({
          initializeDatabase: () => initDb(dbPath),
          migrateDatabase: (db) => {
            runMigrations(db);
            log.info('Central DB ready', { path: dbPath });
          },
          acquireExecutionLease: (db) => acquireHostExecutionLease(db),
          // One-time filesystem cutover — idempotent, no-op after first run.
          migrateFilesystem: migrateGroupsToClaudeLocal,
          ensureContainerRuntime: ensureContainerRuntimeRunning,
          cleanupOrphans,
          openContainerAdmissions: startContainerAdmissions,
          openDeliveryIntake: startDeliveryIntake,
        });
      },
      () => {
        // 2. Install delivery before network adapters. An adapter may receive an
        // event as soon as setup authenticates, and owner-approval cards must be
        // deliverable before that event can create pending state.
        setDeliveryAdapter(createChannelDeliveryBridge());
      },
      async () => {
        // 3. Channel adapters. The abort signal makes teardown own any adapter
        // whose asynchronous setup overlaps a termination request.
        const centralDb = hostExecutionOwnership?.db;
        if (!centralDb) throw new Error('Host execution ownership was not initialized');
        const mattermostInstanceRows = centralDb
          .prepare(
            `SELECT instance_key
               FROM mattermost_subscriptions
              WHERE status = 'active'
              UNION
             SELECT instance_key
               FROM pending_mattermost_channel_approvals
              WHERE status IN ('pending', 'processing')`,
          )
          .all() as Array<{ instance_key: string }>;
        const requiredMattermostInstances = new Set(mattermostInstanceRows.map((row) => row.instance_key));
        await initChannelAdapters(
          (adapter: ChannelAdapter): ChannelSetup => {
            return {
              onInbound(platformId, threadId, message) {
                return routeInbound({
                  channelType: adapter.channelType,
                  platformId,
                  threadId,
                  message: {
                    id: message.id,
                    kind: message.kind,
                    content: JSON.stringify(message.content),
                    timestamp: message.timestamp,
                    isMention: message.isMention,
                    isGroup: message.isGroup,
                    attachmentRefs: message.attachmentRefs,
                    loadAttachments: message.loadAttachments,
                  },
                }).catch((err) => {
                  log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
                  throw err;
                });
              },
              onInboundEvent(event) {
                return routeInbound(event).catch((err) => {
                  log.error('Failed to route inbound event', {
                    sourceAdapter: adapter.channelType,
                    targetChannelType: event.channelType,
                    err,
                  });
                  throw err;
                });
              },
              onMetadata(platformId, name, isGroup) {
                const updated =
                  adapter.channelType === 'mattermost' && name !== undefined && isGroup !== undefined
                    ? updateMessagingGroupMetadataByPlatform(adapter.channelType, platformId, name, isGroup)
                    : false;
                log.info('Channel metadata discovered', {
                  channelType: adapter.channelType,
                  platformId,
                  name,
                  isGroup,
                  updated,
                });
              },
              onAction(questionId, selectedOption, userId) {
                dispatchResponse({
                  questionId,
                  value: selectedOption,
                  userId,
                  channelType: adapter.channelType,
                  // platformId/threadId aren't surfaced by the current onAction
                  // signature — registered handlers look them up from the
                  // pending_question / pending_approval row.
                  platformId: '',
                  threadId: null,
                }).catch((err) => {
                  log.error('Failed to handle question response', { questionId, err });
                });
              },
              onLifecycle(event) {
                if (adapter.channelType !== 'mattermost' || event.kind !== 'bot_removed') return;
                return handleMattermostBotRemoved(event.platformId).catch((err) => {
                  log.error('Failed to handle Mattermost lifecycle event', { kind: event.kind, err });
                  throw err;
                });
              },
            };
          },
          {
            signal: startupAbortController.signal,
            strictChannels: ['mattermost'],
            requiredChannels: requiredMattermostInstances.size > 0 ? ['mattermost'] : [],
            requiredInstances: { mattermost: [...requiredMattermostInstances] },
          },
        );
        requireChannelAdapterInstances('mattermost', requiredMattermostInstances);
      },
      () => {
        // 4. Start delivery polls
        startActiveDeliveryPoll();
        startSweepDeliveryPoll();
        log.info('Delivery polls started');
      },
      () => {
        // 5. Start host sweep
        startHostSweep();
        log.info('Host sweep started');
      },
    ],
    startupAbortController.signal,
  );

  if (!startupComplete) {
    log.info('NanoClaw startup interrupted by shutdown');
    return;
  }

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
let shutdownStarted = false;

async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  startupAbortController.abort();
  log.info('Shutdown signal received', { signal });
  try {
    await performHostShutdown({
      stopHostSweep,
      stopDeliveryPolls,
      stopContainerAdmissions,
      async stopExternalIngress() {
        const failures: unknown[] = [];
        for (const cb of getShutdownCallbacks()) {
          try {
            await cb();
            // Stop every registered ingress source before reporting the aggregate failure.
            // eslint-disable-next-line no-catch-all/no-catch-all
          } catch (err) {
            log.error('Shutdown callback threw', { err });
            failures.push(err);
          }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'External ingress shutdown incomplete');
      },
      teardownChannelAdapters,
      awaitDeliveryDrains,
      awaitContainerSpawns,
      stopAllActiveContainers,
      releaseHostExecutionLease() {
        const ownership = hostExecutionOwnership;
        if (!ownership) return;
        if (!releaseHostLease(ownership.db, ownership.lease)) {
          throw new Error('NanoClaw host execution lease release was refused');
        }
        hostExecutionOwnership = null;
      },
    });
    resetCircuitBreaker();
    process.exit(0);
    // A failed drain/stop must become a non-successful process exit.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    log.fatal('Shutdown incomplete', { err });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  if (startupAbortController.signal.aborted) {
    log.info('NanoClaw startup stopped during shutdown');
    return;
  }
  log.fatal('Startup failed', { err });
  process.exit(1);
});
