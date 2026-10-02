import type Database from 'better-sqlite3';
import type { CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { stopCosMissionFamily, stoppedCosMissionIdentities } from '../../../cos-mission-stop.js';
import type { Context, Result } from '../domain/contracts.js';
import type { MissionRunStore } from './run-store.js';

/** Owner-only store validation precedes the local deny fence; a stop request is not proof of absence. */
export function createMissionCancellation(dependencies: {
  db: Database.Database;
  runs: Pick<MissionRunStore, 'cancel'>;
  stop(identity: CosMissionIdentity): void | Promise<void>;
}) {
  return async (context: Context, missionId: string): Promise<Result> => {
    const result = await dependencies.runs.cancel(context, missionId);
    if (result.status !== 'ok') return result;
    stopCosMissionFamily(context.scopeId, missionId, 'owner_cancel', dependencies.db);
    let pending = false;
    for (const identity of stoppedCosMissionIdentities(dependencies.db)) {
      if (identity.scopeId !== context.scopeId || identity.missionId !== missionId) continue;
      try {
        await dependencies.stop(identity);
      } catch {
        // The durable fence stays closed when physical stop requires reconciliation.
        pending = true;
      }
    }
    return pending ? { status: 'pending', state: 'cancelling' } : result;
  };
}
