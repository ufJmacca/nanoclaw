import { randomUUID } from 'node:crypto';
import { getDb } from '../../../db/connection.js';
import { getSession } from '../../../db/sessions.js';
import { log } from '../../../log.js';
import { hasCosMissionBoundary, missionBoundary, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { isCosMissionStopped, stopCosMissionAttempt, stoppedCosMissionIdentities } from '../../../cos-mission-stop.js';
import { installCosMissionExecutionHooks } from '../../../cos-mission-execution.js';
import type { CosLaunch } from '../../../cos-boundary.js';
import type { Session } from '../../../types.js';
import { digest, type Context, type Result } from '../domain/contracts.js';
import type { MissionRunStore, MissionDispatchLease } from './run-store.js';
import type { NativeMissionAllocation, NativeMissionInput, NativeMissionPaths } from './native-allocation.js';
export type MissionLauncher = {
  prepare(
    input: NativeMissionInput,
    paths: NativeMissionPaths,
    session: Session,
    authorize: () => Promise<boolean>,
  ): Promise<CosLaunch>;
  close(sessionId: string): Promise<void>;
};
type Dependencies = {
  runs: Pick<
    MissionRunStore,
    | 'claimDispatch'
    | 'authorizeDispatch'
    | 'markDispatchReady'
    | 'beginExecution'
    | 'renewDispatch'
    | 'fail'
    | 'confirmStopped'
  >;
  allocation: Pick<NativeMissionAllocation, 'prepare'>;
  launcher: MissionLauncher;
  local(context: Context): boolean;
  admitted(context: Context): Promise<boolean>;
  /** Must verify exact native stop/absence, including any host-restart orphan reconciliation. */
  stopped(identity: CosMissionIdentity): Promise<boolean>;
  wake?(session: Session): Promise<boolean>;
  stop?(identity: CosMissionIdentity, reason: string): Promise<void>;
  pollIntervalMs?: number;
  clock?: () => number;
};
type Entry = {
  input: NativeMissionInput;
  lease: MissionDispatchLease;
  context: Context;
  paths?: NativeMissionPaths;
  phase: 'allocating' | 'ready' | 'running';
  expires: number;
};
/** Asynchronous host dispatcher: never waits for a worker's result and never sends through native A2A routes. */
export class MissionDispatch {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Set<string>();
  private readonly owner = 'mission-host-' + randomUUID();
  private readonly remove: () => void;
  private readonly timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private polling = false;
  constructor(readonly dependencies: Dependencies) {
    this.remove = installCosMissionExecutionHooks({
      ready: (identity) => this.ready(identity),
      launch: (identity, session) => this.launch(identity, session),
    });
    const interval = dependencies.pollIntervalMs ?? 5000;
    if (interval > 0) {
      this.timer = setInterval(() => void this.poll(), interval);
      this.timer.unref();
    }
  }
  private now() {
    return (this.dependencies.clock ?? (() => performance.now()))();
  }
  private local(entry: Entry) {
    if (entry.phase !== 'allocating') {
      const session = getSession(entry.input.identity.sessionId);
      if (!session) return false;
      const boundary = missionBoundary(session, getDb());
      if (!boundary.restricted || !boundary.identity || digest(boundary.identity) !== digest(entry.input.identity))
        return false;
    }
    return (
      !this.closed &&
      this.entries.get(entry.input.identity.attemptId) === entry &&
      entry.expires > this.now() &&
      this.dependencies.local(entry.context) &&
      !isCosMissionStopped(entry.input.identity, getDb())
    );
  }
  private ready(identity: CosMissionIdentity) {
    const entry = this.entries.get(identity.attemptId);
    return (
      !!entry &&
      !!entry.paths &&
      entry.phase !== 'allocating' &&
      digest(entry.input.identity) === digest(identity) &&
      this.local(entry)
    );
  }
  private async verify(entry: Entry): Promise<boolean> {
    try {
      if (!this.local(entry) || !(await this.dependencies.admitted(entry.context))) return false;
      return (
        (await this.dependencies.runs.authorizeDispatch(entry.input.identity, entry.lease)).status === 'ok' &&
        this.local(entry)
      );
    } catch {
      return false;
    }
  }
  private async wake(session: Session) {
    return this.dependencies.wake
      ? this.dependencies.wake(session)
      : (await import('../../../container-runner.js')).wakeContainer(session);
  }
  private async stop(identity: CosMissionIdentity) {
    if (this.dependencies.stop) await this.dependencies.stop(identity, 'mission_authority_lost');
    else (await import('../../../container-runner.js')).killContainer(identity.sessionId, 'Mission authority lost');
  }
  private async fence(entry: Entry): Promise<void> {
    const i = entry.input.identity;
    if (this.entries.get(i.attemptId) !== entry) return;
    this.entries.delete(i.attemptId);
    let owned = !!entry.paths;
    try {
      if (hasCosMissionBoundary(i.agentGroupId, i.sessionId, getDb())) {
        stopCosMissionAttempt(i, 'authority_lost', getDb());
        owned = true;
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- A corrupt local journal cannot prevent stopping an already verified owned child.
    } catch {
      log.warn('Mission stop journal requires reconciliation', { attemptId: i.attemptId });
    }
    // Only a completed allocation or an exact permanent marker identifies a child we may stop.
    if (owned) await this.stop(i).catch(() => undefined);
    await this.dependencies.launcher.close(i.sessionId).catch(() => undefined);
    const failed = await this.dependencies.runs.fail(i, 'admission_denied').catch(() => ({ status: 'unavailable' }));
    if (failed.status === 'ok' && (await this.dependencies.stopped(i).catch(() => false)))
      await this.dependencies.runs.confirmStopped(i).catch(() => undefined);
  }
  private async launch(identity: CosMissionIdentity, session: Session): Promise<CosLaunch> {
    const entry = this.entries.get(identity.attemptId);
    if (!entry) throw new Error('restricted_launch_denied');
    try {
      if (!entry.paths || !this.ready(identity) || !(await this.verify(entry)))
        throw new Error('restricted_launch_denied');
      const prepared = await this.dependencies.launcher.prepare(entry.input, entry.paths, session, () =>
        this.verify(entry),
      );
      if (!(await this.verify(entry))) throw new Error('restricted_launch_denied');
      if ((await this.dependencies.runs.beginExecution(identity, entry.lease)).status !== 'ok' || !this.local(entry))
        throw new Error('restricted_launch_denied');
      entry.phase = 'running';
      return prepared;
    } catch (error) {
      await this.fence(entry);
      throw new Error('restricted_launch_denied', { cause: error });
    }
  }
  async dispatch(context: Context, attemptId: string): Promise<Result> {
    if (this.closed || this.active.has(attemptId)) return { status: 'pending' };
    this.active.add(attemptId);
    let entry: Entry | undefined;
    try {
      const d = this.dependencies;
      if (!d.local(context) || !(await d.admitted(context))) return { status: 'denied' };
      const previous = this.entries.get(attemptId);
      if (previous?.phase === 'running') {
        if (await this.verify(previous)) return { status: 'ok', state: 'running', attempt_id: attemptId };
        await this.fence(previous);
        return { status: 'denied' };
      }
      const started = this.now();
      const claimed = await d.runs.claimDispatch(context, attemptId, this.owner);
      if (claimed.status !== 'ok') return claimed;
      entry = {
        context,
        input: {
          identity: claimed.identity as CosMissionIdentity,
          inputId: String(claimed.inputId),
          order: claimed.order as NativeMissionInput['order'],
        },
        lease: claimed.lease as MissionDispatchLease,
        phase: 'allocating',
        expires: started + 20000,
      };
      this.entries.set(attemptId, entry);
      const captured = entry;
      entry.paths = await d.allocation.prepare(entry.input, () => this.verify(captured));
      if (
        !this.local(entry) ||
        (await d.runs.markDispatchReady(entry.input.identity, entry.lease, digest(entry.paths))).status !== 'ok'
      )
        throw new Error('mission_dispatch_denied');
      entry.phase = 'ready';
      const session = getSession(entry.input.identity.sessionId);
      if (!session || !(await this.verify(entry))) throw new Error('mission_dispatch_denied');
      const woke = await this.wake(session);
      if (!this.local(entry)) return { status: 'denied' };
      // A false wake preserves readiness and its stable input, without claiming execution or completion.
      return woke && this.entries.get(attemptId)?.phase === 'running'
        ? { status: 'ok', state: 'running', attempt_id: attemptId }
        : { status: 'pending', state: 'deferred', attempt_id: attemptId };
    } catch {
      if (entry) await this.fence(entry);
      return { status: 'denied' };
    } finally {
      this.active.delete(attemptId);
    }
  }
  async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      for (const entry of [...this.entries.values()]) {
        if (this.active.has(entry.input.identity.attemptId)) continue;
        const started = this.now();
        try {
          if (
            !this.local(entry) ||
            !(await this.dependencies.admitted(entry.context)) ||
            (await this.dependencies.runs.renewDispatch(entry.input.identity, entry.lease)).status !== 'ok' ||
            !this.local(entry)
          )
            await this.fence(entry);
          else entry.expires = started + 20000;
        } catch {
          await this.fence(entry);
        }
      }
    } finally {
      this.polling = false;
    }
  }
  /** Local fences survive process/database loss; reconciliation never reopens their identities. */
  async reconcileStops(): Promise<void> {
    for (const identity of stoppedCosMissionIdentities(getDb())) {
      await this.stop(identity);
      const result = await this.dependencies.runs.fail(identity, 'admission_denied');
      if (['ok', 'denied'].includes(result.status) && (await this.dependencies.stopped(identity)))
        await this.dependencies.runs.confirmStopped(identity);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.remove();
    for (const entry of [...this.entries.values()]) await this.fence(entry);
  }
}
