import type { TeamRunStore } from './team-run-store.js';
import { createTeamCancellation } from './team-cancel.js';
import type { Context, Result } from '../domain/contracts.js';

/** The same native fence/stop proof serves owner cancellation and denial-only terminal recovery. */
export function createTeamRetirement(
  dependencies: Omit<Parameters<typeof createTeamCancellation>[0], 'teams' | 'familyReason'> & {
    teams: Pick<TeamRunStore, 'inspect' | 'cancel' | 'confirmCancellation' | 'retire' | 'confirmRetirement'>;
  },
) {
  const cancelled = createTeamCancellation(dependencies),
    retired = createTeamCancellation({
      ...dependencies,
      familyReason: 'origin_revoked',
      teams: {
        cancel: (context, id) => dependencies.teams.retire(context, id),
        confirmCancellation: (context, id) => dependencies.teams.confirmRetirement(context, id),
      },
    });
  return async (context: Context, teamId: string): Promise<Result> => {
    const metadata = await dependencies.teams.inspect(context, teamId);
    if (metadata.status !== 'ok') return metadata;
    const state = (metadata.team as { state?: unknown } | undefined)?.state;
    if (state === 'cancelling' || state === 'cancelled') return cancelled(context, teamId);
    if (['queued', 'running', 'awaiting_review', 'blocked', 'failed'].includes(String(state)))
      return retired(context, teamId);
    return { status: 'denied' };
  };
}
