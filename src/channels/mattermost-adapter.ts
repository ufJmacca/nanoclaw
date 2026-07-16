import { log } from '../log.js';
import {
  registerInboundAttachmentLoaderFactory,
  type ChannelAdapter,
  type ChannelSetup,
  type InboundAttachmentLoader,
  type InboundEvent,
} from './adapter.js';
import { MattermostClient, type MattermostClientConfig, type MattermostTransport } from './mattermost-client.js';
import {
  createMattermostInboundAttachmentLoader,
  MattermostInboundProcessor,
  normalizeMattermostChannelUpdatedPayload,
  normalizeMattermostLifecyclePayload,
  type MattermostInboundConfig,
} from './mattermost-inbound.js';
import { MATTERMOST_POST_MAX_FILES, MattermostOutboundDelivery } from './mattermost-outbound.js';
import {
  bootstrapLegacyMattermostRecoveryCursors,
  hasMattermostApprovalMembershipWork,
  recoverMattermostApprovalsForAuthenticatedMembership,
} from '../modules/permissions/mattermost-channel-approval.js';
import {
  claimMattermostPostReceipt,
  completeMattermostPostReceipt,
  MattermostRecoveryCoordinator,
  releaseMattermostPostReceipt,
  resetMattermostProcessingReceipts,
} from './mattermost-recovery.js';

export interface MattermostAdapterConfig extends MattermostClientConfig {
  allowMassMentions?: boolean;
}

/**
 * Assemble the native Mattermost adapter without registering it globally.
 * Registration remains gated on the strict subscription boundary in Phase 5.
 */
export function createMattermostAdapter(
  config: MattermostAdapterConfig,
  transport: MattermostTransport,
): ChannelAdapter {
  const outbound = new MattermostOutboundDelivery(config, transport);
  let connected = false;
  let socketConnected = false;
  let setupComplete = false;
  let inbound: MattermostInboundProcessor | null = null;
  let inboundConfig: MattermostInboundConfig | null = null;
  let recovery: MattermostRecoveryCoordinator | null = null;
  let recoveryReady: Promise<MattermostRecoveryCoordinator> | null = null;
  let resolveRecoveryReady: ((coordinator: MattermostRecoveryCoordinator) => void) | null = null;
  let rejectRecoveryReady: ((reason: unknown) => void) | null = null;
  let startupBarrier: Promise<void> = Promise.resolve();
  let resolveStartupBarrier: (() => void) | null = null;
  let rejectStartupBarrier: ((reason: unknown) => void) | null = null;
  let unregisterAttachmentLoaderFactory: (() => void) | null = null;
  let lifecycleGeneration = 0;
  const recoveryHooks = new Set<Promise<void>>();
  const recover = (): Promise<void> => {
    const execution = (async () => {
      await inbound?.drain();
      const coordinator = recovery ?? (await recoveryReady);
      if (!coordinator) throw new Error('Mattermost recovery is not initialized');
      await coordinator.recoverActiveChannels();
    })();
    recoveryHooks.add(execution);
    void execution.then(
      () => recoveryHooks.delete(execution),
      () => recoveryHooks.delete(execution),
    );
    return execution;
  };
  const client = new MattermostClient(config, transport, undefined, {
    onSequenceGap: recover,
    onConnectionReset: recover,
    onConnectionStateChange: (isSocketConnected) => {
      socketConnected = isSocketConnected;
      connected = socketConnected && setupComplete;
    },
  });

  const createInboundAttachmentLoader = (event: InboundEvent): InboundAttachmentLoader | undefined => {
    if (event.channelType !== 'mattermost' || event.message.kind !== 'chat' || event.message.isGroup !== true) {
      return undefined;
    }
    const platformPrefix = `mattermost:${config.instanceKey}:`;
    if (!event.platformId.startsWith(platformPrefix)) return undefined;
    const channelId = event.platformId.slice(platformPrefix.length);
    if (!isValidMattermostIdentityComponent(channelId) || !isValidMattermostIdentityComponent(event.message.id)) {
      return undefined;
    }
    const opaqueReferences = event.message.attachmentRefs;
    if (
      !Array.isArray(opaqueReferences) ||
      opaqueReferences.length === 0 ||
      opaqueReferences.length > MATTERMOST_POST_MAX_FILES ||
      opaqueReferences.some(
        (reference) =>
          !reference ||
          typeof reference !== 'object' ||
          Object.keys(reference).length !== 1 ||
          !isValidMattermostIdentityComponent(reference.id),
      ) ||
      new Set(opaqueReferences.map((reference) => reference.id)).size !== opaqueReferences.length
    ) {
      return undefined;
    }
    return createMattermostInboundAttachmentLoader(
      config,
      transport,
      opaqueReferences.map((reference) => ({
        fileId: reference.id,
        postId: event.message.id,
        channelId,
      })),
      { logger: log },
    );
  };

  return {
    name: 'mattermost',
    channelType: 'mattermost',
    platformInstanceKey: config.instanceKey,
    supportsThreads: true,
    threadSessionPolicy: 'honor-wiring',
    createInboundAttachmentLoader,
    async setup(host: ChannelSetup) {
      const setupGeneration = ++lifecycleGeneration;
      const assertSetupCurrent = (): void => {
        if (setupGeneration !== lifecycleGeneration) {
          throw new Error('Mattermost adapter setup cancelled');
        }
      };
      setupComplete = false;
      connected = false;
      socketConnected = false;
      startupBarrier = new Promise<void>((resolve, reject) => {
        resolveStartupBarrier = resolve;
        rejectStartupBarrier = reject;
      });
      // Event handlers observe this rejection through their own await. Keep a
      // handler attached for the no-event startup-failure case as well.
      void startupBarrier.catch(() => {});
      recoveryReady = new Promise<MattermostRecoveryCoordinator>((resolve, reject) => {
        resolveRecoveryReady = resolve;
        rejectRecoveryReady = reject;
      });
      void recoveryReady.catch(() => {});
      unregisterAttachmentLoaderFactory?.();
      const unregisterForSetup = registerInboundAttachmentLoaderFactory('mattermost', createInboundAttachmentLoader);
      unregisterAttachmentLoaderFactory = unregisterForSetup;
      try {
        const context = await client.setup(async (payload) => {
          await startupBarrier;
          const processor = inbound;
          const processorConfig = inboundConfig;
          if (!processor || !processorConfig)
            throw new Error('Mattermost inbound recovery barrier was not initialized');
          const metadata = normalizeMattermostChannelUpdatedPayload(payload, processorConfig);
          if (metadata) {
            await processor.handleMetadata(metadata, (update) =>
              host.onMetadata(update.platformId, update.name, update.isGroup),
            );
            return;
          }
          const lifecycle = normalizeMattermostLifecyclePayload(payload, processorConfig);
          if (lifecycle) {
            try {
              await processor.handleLifecycle(lifecycle, (event) => host.onLifecycle?.(event));
            } catch (err) {
              log.warn('Mattermost lifecycle handling failed', { err });
              throw err;
            }
            return;
          }
          try {
            await processor.handle(payload);
          } catch (err) {
            log.warn('Mattermost inbound handling failed', { err });
            throw err;
          }
        });
        assertSetupCurrent();
        inboundConfig = {
          instanceKey: config.instanceKey,
          botUserId: context.botUserId,
          createAttachmentLoader: (references) =>
            createMattermostInboundAttachmentLoader(config, transport, references, { logger: log }),
        };
        inbound = new MattermostInboundProcessor(
          inboundConfig,
          (event) =>
            host.onInbound(event.platformId, event.threadId, {
              id: event.message.id,
              kind: event.message.kind,
              content: JSON.parse(event.message.content),
              timestamp: event.message.timestamp,
              isMention: event.message.isMention,
              isGroup: event.message.isGroup,
              attachmentRefs: event.message.attachmentRefs,
              loadAttachments: event.message.loadAttachments,
            }),
          log,
          {
            claim: claimMattermostPostReceipt,
            complete: completeMattermostPostReceipt,
            release: releaseMattermostPostReceipt,
          },
        );
        resetMattermostProcessingReceipts(config.instanceKey);
        recovery = new MattermostRecoveryCoordinator(
          config,
          transport,
          (payload) => {
            if (!inbound) throw new Error('Mattermost recovery processor is unavailable');
            return inbound.handle(payload);
          },
          {
            failedHeadId: (platformId) => inbound?.failedHeadId(platformId),
            approvalRecovery: {
              hasWork: () => hasMattermostApprovalMembershipWork(config.instanceKey),
              reconcile: (currentChannelIds) =>
                recoverMattermostApprovalsForAuthenticatedMembership(config.instanceKey, currentChannelIds).then(
                  () => undefined,
                ),
              bootstrapLegacy: () => bootstrapLegacyMattermostRecoveryCursors(config.instanceKey),
            },
            stateSink: {
              onMetadata: (metadata) => {
                if (!inbound) throw new Error('Mattermost recovery processor is unavailable');
                return inbound.handleMetadata(metadata, (update) =>
                  host.onMetadata(update.platformId, update.name, update.isGroup),
                );
              },
              onBotRemoved: (platformId) => {
                if (!inbound) throw new Error('Mattermost recovery processor is unavailable');
                return inbound.handleLifecycle({ kind: 'bot_removed', platformId }, (event) =>
                  host.onLifecycle?.(event),
                );
              },
            },
          },
        );
        resolveRecoveryReady?.(recovery);
        resolveRecoveryReady = null;
        rejectRecoveryReady = null;
        try {
          await recovery.recoverActiveChannels();
          assertSetupCurrent();
          resolveStartupBarrier?.();
        } catch (err) {
          rejectStartupBarrier?.(err);
          client.teardown();
          throw err;
        } finally {
          resolveStartupBarrier = null;
          rejectStartupBarrier = null;
        }
        assertSetupCurrent();
        setupComplete = true;
        connected = socketConnected;
      } catch (err) {
        rejectStartupBarrier?.(err);
        rejectRecoveryReady?.(err);
        rejectRecoveryReady = null;
        client.teardown();
        const pendingHooks = await Promise.allSettled([...recoveryHooks]);
        await Promise.allSettled([
          recovery?.drain() ?? Promise.resolve(),
          inbound?.drain() ?? Promise.resolve(),
          ...pendingHooks.map((result) =>
            result.status === 'rejected' ? Promise.reject(result.reason) : Promise.resolve(),
          ),
        ]);
        setupComplete = false;
        connected = false;
        socketConnected = false;
        inbound = null;
        inboundConfig = null;
        recovery = null;
        recoveryReady = null;
        resolveRecoveryReady = null;
        resolveStartupBarrier = null;
        rejectStartupBarrier = null;
        unregisterForSetup();
        if (unregisterAttachmentLoaderFactory === unregisterForSetup) {
          unregisterAttachmentLoaderFactory = null;
        }
        throw err;
      }
    },
    async teardown() {
      lifecycleGeneration += 1;
      setupComplete = false;
      unregisterAttachmentLoaderFactory?.();
      unregisterAttachmentLoaderFactory = null;
      const cancellation = new Error('Mattermost adapter setup cancelled');
      rejectStartupBarrier?.(cancellation);
      rejectRecoveryReady?.(cancellation);
      rejectRecoveryReady = null;
      client.teardown();
      const hookResults = await Promise.allSettled([...recoveryHooks]);
      await recovery?.drain();
      await inbound?.drain();
      inbound = null;
      inboundConfig = null;
      recovery = null;
      recoveryReady = null;
      resolveRecoveryReady = null;
      connected = false;
      socketConnected = false;
      const hookFailures = hookResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
        .filter((reason) => reason !== cancellation);
      if (hookFailures.length > 0) {
        throw new AggregateError(hookFailures, 'Mattermost recovery hook drain failed');
      }
    },
    isConnected: () => connected,
    async deliver(platformId, threadId, message) {
      return outbound.deliver(platformId, threadId, message);
    },
  };
}

function isValidMattermostIdentityComponent(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}
