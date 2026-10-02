import type { Context, Result } from '../domain/contracts.js';
import type { TeamRunStore } from './team-run-store.js';

const teamId = (value: unknown): value is string => typeof value === 'string' && /^team-[a-f0-9]{64}$/.test(value);
/** Bounded event/intent transitions only. MissionHost retains the one native worker dispatcher. */
export class TeamGraphPump {
  private readonly cursors = new Map<string, string | null>();
  constructor(
    readonly options: {
      teams: Pick<TeamRunStore, 'pendingGraphs' | 'advance' | 'claimReady' | 'requestRework'>;
      local(context: Context): boolean;
    },
  ) {}
  private changed(result: Result): boolean {
    if (result.status === 'denied') return false;
    if (result.status !== 'ok') throw Error('team_transition_unavailable');
    return true;
  }
  async drain(context: Context): Promise<void> {
    if (context.origin || !this.options.local(context)) return;
    const page = await this.options.teams.pendingGraphs(context, this.cursors.get(context.scopeId) ?? null);
    if (!this.options.local(context)) return;
    if (page.status === 'denied') {
      this.cursors.delete(context.scopeId);
      return;
    }
    if (page.status !== 'ok') throw Error('team_discovery_unavailable');
    if (
      !Array.isArray(page.items) ||
      page.items.length > 4 ||
      !page.items.every(teamId) ||
      new Set(page.items).size !== page.items.length ||
      page.items.some((item, i) => i > 0 && item <= (page.items as string[])[i - 1]) ||
      !(page.next_after === null || (page.items.length === 4 && page.next_after === page.items.at(-1)))
    )
      throw Error('team_discovery_invalid');
    for (const id of page.items as string[]) {
      if (!this.options.local(context)) return;
      const advanced = await this.options.teams.advance(context, id);
      if (!this.options.local(context)) return;
      if (!this.changed(advanced)) continue;
      if (!['queued', 'running', 'awaiting_review', 'blocked', 'failed'].includes(String(advanced.state)))
        throw Error('team_transition_invalid');
      if (advanced.state === 'awaiting_review') {
        const submissionId = advanced.review_submission_id;
        if (submissionId === null) continue;
        if (typeof submissionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(submissionId))
          throw Error('team_transition_invalid');
        const reworked = await this.options.teams.requestRework(context, id, submissionId);
        if (!this.options.local(context)) return;
        if (!this.changed(reworked)) continue;
      } else if (['blocked', 'failed'].includes(String(advanced.state))) continue;
      if (!this.options.local(context)) return;
      this.changed(await this.options.teams.claimReady(context, id));
    }
    this.cursors.set(context.scopeId, page.next_after as string | null);
  }
}
