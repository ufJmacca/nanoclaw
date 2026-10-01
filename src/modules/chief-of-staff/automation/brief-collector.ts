import { briefRefreshCoverage } from './brief-refresh-coverage.js';
import { Temporal } from '@js-temporal/polyfill';
import type { PoolClient } from 'pg';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import type { WorkStore } from '../store/work.js';
import type { KnowledgeStore, KnowledgeContext, Evidence } from '../knowledge/store.js';
import type { CalendarView } from '../calendar/view.js';
import { digest, type Result } from '../domain/contracts.js';
import {
  buildBriefSnapshot,
  renderBrief,
  type BriefWork,
  type BriefRecord,
  type BriefEvent,
  type BriefCoverage,
  type BriefSnapshot,
  type BriefCalendarCoverage,
} from './brief-snapshot.js';
const instant = (value: Date | string | null) => (value instanceof Date ? value.toISOString() : value);
const compactWork = (row: BriefWork): BriefWork => ({
  id: row.id,
  version: row.version,
  kind: row.kind,
  state: row.state,
  title: row.title,
  project_id: row.project_id,
  due: row.due,
  defer_until: instant(row.defer_until),
  evidence: row.evidence,
});
/** Trusted bounded collection. Account refresh happens separately, before the native context is admitted. */
export class BriefCollector {
  constructor(
    readonly options: {
      database: BoundedDatabase;
      work: WorkStore;
      knowledge: KnowledgeStore;
      calendarView?: CalendarView;
      clock?: () => Date;
    },
  ) {}
  private async transaction(operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    try {
      return await this.options.database.run(async (client) => {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      }, true);
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return { status: error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }
  /** Recheck every disclosed version and register source/calendar exposure in this native generation. */
  async validateSnapshot(
    client: PoolClient,
    context: KnowledgeContext,
    snapshot: BriefSnapshot,
    calendarDigest: string,
    historical = false,
  ): Promise<boolean> {
    const d = this.options,
      k = d.knowledge.answers.dependencies;
    if (!(await k.current(client, context))) return false;
    if (!historical && context.origin) {
      const refresh = await briefRefreshCoverage(client, context, snapshot.time_zone, true);
      if (
        !refresh ||
        snapshot.coverage.refresh !== refresh.refresh ||
        (refresh.truncated && !snapshot.coverage.truncated)
      )
        return false;
    }
    const calendar = await k.calendarContext(client, context, true);
    if (calendar.status !== 'ok' || digest(calendar.notice) !== calendarDigest) return false;
    for (const item of [...snapshot.commitments, ...snapshot.decisions]) {
      const row = historical
        ? (
            await client.query(
              'SELECT r.body FROM cos.work_revisions r JOIN cos.work_items w ON w.scope_id=r.scope_id AND w.id=r.work_id WHERE r.scope_id=$1 AND w.owner_id=$2 AND r.work_id=$3 AND r.version=$4',
              [context.scopeId, context.ownerId, item.id, item.version],
            )
          ).rows[0]?.body
        : (
            await client.query(
              'SELECT * FROM cos.work_items WHERE scope_id=$1 AND owner_id=$2 AND id=$3 AND version=$4',
              [context.scopeId, context.ownerId, item.id, item.version],
            )
          ).rows[0];
      if (
        !row ||
        digest(compactWork(row)) !== digest(item) ||
        !(await d.work.evidenceAllowed(client, context, item.evidence, context, true))
      )
        return false;
      if (
        item.project_id &&
        !(
          await client.query(
            "SELECT 1 FROM cos.records WHERE scope_id=$1 AND id=$2 AND kind='project' AND lifecycle='active'",
            [context.scopeId, item.project_id],
          )
        ).rowCount
      )
        return false;
    }
    for (const item of snapshot.attention) {
      if (item.reference.kind === 'record') {
        const row = (
          await client.query(
            "SELECT title FROM cos.records WHERE scope_id=$1 AND id=$2 AND version=$3 AND lifecycle='active'",
            [context.scopeId, item.reference.record_id, item.reference.version],
          )
        ).rows[0];
        if (!row || row.title !== item.title) return false;
      }
    }
    const refs = snapshot.events.map((e) => e.evidence);
    return !refs.length || (await d.work.evidenceAllowed(client, context, refs, context, true));
  }
  async collect(context: KnowledgeContext, timeZone: string): Promise<Result> {
    const d = this.options;
    let generatedAt: string, end: string;
    try {
      if (typeof timeZone !== 'string' || timeZone.length > 100 || /^[+-]/.test(timeZone)) return { status: 'denied' };
      new Intl.DateTimeFormat('en', { timeZone });
      generatedAt = (d.clock?.() ?? new Date()).toISOString();
      end = Temporal.Instant.from(generatedAt).toZonedDateTimeISO(timeZone).add({ days: 1 }).toInstant().toString();
    } catch (error) {
      if (error instanceof RangeError) return { status: 'denied' };
      throw error;
    }
    const before = await this.transaction(async (client) => {
      const k = d.knowledge.answers.dependencies;
      if (!(await k.current(client, context))) return { status: 'denied' };
      const refresh = await briefRefreshCoverage(client, context, timeZone);
      if (!refresh) return { status: 'denied' };
      const calendar = await k.calendarContext(client, context, true);
      if (calendar.status !== 'ok') return { status: 'denied' };
      const records = (
        await client.query(
          "SELECT id,kind,title,description,version,lifecycle FROM cos.records WHERE scope_id=$1 AND lifecycle='active' ORDER BY kind,id LIMIT 101",
          [context.scopeId],
        )
      ).rows as BriefRecord[];
      const candidates = (
        await client.query(
          `SELECT w.* FROM cos.work_items w WHERE scope_id=$1 AND owner_id=$2 AND
    (state IN ('confirmed','needed') OR (state='deferred' AND defer_until<=$3::timestamptz)) AND
    (project_id IS NULL OR EXISTS(SELECT 1 FROM cos.records r WHERE r.scope_id=w.scope_id AND r.id=w.project_id AND r.kind='project' AND r.lifecycle='active'))
    ORDER BY CASE WHEN due->>'kind'='date' THEN (((due->>'date')::date+1)::timestamp AT TIME ZONE (due->>'time_zone')) WHEN due->>'kind'='instant' THEN (due->>'at')::timestamptz ELSE NULL END NULLS LAST,kind,id LIMIT 101`,
          [context.scopeId, context.ownerId, generatedAt],
        )
      ).rows;
      const work: BriefWork[] = [];
      let withheld = 0;
      for (const row of candidates.slice(0, 100)) {
        if (!(await d.work.evidenceAllowed(client, context, row.evidence, context, true))) {
          withheld++;
          continue;
        }
        work.push(compactWork(row));
      }
      // Coverage metadata never imports source titles or bytes from an unapproved provider.
      const sources = d.knowledge.retrievalEnabled()
        ? (
            await client.query(
              "SELECT id,status FROM cos.sources WHERE scope_id=$1 AND $2=ANY(processing_providers) AND status IN ('current','stale') AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=cos.sources.scope_id AND t.source_id=cos.sources.id) ORDER BY id LIMIT 101",
              [context.scopeId, context.provider],
            )
          ).rows
        : [];
      const readable = [];
      for (const row of sources.slice(0, 100))
        if (await k.sourcesReadable(client, context, [row.id])) readable.push(row);
      const coverage: BriefCoverage = {
        knowledge: !d.knowledge.retrievalEnabled()
          ? 'unavailable'
          : readable.some((s) => s.status === 'stale')
            ? 'stale'
            : readable.length
              ? 'available'
              : 'not_connected',
        calendar: 'unavailable',
        refresh: refresh.refresh,
        truncated: refresh.truncated || records.length > 100 || candidates.length > 100 || sources.length > 100,
        withheld,
      };
      return { status: 'ok', records: records.slice(0, 100), work, coverage, calendar_digest: digest(calendar.notice) };
    });
    if (before.status !== 'ok') return before;
    const coverage = before.coverage as BriefCoverage,
      events: BriefEvent[] = [],
      calendarCoverage: BriefCalendarCoverage[] = [];
    if (d.calendarView) {
      const inventory = await d.calendarView.coverage(context);
      if (['denied', 'pending', 'conflict'].includes(inventory.status)) return { status: inventory.status };
      if (inventory.status === 'ok') {
        const calendars = inventory.items as Array<Record<string, unknown>>;
        coverage.calendar = inventory.coverage === 'not_connected' ? 'not_connected' : 'available';
        coverage.truncated ||= calendars.length > 5 || inventory.next_offset != null;
        for (const row of calendars.slice(0, 5)) {
          const result = await d.calendarView.read(context, {
            binding_id: String(row.binding_id),
            calendar_id: String(row.calendar_id),
            time_min: generatedAt,
            time_max: end,
            limit: 5,
          });
          if (['denied', 'pending', 'conflict'].includes(result.status)) return { status: result.status };
          calendarCoverage.push({
            binding_id: String(row.binding_id),
            calendar_id: String(row.calendar_id),
            time_zone: String(row.time_zone),
            snapshot_id: typeof result.snapshot_id === 'string' ? result.snapshot_id : null,
            coverage: String(result.coverage ?? 'unavailable'),
            warning: typeof result.warning === 'string' ? result.warning : null,
            last_success_at: instant((result.last_success_at as Date | string | null) ?? null),
            last_attempt_at: instant((result.last_attempt_at as Date | string | null) ?? null),
            window: (result.source_window as BriefCalendarCoverage['window']) ?? null,
          });
          if (result.status !== 'ok' || result.coverage === 'unavailable') {
            coverage.calendar = 'unavailable';
            continue;
          }
          if (result.coverage !== 'complete' && coverage.calendar !== 'unavailable') coverage.calendar = 'incomplete';
          const last =
            typeof result.last_success_at === 'string'
              ? Date.parse(result.last_success_at)
              : result.last_success_at instanceof Date
                ? result.last_success_at.getTime()
                : NaN;
          if (coverage.calendar === 'available' && (!Number.isFinite(last) || Date.parse(generatedAt) - last > 3600000))
            coverage.calendar = 'stale';
          coverage.truncated ||= result.next_offset != null;
          for (const item of (result.items as Array<Record<string, unknown>>).slice(0, 5)) {
            if (!item.start || !item.end || item.status === 'cancelled') continue;
            const evidence = item.evidence as Evidence;
            events.push({
              summary: String(item.summary),
              time_zone: String(row.time_zone),
              start: item.start as BriefEvent['start'],
              end: item.end as BriefEvent['end'],
              status: String(item.status),
              evidence: { kind: 'source', evidence_id: evidence.evidence_id },
              source_version: evidence.source_version,
              revision_id: evidence.revision_id,
              binding_id: String(row.binding_id),
              calendar_id: String(row.calendar_id),
              snapshot_id: String(result.snapshot_id),
            });
          }
        }
      }
    }
    const snapshot = buildBriefSnapshot({
      generatedAt,
      timeZone,
      records: before.records as BriefRecord[],
      work: before.work as BriefWork[],
      calendars: events,
      calendarCoverage,
      coverage,
    });
    const final = await this.transaction(async (client) => ({
      status: (await this.validateSnapshot(client, context, snapshot, String(before.calendar_digest)))
        ? 'ok'
        : 'denied',
    }));
    return final.status === 'ok'
      ? { status: 'ok', snapshot, text: renderBrief(snapshot), calendar_digest: before.calendar_digest }
      : final;
  }
}
