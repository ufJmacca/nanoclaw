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
import { digest, type Context, type Result } from './domain/contracts.js';
import { KnowledgeInvalidation } from './knowledge/invalidation.js';
import { NativeBriefTasks } from './automation/native-tasks.js';
import { BriefDelivery } from './automation/brief-delivery.js';
import { BriefReconciliation } from './automation/brief-reconciliation.js';
import { BriefDispatch } from './automation/brief-dispatch.js';
import { BriefRefresh } from './automation/brief-refresh.js';
import { createMissionCancellation } from './missions/cancel.js';
import { MissionNotificationDelivery } from './missions/notification-delivery.js';
import { MissionReviewDispatch } from './missions/review-dispatch.js';
import { NativeMissionReviewTasks } from './missions/review-task.js';
import { reviewContext } from './missions/review-origin.js';
import { CoordinatorReviewRuns } from './missions/coordinator-review-runs.js';
import { createTeamCancellation } from './missions/team-cancel.js';
import type { CosMissionIdentity } from '../../cos-mission-boundary.js';
import { NativeMandateTasks } from './automation/mandate-native.js';
import { MandatePump } from './automation/mandate-pump.js';
import { ActionPump } from './actions/pump.js';
import { ActionNotificationDelivery } from './actions/notification-delivery.js';
import type { KnowledgeContext } from './knowledge/store.js';

export type RuntimeDependencies = {
  db: Database.Database;
  enabled: boolean;
  admission?(): boolean;
  store?: PriorityStore;
  facts(binding: CosBinding): Promise<ChannelFacts>;
  session(id: string): Session | undefined;
  destination(id: string): MessagingGroup | undefined;
  stop(sessionId: string): void;
  wake(session: Session): Promise<boolean | void>;
  launcher?: CoordinatorLauncher;
  running?(sessionId: string): boolean;
  missionExecution?: {
    unallocated?(identity: CosMissionIdentity): boolean;
    running(identity: CosMissionIdentity): boolean;
    stop(identity: CosMissionIdentity): Promise<void>;
  };
  withBriefTasks?<T>(session: Session, operation: (tasks: NativeBriefTasks) => T): T;
  withReviewTasks?<T>(session: Session, operation: (tasks: NativeMissionReviewTasks) => T): T;
  withMandateTasks?<T>(session: Session, operation: (tasks: NativeMandateTasks) => T): T;
  projectActionNotice?(context: KnowledgeContext, text: string, id: string): void;
};
export function createCosRuntime(dependencies: RuntimeDependencies) {
  const d = dependencies;
  let disposed = false;
  const reviewRuns = d.store?.missionReviewRuns
    ? new CoordinatorReviewRuns(d.store.missionReviewRuns, d.store.teamFinalReviews)
    : undefined;
  const enabled = () => !disposed && d.enabled && !!d.store && (d.admission?.() ?? true);
  const reviewAuthority = async (context: Context, receiptOnly: boolean): Promise<boolean> => {
    if (!enabled() || context.origin?.kind !== 'mission_review' || !reviewRuns) return false;
    const session = d.session(context.sessionId),
      retained = session && resolveKnowledgeContext(session, context, d.db);
    const origin = context.origin;
    return (
      !!retained &&
      (
        await reviewRuns.authorize(
          retained,
          origin.runId,
          origin.submissionId,
          { owner: origin.owner, fence: origin.fence },
          receiptOnly,
        )
      ).status === 'ok'
    );
  };
  const reserveAutomaticCall = async (context: Context, callId: string, kind: 'model' | 'tool'): Promise<Result> => {
    if (!enabled() || !context.origin || !d.store) return { status: 'denied' };
    const origin = context.origin;
    if (origin.kind === 'schedule')
      return d.store.briefs.reserveCall(context, origin.runId, origin.generation, kind, callId);
    const session = d.session(context.sessionId),
      retained = session && resolveKnowledgeContext(session, context, d.db);
    if (!retained || !reviewRuns) return { status: 'denied' };
    const result = await reviewRuns.reserve(
      retained,
      origin.runId,
      origin.submissionId,
      { owner: origin.owner, fence: origin.fence },
      callId,
      kind,
    );
    // An accounting receipt is not permission for another physical invocation.
    return result.status === 'ok' && result.reserved !== true ? { status: 'pending' } : result;
  };
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
    verifyReview: (context) => reviewAuthority(context, true),
    decide: (...args) => (d.store ? d.store.decide(...args) : Promise.resolve({ status: 'unavailable' })),
    acknowledge: (proposal) => deletePendingApproval('cos-' + proposal),
    stop: d.stop,
    wake: async (session) => {
      await d.wake(session);
    },
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
  const localActionContext = (binding: CosBinding): KnowledgeContext | null => {
    if (!enabled()) return null;
    const session = d.session(binding.sessionId),
      boundary = session && cosBoundary(session, d.db);
    if (
      !session ||
      !boundary?.restricted ||
      !boundary.binding ||
      boundary.paused ||
      !boundary.ingressId ||
      digest(boundary.binding) !== digest(binding)
    )
      return null;
    // Exact approval and the executor's lease govern effects. This lookup grants no model invocation.
    return resolveKnowledgeContext(
      session,
      {
        scopeId: binding.scopeId,
        ownerId: binding.ownerId,
        sessionId: binding.sessionId,
        agentGroupId: binding.agentGroupId,
        ingressId: boundary.ingressId,
      },
      d.db,
    );
  };
  const actionPump = d.store?.actions?.dependencies?.witness
    ? new ActionPump({
        current: localActionContext,
        admitted,
        recover: (context, offset) => d.store!.actions.runs.recoverWitnesses(context, offset),
        pending: (context, after) => d.store!.actions.runs.pending(context, after),
        execute: (context, id, permit) => d.store!.actions.executor.run(context, id, permit),
      })
    : undefined;
  const actionNotices =
    d.store?.actions?.notifications && d.store.actions.dependencies?.witness
      ? new ActionNotificationDelivery({
          notices: d.store.actions.notifications,
          witness: d.store.actions.dependencies.witness,
          current: localActionContext,
          admitted: async (binding) => {
            const adapter = getDeliveryAdapter();
            return !!adapter && adapter.isAvailable?.('mattermost') !== false && (await admitted(binding));
          },
          project: (context, text, id) => {
            if (d.projectActionNotice) return d.projectActionNotice(context, text, id);
            const session = d.session(context.sessionId);
            if (!session) throw new Error('action_result_session_unavailable');
            writeSessionMessage(session.agent_group_id, session.id, {
              id: id + ':' + session.agent_group_id,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: null,
              channelType: 'mattermost',
              threadId: null,
              content: JSON.stringify({ role: 'assistant', content: text }),
              trigger: 0,
              idempotent: true,
            });
          },
          send: (context, text, id) => {
            const adapter = getDeliveryAdapter(),
              session = d.session(context.sessionId),
              boundary = session && cosBoundary(session, d.db),
              binding = boundary?.restricted ? boundary.binding : null;
            if (!binding || !adapter || !localActionContext(binding))
              throw new Error('action_result_destination_unavailable');
            return adapter.deliver(
              'mattermost',
              `mattermost:${binding.instanceId}:${binding.channelId}`,
              null,
              'chat',
              JSON.stringify({ text }),
              undefined,
              id,
            );
          },
        })
      : undefined;
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
          if (!fresh) return { status: 'denied' };
          const ready = await d.store.knowledge.contextReady(fresh);
          if (ready.status !== 'ok' || !current()) return ready.status === 'ok' ? { status: 'denied' } : ready;
          const prepared = await d.store.proactive.scheduledBatch({
            ...fresh,
            ingressId: `brief:${run.id}:${run.generation}`,
            origin: { kind: 'schedule', runId: run.id, generation: run.generation },
          });
          return current() ? { status: prepared.status } : { status: 'denied' };
        },
        wake: async (session) => {
          await d.wake(session);
        },
      })
    : null;
  const reviewDispatch = reviewRuns
    ? new MissionReviewDispatch({
        db: d.db,
        runs: reviewRuns,
        session: d.session,
        admitted: briefAdmission,
        running: (id) => d.running?.(id) ?? true,
        stop: d.stop,
        wake: d.wake,
        withTasks: async (session, operation) => {
          if (d.withReviewTasks) return await d.withReviewTasks(session, operation);
          const inbound = openInboundDb(session.agent_group_id, session.id);
          try {
            return await operation(new NativeMissionReviewTasks(inbound));
          } finally {
            inbound.close();
          }
        },
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
  const mandatePump = d.store?.mandates
    ? new MandatePump({
        store: d.store.mandates,
        current: (binding) => {
          const session = d.session(binding.sessionId);
          if (!enabled() || !session) return false;
          const boundary = cosBoundary(session, d.db);
          return (
            boundary.restricted &&
            !!boundary.binding &&
            !boundary.paused &&
            digest(boundary.binding) === digest(binding)
          );
        },
        admitted,
        withTasks: (binding, operation) => {
          const session = d.session(binding.sessionId);
          if (!session || session.agent_group_id !== binding.agentGroupId)
            throw Error('cos_mandate_session_unavailable');
          if (d.withMandateTasks) return d.withMandateTasks(session, operation);
          const inbound = openInboundDb(session.agent_group_id, session.id);
          try {
            return operation(new NativeMandateTasks(inbound));
          } finally {
            inbound.close();
          }
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
            (await reserveAutomaticCall(context, attemptId, 'model')).status === 'ok',
          verify: async () => {
            const context = await controller.context(session);
            if (context?.origin?.kind === 'mission_review' && !(await reviewAuthority(context, false))) return null;
            if (
              !context ||
              !d.store ||
              (await d.store.context(context)).status !== 'ok' ||
              !(await knowledgeAllowed(session, context))
            )
              return null;
            if (context.origin?.kind === 'schedule') {
              const retained = resolveKnowledgeContext(session, context, d.db);
              if (!retained || (await d.store.proactive.scheduledBatch(retained)).status !== 'ok') return null;
            }
            return context;
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
        reserveTool: (context, callId) => reserveAutomaticCall(context, callId, 'tool'),
        store: d.store!,
        cancelMission: createMissionCancellation({
          db: d.db,
          runs: d.store!.missionRuns,
          stop: (identity) => d.stop(identity.sessionId),
        }),
        cancelTeam:
          d.missionExecution && d.store?.teamRuns
            ? createTeamCancellation({
                db: d.db,
                teams: d.store.teamRuns,
                runs: d.store.missionRuns,
                running: d.missionExecution.running,
                stop: d.missionExecution.stop,
                unallocated: d.missionExecution.unallocated,
              })
            : undefined,
        knowledge: d.store!.knowledge,
        resolveKnowledgeContext: async (session, context) => resolveKnowledgeContext(session, context, d.db),
      }),
    );
  return {
    controller,
    pump: async (binding: CosBinding) => {
      if (enabled()) await invalidations?.drain(binding);
      const recovered = enabled() ? await briefReconciliation?.drain(binding) : undefined;
      if (enabled()) await reviewDispatch?.drain(binding);
      if (enabled()) await outbox?.drain(binding);
      if (enabled()) await actionPump?.drain(binding);
      if (enabled()) await actionNotices?.drain(binding);
      if (enabled()) await mandatePump?.drain(binding);
      if (enabled() && d.store)
        for (const notifications of [d.store.missionNotifications, d.store.teamNotifications]) {
          if (!notifications || !enabled()) continue;
          const adapter = getDeliveryAdapter();
          const current = () => {
            if (!enabled()) return null;
            const session = d.session(binding.sessionId);
            if (!session) return null;
            const boundary = cosBoundary(session, d.db);
            if (
              !boundary.restricted ||
              !boundary.binding ||
              boundary.paused ||
              !boundary.ingressId ||
              digest(boundary.binding) !== digest(binding)
            )
              return null;
            // Delivery is authorized by the approved mission and its recorded review,
            // not by extending the original owner event's model/tool authority.
            // The resolver retains all context-generation and automation fences.
            return resolveKnowledgeContext(
              session,
              {
                scopeId: binding.scopeId,
                ownerId: binding.ownerId,
                sessionId: session.id,
                agentGroupId: binding.agentGroupId,
                ingressId: boundary.ingressId,
              },
              d.db,
            );
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
      // Review results get a delivery opportunity before a new briefing can occupy
      // the shared context. A retained review fence must not consume a due brief.
      const main = d.session(binding.sessionId);
      if (
        enabled() &&
        main &&
        reviewContext(main, d.db) === undefined &&
        recovered?.status === 'ok' &&
        ['absent', 'dispatched'].includes(String(recovered.state))
      )
        await briefDispatch?.drain(binding);
      // An approved source change may enqueue invalidation in this same pump.
      if (enabled()) await invalidations?.drain(binding);
      // Retention is an already-approved deletion obligation, independent of model pause.
      if (enabled()) await d.store?.knowledge?.purgeDue(binding.scopeId);
    },
    dispose: () => {
      disposed = true;
      actionPump?.close();
      actionNotices?.close();
      setCosBoundaryHooks(null);
    },
  };
}
