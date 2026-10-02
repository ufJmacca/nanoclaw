import type Database from 'better-sqlite3';
import { cosMissionIdentities, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
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
