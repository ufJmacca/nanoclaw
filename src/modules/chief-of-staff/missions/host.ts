import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import { getSession } from '../../../db/sessions.js';
import { cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { cosMissionIdentities, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { isCosMissionStopped, stopCosMissionAttempt } from '../../../cos-mission-stop.js';
import { registerDeliveryAction } from '../../../delivery.js';
import { validPrivateChannel, type ChannelFacts } from '../bridge/identity.js';
import { digest, type Context } from '../domain/contracts.js';
import type { SpecialistLifecycle } from '../service.js';
import type { MissionAuthorityResolver } from './proposal-store.js';
import type { MissionRunStore } from './run-store.js';
import { MissionDispatch, type MissionLauncher } from './dispatch.js';
import { NativeMissionAllocation } from './native-allocation.js';
import { createMissionLauncher } from './launcher.js';
import { createMissionRpcHandler } from './rpc.js';
import type { TeamRunStore } from './team-run-store.js';
import { TeamGraphPump } from './team-graph-pump.js';

type Options = {
  root: string;
  db: Database.Database;
  runs: MissionRunStore;
  teams?: TeamRunStore;
  authority: MissionAuthorityResolver;
  admitted(): boolean;
  assertHostAuthority(): void;
  facts(binding: CosBinding): Promise<ChannelFacts>;
  running(identity: CosMissionIdentity): boolean;
  stop(identity: CosMissionIdentity): Promise<void>;
  wake(session: Session): Promise<boolean>;
};
/** One host-owned lifecycle per checked runtime pool. No ordinary A2A route or channel binding is created. */
export class MissionHost implements SpecialistLifecycle {
  private readonly dispatcher: MissionDispatch;
  private readonly graphs?: TeamGraphPump;
  private readonly launcher: MissionLauncher & { shutdown(): Promise<void> };
  private readonly settled = new Set<string>();
  private readonly cursors = new Map<string, string | null>();
  private readonly retirementCursors = new Map<string, string | null>();
  private closed = false;
  private inFlight?: Promise<void>;
  private closing?: Promise<void>;
  constructor(
    readonly options: Options,
    adapters: {
      allocation?: Pick<NativeMissionAllocation, 'prepare'>;
      launcher?: MissionLauncher & { shutdown(): Promise<void> };
      register?: typeof registerDeliveryAction;
    } = {},
  ) {
    options.assertHostAuthority();
    if (options.teams) {
      if (options.teams.database !== options.runs.database) throw Error('team_runtime_pool_mismatch');
      this.graphs = new TeamGraphPump({ teams: options.teams, local: (context) => this.local(context) });
    }
    const allocation = adapters.allocation ?? new NativeMissionAllocation({ root: options.root });
    this.launcher =
      adapters.launcher ??
      createMissionLauncher({
        targetRoot: options.root,
        db: options.db,
        runs: options.runs,
        authority: options.authority,
        running: (id) => {
          const identity = cosMissionIdentities(options.db).find((i) => i.sessionId === id);
          return !identity || options.running(identity);
        },
      });
    this.dispatcher = new MissionDispatch({
      runs: options.runs,
      allocation,
      launcher: this.launcher,
      pollIntervalMs: 0,
      local: (context) => this.local(context),
      admitted: (context) => this.admitted(context),
      stopped: async (identity) => !options.running(identity),
      stop: (identity) => options.stop(identity),
      wake: options.wake,
    });
    (adapters.register ?? registerDeliveryAction)(
      'cos_mission_rpc',
      createMissionRpcHandler({
        resolve: (session) => (this.closed ? Promise.resolve(null) : this.dispatcher.workerGrant(session)),
        runs: options.runs,
        submit: (identity, lease, requestId, callId, result) =>
          options.runs.submitResult(identity, lease, requestId, callId, result),
      }),
    );
  }
  private local(context: Context): boolean {
    try {
      this.options.assertHostAuthority();
      return !this.closed && this.options.admitted() && !!this.options.authority(context);
    } catch {
      return false;
    }
  }
  private async admitted(context: Context): Promise<boolean> {
    if (!this.local(context)) return false;
    const session = getSession(context.sessionId),
      boundary = session && cosBoundary(session, this.options.db);
    if (!boundary?.restricted || boundary.paused || !boundary.binding) return false;
    const binding = boundary.binding;
    if (
      binding.scopeId !== context.scopeId ||
      binding.ownerId !== context.ownerId ||
      binding.agentGroupId !== context.agentGroupId
    )
      return false;
    const facts = await this.options.facts(binding);
    const after = getSession(context.sessionId),
      fresh = after && cosBoundary(after, this.options.db);
    return (
      this.local(context) &&
      validPrivateChannel(binding, facts) &&
      !!fresh?.restricted &&
      !fresh.paused &&
      digest(fresh.binding) === digest(binding)
    );
  }
  private async reconcile(): Promise<void> {
    for (const identity of cosMissionIdentities(this.options.db)) {
      if (this.closed) return;
      if (this.settled.has(identity.attemptId) || this.dispatcher.owns(identity)) continue;
      const state = await this.options.runs.inspectRecovery(identity);
      if (!['ok', 'denied'].includes(state.status)) throw Error('mission_recovery_unavailable');
      if (this.closed) return;
      const absent = !this.options.running(identity);
      if (state.status === 'ok' && state.stop_confirmed === true && absent) {
        this.settled.add(identity.attemptId);
        continue;
      }
      if (
        state.status === 'ok' &&
        state.state === 'queued' &&
        ['queued', 'allocating', 'ready'].includes(String(state.attempt_state)) &&
        state.current_generation === true &&
        state.admitted === true &&
        !isCosMissionStopped(identity, this.options.db) &&
        absent &&
        (await this.admitted(state.context as Context))
      )
        continue;
      // A running orphan never inherits a new lease. Preserve submissions while confirming their exact stop.
      stopCosMissionAttempt(identity, 'authority_lost', this.options.db);
      await this.options.stop(identity);
      const failed = await this.options.runs.fail(identity, 'admission_denied');
      if (!['ok', 'denied'].includes(failed.status) || this.options.running(identity))
        throw Error('mission_recovery_pending');
      const confirmed = await this.options.runs.confirmStopped(identity);
      if (!['ok', 'denied'].includes(confirmed.status)) throw Error('mission_recovery_pending');
      this.settled.add(identity.attemptId);
    }
  }
  pump(binding: CosBinding): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const run = async () => {
      this.options.assertHostAuthority();
      await this.dispatcher.poll();
      await this.reconcile();
      if (this.closed) return;
      const context: Context = {
        scopeId: binding.scopeId,
        ownerId: binding.ownerId,
        agentGroupId: binding.agentGroupId,
        sessionId: binding.sessionId,
        ingressId: 'host-mission-dispatch',
      };
      this.options.assertHostAuthority();
      if (!this.options.admitted()) return;
      const retirement = await this.options.runs.retireUnallocated(
        context,
        this.retirementCursors.get(binding.scopeId) ?? null,
      );
      if (this.closed) return;
      if (retirement.status === 'denied') {
        this.retirementCursors.delete(binding.scopeId);
        return;
      }
      if (retirement.status !== 'ok') throw Error('mission_retirement_unavailable');
      this.retirementCursors.set(
        binding.scopeId,
        typeof retirement.next_after === 'string' ? retirement.next_after : null,
      );
      if (!(await this.admitted(context))) return;
      await this.graphs?.drain(context);
      if (this.closed || !this.local(context)) return;
      const pending = await this.options.runs.pendingDispatch(context, this.cursors.get(binding.scopeId) ?? null);
      if (this.closed) return;
      if (pending.status === 'denied') {
        this.cursors.delete(binding.scopeId);
        return;
      }
      if (pending.status !== 'ok' || !Array.isArray(pending.items)) throw Error('mission_discovery_unavailable');
      this.cursors.set(binding.scopeId, typeof pending.next_after === 'string' ? pending.next_after : null);
      for (const item of pending.items as Array<{ identity: CosMissionIdentity; context: Context }>) {
        if (this.closed) return;
        await this.dispatcher.dispatch(item.context, item.identity.attemptId);
      }
    };
    this.inFlight = run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  fenceLocal(): void {
    this.closed = true;
    this.dispatcher.fenceLocal();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fenceLocal();
    this.closing = (async () => {
      await this.inFlight?.catch(() => undefined);
      await this.dispatcher.close();
      await this.launcher.shutdown();
    })().catch((error) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
