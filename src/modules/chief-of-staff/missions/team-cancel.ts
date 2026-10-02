import type Database from 'better-sqlite3';
import {
  cosMissionIdentities,
  hasCosMissionBoundary,
  validCosMissionIdentity,
  type CosMissionIdentity,
} from '../../../cos-mission-boundary.js';
import { stopCosMissionFamily } from '../../../cos-mission-stop.js';
import { digest, type Context, type Result } from '../domain/contracts.js';
import type { MissionRunStore } from './run-store.js';
import type { TeamRunStore } from './team-run-store.js';

/** Root-owner validation precedes durable local family fences. Physical absence precedes any credit settlement. */
export function createTeamCancellation(dependencies: {
  db: Database.Database;
  teams: Pick<TeamRunStore, 'cancel' | 'confirmCancellation'>;
  runs: Pick<MissionRunStore, 'confirmStopped'> & Partial<Pick<MissionRunStore, 'confirmUnallocatedCancellation'>>;
  unallocated?(identity: CosMissionIdentity): boolean;
  running(identity: CosMissionIdentity): boolean;
  stop(identity: CosMissionIdentity): Promise<void>;
}) {
  return async (context: Context, teamId: string): Promise<Result> => {
    const result = await dependencies.teams.cancel(context, teamId);
    if (result.status !== 'ok') return result;
    if (
      !['cancelling', 'cancelled'].includes(String(result.state)) ||
      !Array.isArray(result.identities) ||
      !result.identities.every(validCosMissionIdentity) ||
      result.identities.some((i) => i.scopeId !== context.scopeId) ||
      new Set(result.identities.map((i) => i.attemptId)).size !== result.identities.length
    )
      return { status: 'denied' };
    const identities = result.identities as CosMissionIdentity[],
      retained = cosMissionIdentities(dependencies.db);
    if (identities.some((i) => retained.some((r) => r.attemptId === i.attemptId && digest(r) !== digest(i))))
      return { status: 'denied' };
    // Fence every family synchronously before yielding to the first native stop, including late allocations/retries.
    for (const missionId of new Set(identities.map((i) => i.missionId)))
      stopCosMissionFamily(context.scopeId, missionId, 'owner_cancel', dependencies.db);
    let pending = false;
    for (const identity of identities) {
      if (
        !hasCosMissionBoundary(identity.agentGroupId, identity.sessionId, dependencies.db) &&
        dependencies.unallocated?.(identity) &&
        dependencies.runs.confirmUnallocatedCancellation
      ) {
        const proof = await dependencies.runs.confirmUnallocatedCancellation(context, identity);
        if (proof.status === 'ok' && proof.never_allocated === true) continue;
        // No physical absence follows from an uncertain or malformed proof.
        pending = true;
        continue;
      }
      if (dependencies.running(identity)) {
        try {
          await dependencies.stop(identity);
        } catch {
          /* A permanent fence is retained; independently recheck absence below. */
        }
      }
      if (dependencies.running(identity)) {
        pending = true;
        continue;
      }
      const confirmed = await dependencies.runs.confirmStopped(identity);
      if (confirmed.status !== 'ok') pending = true;
    }
    return pending
      ? { status: 'pending', state: 'cancelling' }
      : dependencies.teams.confirmCancellation(context, teamId);
  };
}
