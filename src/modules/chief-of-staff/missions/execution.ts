import type Database from 'better-sqlite3';
import {
  cosMissionIdentities,
  hasCosMissionBoundary,
  validCosMissionIdentity,
  type CosMissionIdentity,
} from '../../../cos-mission-boundary.js';
import { hasTable } from '../../../db/connection.js';
import { digest } from '../domain/contracts.js';

type Options = {
  db: Database.Database;
  assertHostAuthority(): void;
  session(id: string): { agent_group_id: string } | undefined;
  directory(group: string, session: string): string;
  running(id: string): boolean;
  stop(id: string): void;
  probe: { present(directory: string): boolean; stop(directory: string): void };
};
/** Exact permanent reservations permit denial and absence checks, never a launch. */
export function createMissionExecution(options: Options) {
  const directory = (identity: CosMissionIdentity) => {
    options.assertHostAuthority();
    const reserved = cosMissionIdentities(options.db).find((row) => row.sessionId === identity.sessionId);
    if (!reserved || digest(reserved) !== digest(identity)) throw Error('mission_execution_identity_unknown');
    const session = options.session(identity.sessionId);
    if (session && session.agent_group_id !== identity.agentGroupId) throw Error('mission_execution_identity_conflict');
    return options.directory(identity.agentGroupId, identity.sessionId);
  };
  return {
    /** Local negative evidence only. The caller must also prove no dispatch lease was ever issued in PostgreSQL. */
    unallocated(identity: CosMissionIdentity): boolean {
      try {
        options.assertHostAuthority();
        if (
          !validCosMissionIdentity(identity) ||
          hasCosMissionBoundary(identity.agentGroupId, identity.sessionId, options.db) ||
          options.session(identity.sessionId) ||
          options.running(identity.sessionId)
        )
          return false;
        if (
          hasTable(options.db, 'agent_groups') &&
          options.db.prepare('SELECT 1 FROM agent_groups WHERE id=?').get(identity.agentGroupId)
        )
          return false;
        if (
          hasTable(options.db, 'cos_mission_allocations') &&
          options.db
            .prepare(
              "SELECT 1 FROM cos_mission_allocations WHERE attempt_id=? OR json_extract(identity,'$.sessionId')=? OR json_extract(identity,'$.agentGroupId')=?",
            )
            .get(identity.attemptId, identity.sessionId, identity.agentGroupId)
        )
          return false;
        return true;
      } catch {
        return false;
      }
    },
    running(identity: CosMissionIdentity): boolean {
      try {
        const workspace = directory(identity);
        return options.running(identity.sessionId) || options.probe.present(workspace);
      } catch {
        return true;
      }
    },
    async stop(identity: CosMissionIdentity): Promise<void> {
      const workspace = directory(identity);
      options.stop(identity.sessionId);
      options.probe.stop(workspace);
    },
  };
}
