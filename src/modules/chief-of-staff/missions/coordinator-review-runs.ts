import type { MissionReviewRuns } from './review-runs.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { Result } from '../domain/contracts.js';

type ReviewRuns = Pick<
  MissionReviewRuns,
  'pending' | 'claim' | 'inspect' | 'authorize' | 'renew' | 'reserve' | 'retire'
>;
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

/** One native main-review dispatcher and context for both routes. Backend authority is never interchangeable. */
export class CoordinatorReviewRuns {
  private teamFirst = false;
  constructor(
    readonly singles: ReviewRuns,
    readonly teams?: ReviewRuns,
  ) {}
  private backend(missionId: string): ReviewRuns | undefined {
    if (!id(missionId)) return undefined;
    return missionId.startsWith('team-') ? this.teams : this.singles;
  }
  async pending(context: KnowledgeContext): Promise<Result> {
    if (!this.teams) return this.singles.pending(context);
    const results = await Promise.all([this.singles.pending(context), this.teams.pending(context)]);
    for (const result of results) if (result.status !== 'ok') return { status: result.status };
    const lists = results.map((r, kind) => {
      if (!Array.isArray(r.items) || r.items.length > 20) return null;
      const items: Array<{ mission_id: string; submission_id: string }> = [];
      for (const v of r.items) {
        if (!v || !id(v.mission_id) || !uuid(v.submission_id) || v.mission_id.startsWith('team-') !== Boolean(kind))
          return null;
        items.push({ mission_id: v.mission_id, submission_id: v.submission_id });
      }
      return items;
    });
    if (lists.some((v) => v === null)) return { status: 'denied' };
    const first = this.teamFirst ? 1 : 0;
    this.teamFirst = !this.teamFirst;
    const items = [];
    for (let i = 0; i < 20; i++) for (const k of [first, 1 - first]) if (lists[k]?.[i]) items.push(lists[k]![i]);
    return { status: 'ok', items };
  }
  async claim(...args: Parameters<ReviewRuns['claim']>): Promise<Result> {
    return this.backend(args[1])?.claim(...args) ?? { status: 'denied' };
  }
  async inspect(...args: Parameters<ReviewRuns['inspect']>): Promise<Result> {
    return this.backend(args[1])?.inspect(...args) ?? { status: 'denied' };
  }
  async authorize(...args: Parameters<ReviewRuns['authorize']>): Promise<Result> {
    return this.backend(args[1])?.authorize(...args) ?? { status: 'denied' };
  }
  async renew(...args: Parameters<ReviewRuns['renew']>): Promise<Result> {
    return this.backend(args[1])?.renew(...args) ?? { status: 'denied' };
  }
  async reserve(...args: Parameters<ReviewRuns['reserve']>): Promise<Result> {
    return this.backend(args[1])?.reserve(...args) ?? { status: 'denied' };
  }
  async retire(...args: Parameters<ReviewRuns['retire']>): Promise<Result> {
    return this.backend(args[1])?.retire(...args) ?? { status: 'denied' };
  }
}
