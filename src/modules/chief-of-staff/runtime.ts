import { writeSessionMessage, openInboundDb } from '../../session-manager.js';
import type Database from 'better-sqlite3';
import type { Session, MessagingGroup } from '../../types.js';
import { cosBoundary, setCosBoundaryHooks, type CosBinding } from '../../cos-boundary.js';
import { registerDeliveryAction, getDeliveryAdapter } from '../../delivery.js';
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
import { NativeBriefTasks } from './automation/native-tasks.js';
import { BriefDelivery } from './automation/brief-delivery.js';
import { BriefReconciliation } from './automation/brief-reconciliation.js';
import { BriefDispatch } from './automation/brief-dispatch.js';
import { BriefRefresh } from './automation/brief-refresh.js';
import { createMissionCancellation } from './missions/cancel.js';
import { MissionNotificationDelivery } from './missions/notification-delivery.js';

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
  running?(sessionId: string): boolean;
  withBriefTasks?<T>(session: Session, operation: (tasks: NativeBriefTasks) => T): T;
};
export function createCosRuntime(dependencies: RuntimeDependencies) {
  const d = dependencies;
  let disposed = false;
  const enabled = () => !disposed && d.enabled && !!d.store && (d.admission?.() ?? true);
  const knowledgeAllowed = async (session: Session, context: Context, text?: string): Promise<boolean> => {
    if (!d.store?.knowledge) return true;
    const retained = resolveKnowledgeContext(session, context, d.db);
    if (!retained || (await d.store.knowledge.contextReady(retained)).status !== 'ok') return false;
    if (text !== undefined) {
      const answer = await d.store.knowledge.answers.authorizePublication(retained, text);
      if (
        answer.status !== 'ok' &&
        (answer.status !== 'denied' ||
          !d.store.briefArtifacts ||
          (await d.store.briefArtifacts.authorizePublication(retained, text)).status !== 'ok')
      )
        return false;
    }
    const current = resolveKnowledgeContext(session, context, d.db);
    return !!current && digest(current) === digest(retained);
  };
  const controller = new CosController({
    db: d.db,
    enabled,
    facts: d.facts,
    session: d.session,
    verifyScheduled: async (context) =>
      context.origin?.kind === 'schedule' &&
      !!d.store &&
      (await d.store.briefs.authorize(context, context.origin.runId, context.origin.generation)).status === 'ok',
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
    if (!boundary.restricted || !boundary.binding || boundary.paused || digest(boundary.binding) !== digest(binding))
      return false;
    if (!validPrivateChannel(binding, await d.facts(binding))) return false;
    const current = cosBoundary(session, d.db);
    return current.restricted && !!current.binding && !current.paused && digest(current.binding) === digest(binding);
  };
  const withTasks = <T>(binding: CosBinding, operation: (tasks: NativeBriefTasks) => T): T => {
    const session = d.session(binding.sessionId);
    if (!session || session.agent_group_id !== binding.agentGroupId) throw Error('cos_brief_session_unavailable');
    if (d.withBriefTasks) return d.withBriefTasks(session, operation);
    const inbound = openInboundDb(session.agent_group_id, session.id);
    try {
      return operation(new NativeBriefTasks(inbound));
    } finally {
      inbound.close();
    }
  };
  const localBriefContext = (binding: CosBinding) => {
    const session = d.session(binding.sessionId),
      context = session && controller.localContext(session);
    return session && context?.origin?.kind === 'schedule' ? resolveKnowledgeContext(session, context, d.db) : null;
  };
  const briefAdmission = async (binding: CosBinding) =>
    (d.launcher?.ready(binding) ?? false) && (await admitted(binding));
  const briefReconciliation = d.store?.briefArtifacts
    ? new BriefReconciliation({
        db: d.db,
        runs: d.store.briefs,
        local: localBriefContext,
        admitted: briefAdmission,
        running: (id) => d.running?.(id) ?? true,
        stop: d.stop,
        retire: (binding, run) => withTasks(binding, (tasks) => tasks.retire(binding, run)),
        taskState: (binding, run) => withTasks(binding, (tasks) => tasks.state(binding, run)),
        deliver: async (context) => {
          const session = d.session(context.sessionId),
            adapter = getDeliveryAdapter();
          const boundary = session && cosBoundary(session, d.db);
          const binding = boundary?.restricted ? boundary.binding : null;
          if (!binding || !adapter || adapter.isAvailable?.('mattermost') === false) return { status: 'unavailable' };
          return new BriefDelivery({
            runs: d.store!.briefs,
            artifacts: d.store!.briefArtifacts!,
            current: () => localBriefContext(binding),
            admitted: () => briefAdmission(binding),
            send: (_context, text, notificationId) =>
              adapter.deliver(
                'mattermost',
                `mattermost:${binding.instanceId}:${binding.channelId}`,
                null,
                'chat',
                JSON.stringify({ text }),
                undefined,
                notificationId,
              ),
          }).deliver(context);
        },
      })
    : null;
  const briefDispatch = d.store?.briefArtifacts
    ? new BriefDispatch({
        db: d.db,
        runs: d.store.briefs,
        session: d.session,
        admitted: briefAdmission,
        running: (id) => d.running?.(id) ?? true,
        withTasks: async (session, operation) => {
          if (d.withBriefTasks) return await d.withBriefTasks(session, operation);
          const inbound = openInboundDb(session.agent_group_id, session.id);
          try {
            return await operation(new NativeBriefTasks(inbound));
          } finally {
            inbound.close();
          }
        },
        prepare: async (binding, context, run) => {
          if (!d.store?.knowledge) return { status: 'denied' };
          const session = d.session(binding.sessionId),
            boundary = session && cosBoundary(session, d.db);
          if (!session || !boundary?.restricted || !boundary.ingressId) return { status: 'denied' };
          const ownerContext = { ...context, ingressId: boundary.ingressId };
          const current = () =>
            enabled() && digest(cosBoundary(session, d.db)) === digest(boundary) && !(d.running?.(session.id) ?? true);
          const retained = resolveKnowledgeContext(session, ownerContext, d.db);
          if (!retained || !current()) return { status: 'denied' };
          const readable = await d.store.knowledge.contextReady(retained);
          if (!current()) return { status: 'denied' };
          if (readable.status !== 'ok') return readable;
          const refreshed = await new BriefRefresh({
            runs: d.store.briefs,
            connector: d.store.calendar,
            current,
            beforeRefresh: async (_plan, signal) => {
              // Replace before any snapshot changes: the new generation has no old calendar exposure.
              const authority = await d.store!.briefs.authorize(context, run.id, run.generation, signal);
              if (authority.status !== 'ok') return authority;
              if (!(await briefAdmission(binding)) || !current() || signal.aborted || !d.launcher?.renewBriefContext)
                return { status: signal.aborted ? 'pending' : 'denied' };
              d.launcher.renewBriefContext(
                binding,
                { runId: run.id, runGeneration: run.generation, expectedGeneration: retained.generation },
                () => current() && !signal.aborted,
              );
              return { status: 'ok' };
            },
          }).execute(context, run.id, run.generation, binding.provider, run.limits.refresh_seconds);
          if (!current()) return { status: 'denied' };
          if (refreshed.status !== 'ok') return refreshed;
          const fresh = resolveKnowledgeContext(session, ownerContext, d.db);
          return fresh ? await d.store.knowledge.contextReady(fresh) : { status: 'denied' };
        },
        wake: d.wake,
      })
    : null;
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
          reserve: async (context, attemptId) =>
            context.origin?.kind === 'schedule' &&
            !!d.store &&
            (
              await d.store.briefs.reserveCall(
                context,
                context.origin.runId,
                context.origin.generation,
                'model',
                attemptId,
              )
            ).status === 'ok',
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
          (!context.origin &&
            typeof text === 'string' &&
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
        reserveTool: (context, callId) =>
          context.origin?.kind === 'schedule' && d.store
            ? d.store.briefs.reserveCall(context, context.origin.runId, context.origin.generation, 'tool', callId)
            : Promise.resolve({ status: 'denied' }),
        store: d.store!,
        cancelMission: createMissionCancellation({
          db: d.db,
          runs: d.store!.missionRuns,
          stop: (identity) => d.stop(identity.sessionId),
        }),
        knowledge: d.store!.knowledge,
        resolveKnowledgeContext: async (session, context) => resolveKnowledgeContext(session, context, d.db),
      }),
    );
  return {
    controller,
    pump: async (binding: CosBinding) => {
      if (enabled()) await invalidations?.drain(binding);
      if (enabled()) {
        const recovered = await briefReconciliation?.drain(binding);
        if (recovered?.status === 'ok' && ['absent', 'dispatched'].includes(String(recovered.state)))
          await briefDispatch?.drain(binding);
      }
      if (enabled()) await outbox?.drain(binding);
      if (enabled() && d.store?.missionNotifications) {
        const notifications = d.store.missionNotifications,
          adapter = getDeliveryAdapter();
        const current = () => {
          const session = d.session(binding.sessionId),
            context = session && controller.localContext(session);
          return session &&
            context &&
            !context.origin &&
            context.scopeId === binding.scopeId &&
            context.agentGroupId === binding.agentGroupId &&
            context.ownerId === binding.ownerId
            ? resolveKnowledgeContext(session, context, d.db)
            : null;
        };
        const context = current();
        if (context && adapter && adapter.isAvailable?.('mattermost') !== false && (await admitted(binding))) {
          const pending = await notifications.pending(context);
          if (pending.status === 'ok' && Array.isArray(pending.review_ids)) {
            const delivery = new MissionNotificationDelivery({
              notifications,
              current,
              admitted: () => admitted(binding),
              send: (_context, text, id) =>
                adapter.deliver(
                  'mattermost',
                  `mattermost:${binding.instanceId}:${binding.channelId}`,
                  null,
                  'chat',
                  JSON.stringify({ text }),
                  undefined,
                  id,
                ),
            });
            for (const reviewId of pending.review_ids) {
              if (!enabled() || digest(current()) !== digest(context)) break;
              await delivery.deliver(context, String(reviewId));
            }
          }
        }
      }
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
