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
      open?(): boolean;
      retire?(context: Context, teamId: string): Promise<Result>;
      admit?(context: Context): Promise<boolean>;
    },
  ) {}
  private changed(result: Result): boolean {
    if (result.status === 'denied') return false;
    if (result.status !== 'ok') throw Error('team_transition_unavailable');
    return true;
  }
  private open(context: Context) {
    return this.options.open?.() ?? this.options.local(context);
  }
  private async retire(context: Context, id: string): Promise<boolean> {
    if (!this.options.retire) return false;
    const result = await this.options.retire(context, id);
    if (result.status === 'denied') return false;
    if (result.status === 'ok' && ['blocked', 'failed', 'cancelling', 'cancelled'].includes(String(result.state)))
      return true;
    if (result.status === 'pending' && result.state === 'cancelling') return true;
    throw Error('team_retirement_unavailable');
  }
  async drain(context: Context): Promise<void> {
    if (context.origin || !this.open(context)) return;
    const page = await this.options.teams.pendingGraphs(context, this.cursors.get(context.scopeId) ?? null);
    if (!this.open(context)) return;
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
      if (!this.open(context)) return;
      if (await this.retire(context, id)) continue;
      if (!this.options.local(context)) continue;
      if (this.options.admit && !(await this.options.admit(context))) continue;
      if (!this.options.local(context)) continue;
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
      } else if (['blocked', 'failed'].includes(String(advanced.state))) {
        if (this.open(context)) await this.retire(context, id);
        continue;
      }
      if (!this.options.local(context)) return;
      this.changed(await this.options.teams.claimReady(context, id));
    }
    this.cursors.set(context.scopeId, page.next_after as string | null);
  }
}
