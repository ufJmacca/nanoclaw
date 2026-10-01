import { writeSessionMessage } from '../../session-manager.js';
import type Database from 'better-sqlite3';
import type { Session, MessagingGroup } from '../../types.js';
import { cosBoundary, setCosBoundaryHooks, type CosBinding } from '../../cos-boundary.js';
import { registerDeliveryAction } from '../../delivery.js';
import { deletePendingApproval } from '../../db/sessions.js';
import { requestCorrelatedApproval } from '../approvals/correlated.js';
import { CosController } from './bridge/controller.js';
import { CosOutbox } from './bridge/outbox.js';
import { createRpcHandler } from './bridge/rpc.js';
import { validPrivateChannel, type ChannelFacts } from './bridge/identity.js';
import type { PriorityStore } from './store/priorities.js';
import type { CoordinatorLauncher } from './bridge/coordinator-launcher.js';
import { createTurnAuthorization } from './bridge/turn-authorization.js';
import { resolveKnowledgeContext } from './knowledge/context.js';
import { digest, type Context } from './domain/contracts.js';
import { KnowledgeInvalidation } from './knowledge/invalidation.js';

export type RuntimeDependencies = {
  db: Database.Database;
  enabled: boolean;
  admission?(): boolean;
  store?: PriorityStore;
  facts(binding: CosBinding): Promise<ChannelFacts>;
  session(id: string): Session | undefined;
  destination(id: string): MessagingGroup | undefined;
  stop(sessionId: string): void;
  wake(session: Session): Promise<void>;
  launcher?: CoordinatorLauncher;
};
export function createCosRuntime(dependencies: RuntimeDependencies) {
  const d = dependencies;
  let disposed = false;
  const enabled = () => !disposed && d.enabled && !!d.store && (d.admission?.() ?? true);
  const knowledgeAllowed = async (session: Session, context: Context, text?: string): Promise<boolean> => {
    if (!d.store?.knowledge) return true;
    const retained = resolveKnowledgeContext(session, context, d.db);
    if (!retained || (await d.store.knowledge.contextReady(retained)).status !== 'ok') return false;
    if (text !== undefined && (await d.store.knowledge.answers.authorizePublication(retained, text)).status !== 'ok')
      return false;
    const current = resolveKnowledgeContext(session, context, d.db);
    return !!current && digest(current) === digest(retained);
  };
  const controller = new CosController({
    db: d.db,
    enabled,
    facts: d.facts,
    session: d.session,
    decide: (...args) => (d.store ? d.store.decide(...args) : Promise.resolve({ status: 'unavailable' })),
    acknowledge: (proposal) => deletePendingApproval('cos-' + proposal),
    stop: d.stop,
    wake: d.wake,
    project: (session, event) => {
      writeSessionMessage(session.agent_group_id, session.id, {
        id: `${event.message.id}:${session.agent_group_id}`,
        kind: 'chat',
        timestamp: event.message.timestamp,
        platformId: event.platformId,
        channelType: 'mattermost',
        threadId: null,
        content: event.message.content,
        trigger: 1,
        idempotent: true,
      });
    },
  });
  const admitted = async (binding: CosBinding): Promise<boolean> => {
    if (!enabled()) return false;
    const session = d.session(binding.sessionId);
    if (!session) return false;
    const boundary = cosBoundary(session, d.db);
    if (!boundary.restricted || !boundary.binding || boundary.paused) return false;
    if (!validPrivateChannel(binding, await d.facts(binding))) return false;
    const current = cosBoundary(session, d.db);
    return current.restricted && !!current.binding && !current.paused;
  };
  const outbox = d.store
    ? new CosOutbox({
        store: d.store,
        admitted,
        preview: async (binding, preview) => {
          const session = d.session(preview.sessionId),
            destination = d.destination(binding.messagingGroupId);
          if (
            !session ||
            !destination ||
            destination.platform_id !== `mattermost:${binding.instanceId}:${binding.channelId}`
          )
            return false;
          return requestCorrelatedApproval({
            id: preview.id,
            session,
            ownerId: binding.ownerId,
            destination,
            payload: { proposal_id: preview.proposalId, change: preview.change },
            text: preview.text,
            expiresAt: preview.expiresAt,
            validateDestination: async () =>
              (await admitted(binding)) && (await d.store!.previewCurrent(binding, preview.proposalId, preview.change)),
          });
        },
      })
    : null;
  const invalidations = d.store?.knowledge
    ? new KnowledgeInvalidation({ db: d.db, store: d.store.knowledge, session: d.session, stop: d.stop })
    : null;
  setCosBoundaryHooks({
    executionReady: (binding) => enabled() && (d.launcher?.ready(binding) ?? false),
    launch: async (binding, session) => {
      if (!d.launcher || !enabled()) throw new Error('restricted_launch_denied');
      return d.launcher.prepare(
        binding,
        session,
        createTurnAuthorization({
          local: () => controller.localContext(session),
          verify: async () => {
            const context = await controller.context(session);
            return context &&
              d.store &&
              (await d.store.context(context)).status === 'ok' &&
              (await knowledgeAllowed(session, context))
              ? context
              : null;
          },
        }),
      );
    },
    ingress: (binding, event) => controller.ingress(binding, event),
    validatePrivateDestination: async (binding, purpose, text) => {
      if (!(await admitted(binding))) return false;
      const session = d.session(binding.sessionId);
      if (!session || !d.store) return false;
      const context = await controller.context(session);
      // The authenticated private RPC may return an unavailable receipt during a DB outage.
      // Ordinary model text still requires a successful current scoped store check.
      return (
        !!context &&
        (purpose === 'rpc' ||
          (typeof text === 'string' &&
            (await d.store.context(context)).status === 'ok' &&
            (await knowledgeAllowed(session, context, text))))
      );
    },
  });
  if (enabled())
    registerDeliveryAction(
      'cos_rpc',
      createRpcHandler({
        resolveContext: (session) => controller.context(session),
        store: d.store!,
        knowledge: d.store!.knowledge,
        resolveKnowledgeContext: async (session, context) => resolveKnowledgeContext(session, context, d.db),
      }),
    );
  return {
    controller,
    pump: async (binding: CosBinding) => {
      if (enabled()) await invalidations?.drain(binding);
      if (enabled()) await outbox?.drain(binding);
      // An approved source change may enqueue invalidation in this same pump.
      if (enabled()) await invalidations?.drain(binding);
      // Retention is an already-approved deletion obligation, independent of model pause.
      if (enabled()) await d.store?.knowledge?.purgeDue(binding.scopeId);
    },
    dispose: () => {
      disposed = true;
      setCosBoundaryHooks(null);
    },
  };
}
