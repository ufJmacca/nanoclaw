import type Database from 'better-sqlite3';
import { getDb } from '../../../db/connection.js';
import { getSession } from '../../../db/sessions.js';
import { cosBoundary } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { readTeamAdmission } from './team-admission.js';
import type { MissionAuthorityResolver } from './proposal-store.js';
import type { TeamAuthorityResolver } from './team-proposal-store.js';

/** Additional operator permission, under the existing native single-worker authority.
 * This read never creates context, prepares credentials, reserves model use or opens source access.
 */
export function createTeamAuthorityResolver(options: {
  targetRoot: string;
  db: Database.Database;
  missionAuthority: MissionAuthorityResolver;
}): TeamAuthorityResolver {
  return (context) => {
    try {
      const base = options.missionAuthority(context);
      if (!base || options.db !== getDb()) return null;
      const session = getSession(context.sessionId);
      if (!session) return null;
      const boundary = cosBoundary(session, options.db);
      if (!boundary.restricted) return null;
      const binding = boundary.binding;
      if (
        boundary.paused ||
        !binding ||
        digest(binding) !== base.bindingDigest ||
        binding.scopeId !== context.scopeId ||
        binding.ownerId !== context.ownerId ||
        binding.agentGroupId !== context.agentGroupId ||
        binding.sessionId !== context.sessionId
      )
        return null;
      const record = readTeamAdmission(options.targetRoot, binding);
      if (!record?.enabled) return null;
      // A changed underlying authority or operator revision cannot be combined into a fresh grant.
      const current = options.missionAuthority(context),
        retained = readTeamAdmission(options.targetRoot, binding);
      if (!current || digest(current) !== digest(base) || !retained || digest(retained) !== digest(record)) return null;
      return {
        ...base,
        templateBundleDigest: record.templateBundleDigest,
        teamPolicyDigest: digest(record),
      };
    } catch {
      return null;
    }
  };
}
