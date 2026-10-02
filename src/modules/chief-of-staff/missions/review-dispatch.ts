import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import { cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { digest, type Result } from '../domain/contracts.js';
import { resolveKnowledgeContext } from '../knowledge/context.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MissionReviewRuns, MissionReviewIdentity, MissionReviewLease } from './review-runs.js';
import type { NativeMissionReviewTasks, NativeReviewTask } from './review-task.js';
import {
  readReviewOrigin,
  reviewContext,
  installReviewOrigin,
  interruptReviewOrigin,
  clearReviewOrigin,
  renewReviewOrigin,
  type ReviewOriginGrant,
} from './review-origin.js';

type Dependencies = {
  db: Database.Database;
  runs: Pick<MissionReviewRuns, 'pending' | 'inspect' | 'claim' | 'authorize' | 'renew' | 'retire'>;
  session(id: string): Session | undefined;
  admitted(binding: CosBinding): Promise<boolean>;
  /** True includes unknown/orphan execution; absence must be independently verified. */
  running(sessionId: string): boolean;
  stop(sessionId: string): void;
  withTasks<T>(session: Session, operation: (tasks: NativeMissionReviewTasks) => Promise<T>): Promise<T>;
  wake(session: Session): Promise<boolean | void>;
};

/** One bounded native task in the retained main conversation; never a new coordinator context. */
export class MissionReviewDispatch {
  private readonly active = new Set<string>();
  constructor(readonly dependencies: Dependencies) {}
  private ownerContext(binding: CosBinding, session: Session): KnowledgeContext | null {
    const d = this.dependencies,
      boundary = cosBoundary(session, d.db);
    if (
      digest(d.session(session.id)) !== digest(session) ||
      !boundary.restricted ||
      !boundary.binding ||
      boundary.paused ||
      !boundary.ingressId ||
      digest(boundary.binding) !== digest(binding)
    )
      return null;
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
  }
  private recoveryContext(binding: CosBinding, grant: ReviewOriginGrant): KnowledgeContext {
    return {
      scopeId: binding.scopeId,
      ownerId: binding.ownerId,
      sessionId: binding.sessionId,
      agentGroupId: binding.agentGroupId,
      ingressId: 'host-review-recovery',
      provider: binding.provider,
      generation: grant.identity.contextGeneration,
    };
  }
  private idle(tasks: NativeMissionReviewTasks, inputId = ''): boolean {
    return !tasks.db
      .prepare(
        "SELECT 1 FROM messages_in WHERE status='pending' AND kind IN ('chat','task') AND (process_after IS NULL OR datetime(process_after)<=datetime('now')) AND id<>? LIMIT 1",
      )
      .get(inputId);
  }
  private closeLocal(binding: CosBinding): void {
    if (interruptReviewOrigin(this.dependencies.db, binding)) this.dependencies.stop(binding.sessionId);
  }
  private async retire(
    binding: CosBinding,
    grant: ReviewOriginGrant,
    tasks: NativeMissionReviewTasks,
    task: NativeReviewTask,
  ): Promise<Result> {
    const d = this.dependencies;
    this.closeLocal(binding);
    const retired = await d.runs.retire(
      this.recoveryContext(binding, grant),
      grant.identity.missionId,
      grant.identity.submissionId,
      grant.lease,
    );
    // Close the native trigger even if the database acknowledgement was lost.
    const native = tasks.retire(binding, task);
    if (retired.status !== 'ok' || !native || d.running(binding.sessionId)) return { status: 'pending' };
    return clearReviewOrigin(d.db, binding, grant) ? { status: 'ok', state: 'retired' } : { status: 'pending' };
  }
  private async resume(
    binding: CosBinding,
    session: Session,
    tasks: NativeMissionReviewTasks,
    initial: ReviewOriginGrant,
  ): Promise<Result> {
    const d = this.dependencies;
    let grant = initial;
    const context = this.recoveryContext(binding, grant),
      identity = grant.identity;
    const inspected = await d.runs.inspect(context, identity.missionId, identity.submissionId);
    if (
      inspected.status !== 'ok' ||
      digest(inspected.identity) !== digest(identity) ||
      !inspected.task ||
      digest((inspected.task as NativeReviewTask).identity) !== digest(identity)
    ) {
      this.closeLocal(binding);
      return { status: 'pending' };
    }
    const task = inspected.task as NativeReviewTask;
    const local = () => {
      const origin = reviewContext(session, d.db);
      return (
        !!origin &&
        digest(d.session(session.id)) === digest(session) &&
        digest(readReviewOrigin(d.db, binding)) === digest(grant)
      );
    };
    const executionContext = () => {
      const origin = reviewContext(session, d.db);
      return origin && local() ? resolveKnowledgeContext(session, origin, d.db) : null;
    };
    const authorize = async () => {
      const current = executionContext();
      return (
        !!current &&
        (await d.runs.authorize(current, identity.missionId, identity.submissionId, grant.lease)).status === 'ok'
      );
    };
    const taskState = tasks.state(binding, task);
    if (
      !local() ||
      inspected.retired ||
      inspected.state !== 'awaiting_review' ||
      digest(inspected.lease) !== digest(grant.lease) ||
      !this.idle(tasks, task.inputId) ||
      (taskState === null && d.running(session.id)) ||
      (taskState !== null && !['pending', 'paused'].includes(taskState))
    )
      return this.retire(binding, grant, tasks, task);
    if (!(await authorize()) || !(await d.admitted(binding)) || !local())
      return this.retire(binding, grant, tasks, task);
    const currentContext = executionContext();
    if (!currentContext) return this.retire(binding, grant, tasks, task);
    const renewed = await d.runs.renew(currentContext, identity.missionId, identity.submissionId, grant.lease);
    if (
      renewed.status !== 'ok' ||
      typeof renewed.deadline_at !== 'string' ||
      !local() ||
      !renewReviewOrigin(d.db, binding, session, grant, renewed.deadline_at)
    )
      return this.retire(binding, grant, tasks, task);
    grant = { ...grant, deadlineAt: renewed.deadline_at };
    if (!tasks.stage(binding, task)) return this.retire(binding, grant, tasks, task);
    if (d.running(session.id)) return { status: 'ok', state: 'running' };
    const current = () => local() && !d.running(session.id) && this.idle(tasks, task.inputId);
    if (
      !(await tasks.activate(binding, task, async () => (await authorize()) && (await d.admitted(binding)), current)) ||
      !current()
    )
      return this.retire(binding, grant, tasks, task);
    // No await between final synchronous native fence and wake admission.
    const woke = await d.wake(session);
    return woke !== false && (woke === true || d.running(session.id))
      ? { status: 'ok', state: 'dispatched' }
      : { status: 'pending', state: 'deferred' };
  }
  async drain(binding: CosBinding): Promise<Result> {
    if (this.active.has(binding.scopeId)) return { status: 'pending' };
    this.active.add(binding.scopeId);
    const d = this.dependencies;
    try {
      const session = d.session(binding.sessionId);
      if (!session) return { status: 'denied' };
      const boundary = cosBoundary(session, d.db);
      if (!boundary.restricted || !boundary.binding || digest(boundary.binding) !== digest(binding))
        return { status: 'denied' };
      return await d.withTasks(session, async (tasks) => {
        const existing = readReviewOrigin(d.db, binding);
        if (existing) return this.resume(binding, session, tasks, existing);
        // A corrupt retained origin stays closed; it is never mistaken for absence.
        if (reviewContext(session, d.db) !== undefined) {
          this.closeLocal(binding);
          return { status: 'pending' };
        }
        const context = this.ownerContext(binding, session);
        if (!context || d.running(session.id) || !this.idle(tasks)) return { status: 'pending' };
        const unchanged = () =>
          digest(this.ownerContext(binding, session)) === digest(context) && !d.running(session.id) && this.idle(tasks);
        if (!(await d.admitted(binding)) || !unchanged()) return { status: 'denied' };
        const pending = await d.runs.pending(context);
        if (pending.status !== 'ok' || !Array.isArray(pending.items)) return pending;
        for (const item of pending.items) {
          if (!unchanged()) return { status: 'pending' };
          const claimed = await d.runs.claim(
            context,
            item.mission_id,
            item.submission_id,
            'cos-review-' + digest(binding),
          );
          if (claimed.status === 'denied') continue;
          if (claimed.status !== 'ok') return claimed;
          const grant: ReviewOriginGrant = {
            identity: claimed.identity as MissionReviewIdentity,
            lease: claimed.lease as MissionReviewLease,
            deadlineAt: String(claimed.deadline_at),
          };
          if (!unchanged() || !installReviewOrigin(d.db, binding, session, grant)) {
            await d.runs.retire(context, item.mission_id, item.submission_id, grant.lease);
            return { status: 'pending' };
          }
          // Persist the local origin before staging any native work. A crash is recovered from remote metadata.
          return this.resume(binding, session, tasks, grant);
        }
        return { status: 'ok', state: 'absent' };
      });
    } catch {
      this.closeLocal(binding);
      return { status: 'pending' };
    } finally {
      this.active.delete(binding.scopeId);
    }
  }
}
