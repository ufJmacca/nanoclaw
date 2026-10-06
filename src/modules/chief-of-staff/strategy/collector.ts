import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import type { WorkStore } from '../store/work.js';
import type { CalendarView } from '../calendar/view.js';
import type { CalendarTime } from '../calendar/normalization.js';
import type { Evidence } from '../knowledge/store.js';
import { scheduledMinutes } from './calendar-allocation.js';
import {
  missionProjection,
  readReviewMissions,
  type MissionProjection,
  type MissionReaders,
} from './mission-evidence.js';
import {
  validReviewCharterChange,
  validStrategyObservationChange,
  validReviewRequest,
  validStrategyDirectionChange,
  reviewId,
  reviewInteger,
  type ReviewRequest,
  type ReviewCharterDefinition,
} from '../contracts/strategy-protocol.js';
import {
  buildReviewSnapshot,
  type ReviewInput,
  type ReviewPrevious,
  type ReviewSnapshot,
  type ReviewRecord,
  type ReviewWork,
  type ReviewObservation,
  type ReviewDecision,
  type ReviewDirection,
} from './review.js';
export type ReviewCollectionIdentity = { review_id: string; revision: number; previous: ReviewPrevious | null };
type SourceVersion = { id: string; version: number; revision_id: string; digest: string; status: string };
export type ReviewVersionRefs = {
  format: 'cos-strategy-versions/v1';
  snapshot_digest: string;
  charter_digest: string;
  record_digest: string;
  work_digest: string;
  observation_digest: string;
  decision_digest: string;
  direction_digest: string;
  sources: SourceVersion[];
  calendar_digest: string;
  calendar_projection_digest: string;
  mission_projection_digest: string;
  mission_authorities: { single: string | null; team: string | null };
};
type CalendarLocation = {
  source_id: string;
  binding_id: string;
  calendar_id: string;
  time_zone: string;
  [key: string]: unknown;
};
const sorted = <T extends { id: string }>(rows: T[]): T[] => rows.sort((a, b) => a.id.localeCompare(b.id, 'en'));
const incomplete = (): Result => ({ status: 'unavailable', coverage: 'incomplete' });

/** Database collection is bounded and complete before any review analysis or artifact publication.
 * Prior summaries come only from verified private artifacts. Calendar and mission adapters run after capture releases this pool. */
export class ReviewCollector {
  constructor(
    readonly options: MissionReaders & {
      database: BoundedDatabase;
      knowledge: KnowledgeStore;
      work: WorkStore;
      calendarView?: Pick<CalendarView, 'readSelected'>;
      hooks?: { afterRecords?(): Promise<void>; afterCollection?(): Promise<void> };
    },
  ) {}

  private async charter(
    client: PoolClient,
    context: KnowledgeContext,
    version: number,
    historical = false,
  ): Promise<ReviewCharterDefinition | null> {
    const row = (
      await client.query(
        `SELECT c.definition,c.digest,r.body,r.digest AS revision_digest FROM cos.review_charters c
      JOIN cos.review_charter_revisions r ON r.scope_id=c.scope_id AND r.version=$5
      WHERE c.scope_id=$1 AND c.owner_id=$2 AND c.session_id=$3 AND c.agent_group_id=$4 AND (c.version=$5 OR $6) AND c.state='active'`,
        [context.scopeId, context.ownerId, context.sessionId, context.agentGroupId, version, historical],
      )
    ).rows[0];
    if (historical && row && validReviewCharterChange(row.body?.change)) {
      row.definition = row.body.change.definition;
      row.digest = digest(row.definition);
    }
    return row &&
      validReviewCharterChange(row.body?.change) &&
      row.body.change.expected_version + 1 === version &&
      digest(row.body) === row.revision_digest &&
      digest(row.definition) === row.digest &&
      digest(row.body.change.definition) === row.digest &&
      row.body.context?.scopeId === context.scopeId &&
      row.body.context?.ownerId === context.ownerId &&
      row.body.context?.sessionId === context.sessionId &&
      row.body.context?.agentGroupId === context.agentGroupId
      ? row.definition
      : null;
  }

  private async sources(
    client: PoolClient,
    context: KnowledgeContext,
    definition: ReviewCharterDefinition,
  ): Promise<SourceVersion[] | null> {
    if (!definition.source_ids.length) return [];
    const k = this.options.knowledge;
    if (
      !k.retrievalEnabled() ||
      !(await k.answers.dependencies.sourcesReadable(client, context, definition.source_ids))
    )
      return null;
    const rows = sorted(
      (
        await client.query(
          `SELECT s.id,s.version,s.current_revision_id AS revision_id,r.digest,s.status
      FROM cos.sources s JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.id=s.current_revision_id AND r.source_id=s.id
      JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id AND a.lifecycle='published'
      WHERE s.scope_id=$1 AND s.id=ANY($2::text[]) AND s.status IN ('current','stale') AND $3=ANY(s.processing_providers)
      AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)`,
          [context.scopeId, definition.source_ids, context.provider],
        )
      ).rows as SourceVersion[],
    );
    return rows.length === definition.source_ids.length ? rows : null;
  }

  private async records(
    client: PoolClient,
    context: KnowledgeContext,
    definition: ReviewCharterDefinition,
  ): Promise<ReviewRecord[]> {
    return sorted(
      (
        await client.query(
          "SELECT scope_id,id,version,kind,title,description,lifecycle FROM cos.records WHERE scope_id=$1 AND id=ANY($2::text[]) AND kind IN ('goal','project') AND lifecycle='active'",
          [context.scopeId, definition.initiative_ids],
        )
      ).rows,
    );
  }
  private async work(client: PoolClient, context: KnowledgeContext, definition: ReviewCharterDefinition) {
    return sorted(
      (
        await client.query(
          `SELECT scope_id,id::text,version,project_id,kind,state,title,evidence FROM cos.work_items
      WHERE scope_id=$1 AND owner_id=$2 AND project_id=ANY($3::text[]) ORDER BY id LIMIT 21`,
          [context.scopeId, context.ownerId, definition.initiative_ids],
        )
      ).rows,
    );
  }
  private async observations(
    client: PoolClient,
    context: KnowledgeContext,
    definition: ReviewCharterDefinition,
    version: number,
  ) {
    // Rank current references before applying the bounded host collection limit.
    // Ranking is not admission: capture still validates every selected body, digest and permission.
    return (
      await client.query(
        `SELECT o.id::text,o.body,o.digest,o.proposal_id FROM cos.strategy_observations o
      WHERE o.scope_id=$1 AND o.initiative_id=ANY($2::text[]) AND o.charter_version<=$3
      ORDER BY CASE WHEN jsonb_typeof(o.body->'evidence')='array' THEN NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(o.body->'evidence') ref WHERE NOT EXISTS (
          SELECT 1 FROM cos.evidence_refs e
          JOIN cos.sources s ON s.scope_id=e.scope_id AND s.id=e.source_id
          JOIN cos.source_revisions r ON r.scope_id=e.scope_id AND r.id=e.revision_id AND r.source_id=s.id
          JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id
          JOIN cos.chunks c ON c.scope_id=e.scope_id AND c.revision_id=e.revision_id AND c.start_line=e.start_line AND c.end_line=e.end_line
          WHERE e.scope_id=o.scope_id AND e.id::text=ref->>'evidence_id'
            AND e.source_id=ANY($4::text[]) AND e.session_id=$5 AND e.processing_provider=$6
            AND s.version=e.source_version AND s.current_revision_id=e.revision_id AND r.digest=e.revision_digest
            AND s.status IN ('current','stale') AND $6=ANY(s.processing_providers) AND a.lifecycle='published'
            AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)
        )
      ) ELSE true END DESC, o.charter_version DESC,o.created_at DESC,o.id LIMIT 21`,
        [
          context.scopeId,
          definition.initiative_ids,
          version,
          definition.source_ids,
          context.sessionId,
          context.provider,
        ],
      )
    ).rows;
  }
  private async decisions(client: PoolClient, context: KnowledgeContext, definition: ReviewCharterDefinition) {
    return (
      await client.query(
        `SELECT d.scope_id,d.proposal_id,d.option_id,d.review_id,d.review_revision,d.initiative_id,d.decision,d.direction,d.rationale,d.created_at AS decided_at,
        r.version AS direction_version, CASE WHEN r.version IS NULL THEN 'not_applied' WHEN h.version=r.version THEN 'applied' ELSE 'superseded' END AS application
      FROM cos.strategy_decisions d LEFT JOIN cos.strategy_direction_revisions r ON r.scope_id=d.scope_id AND r.proposal_id=d.proposal_id
      LEFT JOIN cos.strategy_directions h ON h.scope_id=d.scope_id AND h.initiative_id=d.initiative_id
      WHERE d.scope_id=$1 AND d.initiative_id=ANY($2::text[]) ORDER BY d.created_at,d.proposal_id LIMIT 21`,
        [context.scopeId, definition.initiative_ids],
      )
    ).rows.map((r) => ({ ...r, decided_at: (r.decided_at as Date).toISOString() })) as ReviewDecision[];
  }
  private async directions(client: PoolClient, context: KnowledgeContext, definition: ReviewCharterDefinition) {
    return (
      await client.query(
        `SELECT h.scope_id,h.initiative_id,h.version,h.direction,h.rationale,r.expected_record_version,r.proposal_id,
      d.review_id,d.review_revision,d.option_id,r.created_at AS applied_at,r.body->'superseded_version' AS superseded_version
      FROM cos.strategy_directions h JOIN cos.strategy_direction_revisions r ON r.scope_id=h.scope_id AND r.initiative_id=h.initiative_id AND r.version=h.version
      JOIN cos.strategy_decisions d ON d.scope_id=r.scope_id AND d.proposal_id=r.proposal_id
      WHERE h.scope_id=$1 AND h.initiative_id=ANY($2::text[]) ORDER BY h.initiative_id LIMIT 11`,
        [context.scopeId, definition.initiative_ids],
      )
    ).rows.map((r) => ({ ...r, applied_at: (r.applied_at as Date).toISOString() })) as ReviewDirection[];
  }
  /** Historical rationale inherits every source that influenced its original review. Approval cannot widen disclosure. */
  private async decisionAccess(
    client: PoolClient,
    context: KnowledgeContext,
    definition: ReviewCharterDefinition,
    sources: SourceVersion[],
    proposalId: string,
  ): Promise<boolean> {
    const row = (
      await client.query(
        `SELECT p.change,p.payload_hash,p.work_context,d.provenance,d.review_id,d.review_revision,d.option_id,d.initiative_id,d.direction,d.rationale,
      s.version_refs,s.artifact_id AS snapshot_artifact,r.artifact_id AS result_artifact
      FROM cos.strategy_decisions d JOIN cos.proposals p ON p.scope_id=d.scope_id AND p.id=d.proposal_id
      JOIN cos.strategy_review_snapshots s ON s.scope_id=d.scope_id AND s.id=d.review_id AND s.revision=d.review_revision
      JOIN cos.strategy_review_results r ON r.scope_id=s.scope_id AND r.review_id=s.id AND r.revision=s.revision
      JOIN cos.artifacts a ON a.scope_id=s.scope_id AND a.id=s.artifact_id AND a.lifecycle='published'
      JOIN cos.artifacts b ON b.scope_id=r.scope_id AND b.id=r.artifact_id AND b.lifecycle='published'
      WHERE d.scope_id=$1 AND d.proposal_id=$2 AND p.owner_id=$3 AND p.session_id=$4 AND s.owner_id=$3 AND s.session_id=$4
      AND s.processing_provider=$5 AND s.context->>'agentGroupId'=$6`,
        [context.scopeId, proposalId, context.ownerId, context.sessionId, context.provider, context.agentGroupId],
      )
    ).rows[0];
    if (
      !row ||
      !validStrategyDirectionChange(row.change) ||
      digest(row.change) !== row.payload_hash ||
      row.provenance?.change_digest !== row.payload_hash ||
      row.provenance?.owner_id !== context.ownerId ||
      row.change.request.review_id !== row.review_id ||
      row.change.request.revision !== row.review_revision ||
      row.change.option.id !== row.option_id ||
      row.change.option.initiative_id !== row.initiative_id ||
      row.change.option.direction !== row.direction ||
      row.change.request.reason !== row.rationale
    )
      return false;
    const refs = row.version_refs as ReviewVersionRefs;
    if (
      !Array.isArray(refs?.sources) ||
      refs.sources.length > 6 ||
      !refs.sources.every(
        (pin) =>
          definition.source_ids.includes(pin.id) &&
          sources.some(
            (current) =>
              current.id === pin.id &&
              current.version === pin.version &&
              current.revision_id === pin.revision_id &&
              current.digest === pin.digest,
          ),
      )
    )
      return false;
    const kinds = row.work_context?.direction_dependencies?.mission_kinds;
    if (
      !Array.isArray(kinds) ||
      kinds.length > 2 ||
      !kinds.every((kind: unknown) => kind === 'single' || kind === 'team')
    )
      return false;
    for (const kind of kinds as Array<'single' | 'team'>) {
      const current =
        kind === 'single'
          ? this.options.missionReviews?.reviewAuthorityDigest(context)
          : this.options.teamFinalReviews?.reviewAuthorityDigest(context);
      if (!current || refs.mission_authorities?.[kind] !== current) return false;
    }
    const calendar = await this.options.knowledge.answers.dependencies.calendarContext(client, context, true);
    if (calendar.status !== 'ok' || digest(calendar.notice) !== refs.calendar_digest) return false;
    const links = (
      await client.query(
        `SELECT l.evidence_id,e.source_id FROM cos.derivation_links l LEFT JOIN cos.evidence_refs e ON e.scope_id=l.scope_id AND e.id=l.evidence_id
      WHERE l.scope_id=$1 AND l.artifact_id=ANY($2::text[]) ORDER BY l.evidence_id LIMIT 1001`,
        [context.scopeId, [row.snapshot_artifact, row.result_artifact]],
      )
    ).rows;
    if (links.length > 1000 || links.some((link) => !definition.source_ids.includes(link.source_id))) return false;
    for (let n = 0; n < links.length; n += 10)
      if (
        !(await this.options.knowledge.answers.validateWorkEvidence(
          client,
          context,
          links.slice(n, n + 10).map((link) => ({ kind: 'source' as const, evidence_id: link.evidence_id })),
          true,
        ))
      )
        return false;
    return true;
  }
  private async missions(context: KnowledgeContext, captured: Result): Promise<Result> {
    if (captured.status !== 'ok') return captured;
    if (!(captured.mission_projection as MissionProjection[]).length) return captured;
    const snapshot = captured.snapshot as ReviewSnapshot,
      refs = captured.version_refs as ReviewVersionRefs;
    const result = await readReviewMissions(
      context,
      snapshot.charter.definition,
      refs.sources,
      captured.mission_projection as MissionProjection[],
      this.options,
    );
    if (result.status !== 'ok') return result;
    // Accepted result readers register every influencing chunk, including uncited influence. Keep those references
    // in the review artifact before a model can receive the full submitted claims and opposing perspectives.
    return this.options.knowledge.answers.dependencies.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(73101004)');
      if (!(await this.validateSnapshot(client, context, snapshot, refs))) return { status: 'denied' };
      const evidence = (
        await client.query(
          `SELECT scope_id,source_id,id AS evidence_id FROM cos.evidence_refs WHERE scope_id=$1 AND session_id=$2 AND processing_provider=$3
          AND source_id=ANY($4::text[]) AND (context_generation=$5 OR id=ANY($6::text[])) ORDER BY id LIMIT 101`,
          [
            context.scopeId,
            context.sessionId,
            context.provider,
            snapshot.charter.definition.source_ids,
            context.generation,
            snapshot.observations.flatMap((o) => o.evidence.map((e) => e.evidence_id)),
          ],
        )
      ).rows;
      if (evidence.length > 100) return incomplete();
      let enriched: ReviewSnapshot;
      try {
        enriched = buildReviewSnapshot({
          ...snapshot,
          records: snapshot.initiatives,
          missions: result.missions,
          mission_coverage: result.coverage,
          source_evidence: evidence,
          truncated: snapshot.truncated || result.truncated,
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('review_')) return incomplete();
        throw error;
      }
      return { ...captured, snapshot: enriched, version_refs: { ...refs, snapshot_digest: digest(enriched) } };
    }, true);
  }
  private async calendarProjection(
    client: PoolClient,
    context: KnowledgeContext,
    definition: ReviewCharterDefinition,
  ): Promise<CalendarLocation[]> {
    const rows = (
      await client.query(
        `SELECT o.source_id,o.binding_id::text,o.calendar_id,o.version,o.content_digest,o.event,o.last_snapshot,
        b.time_zone,s.current_snapshot,s.last_attempt,s.last_success_at,a.status AS attempt_status,g.coverage_window
       FROM cos.calendar_observations o JOIN cos.calendar_bindings b ON b.scope_id=o.scope_id AND b.id=o.binding_id
       JOIN cos.calendar_states s ON s.scope_id=o.scope_id AND s.binding_id=o.binding_id AND s.calendar_id=o.calendar_id
       LEFT JOIN cos.calendar_snapshots a ON a.scope_id=s.scope_id AND a.binding_id=s.binding_id AND a.id=s.last_attempt
       LEFT JOIN cos.calendar_snapshots g ON g.scope_id=s.scope_id AND g.binding_id=s.binding_id AND g.id=s.current_snapshot
       WHERE o.scope_id=$1 AND o.source_id=ANY($2::text[]) ORDER BY o.source_id LIMIT 7`,
        [context.scopeId, definition.source_ids],
      )
    ).rows;
    return rows.map(
      ({ event, ...row }) =>
        ({
          ...row,
          last_success_at: row.last_success_at instanceof Date ? row.last_success_at.toISOString() : null,
          event_digest: digest(event),
        }) as CalendarLocation,
    );
  }
  private async calendars(context: KnowledgeContext, captured: Result): Promise<Result> {
    if (captured.status !== 'ok') return captured;
    const locations = captured.calendar_locations as CalendarLocation[],
      snapshot = captured.snapshot as ReviewSnapshot,
      refs = captured.version_refs as ReviewVersionRefs;
    if (locations.length > 6 || new Set(locations.map((r) => r.source_id)).size !== locations.length)
      return incomplete();
    if (locations.length && !this.options.calendarView) return incomplete();
    const allocations: ReviewSnapshot['calendar_allocations'] = [];
    for (const location of locations) {
      const result = await this.options.calendarView!.readSelected(
        context,
        {
          binding_id: location.binding_id,
          calendar_id: location.calendar_id,
          time_min: snapshot.charter.definition.starts_at,
          time_max: snapshot.charter.definition.ends_at,
          limit: 5,
        },
        [location.source_id],
      );
      if (result.status !== 'ok') return result.status === 'denied' ? { status: 'denied' } : incomplete();
      if (result.coverage === 'unavailable' || result.next_offset != null) return incomplete();
      const coverage = snapshot.source_coverage.find((r) => r.source_id === location.source_id)!;
      if (result.coverage !== 'complete') {
        snapshot.truncated = true;
        coverage.state = 'incomplete';
      } else if (
        !location.last_success_at ||
        Date.parse(snapshot.as_of) - new Date(location.last_success_at as string | Date).getTime() > 3600000
      )
        coverage.state = 'stale';
      for (const item of result.items as Array<Record<string, unknown>>) {
        const evidence = item.evidence as Evidence;
        if (
          !evidence ||
          evidence.source_id !== location.source_id ||
          !snapshot.source_evidence.some(
            (e) => e.evidence_id === evidence.evidence_id && e.source_id === location.source_id,
          )
        )
          return incomplete();
        if (!item.start || !item.end || item.end_time_unspecified) {
          snapshot.truncated = true;
          coverage.state = 'incomplete';
          continue;
        }
        if (item.status === 'cancelled') continue;
        allocations.push({
          scope_id: context.scopeId,
          source_id: location.source_id,
          evidence_id: evidence.evidence_id,
          scheduled_minutes:
            item.transparent === true
              ? 0
              : scheduledMinutes(
                  item.start as CalendarTime,
                  item.end as CalendarTime,
                  location.time_zone,
                  snapshot.charter.definition.starts_at,
                  snapshot.charter.definition.ends_at,
                ),
        });
      }
    }
    const enriched = buildReviewSnapshot({
      ...snapshot,
      records: snapshot.initiatives,
      calendar_allocations: allocations,
    });
    const finalRefs = { ...refs, snapshot_digest: digest(enriched) };
    return this.options.knowledge.answers.dependencies.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(73101004)');
      return (await this.validateSnapshot(client, context, enriched, finalRefs))
        ? { status: 'ok', snapshot: enriched, version_refs: finalRefs }
        : { status: 'denied' };
    }, true);
  }

  async collect(
    context: KnowledgeContext,
    request: ReviewRequest,
    identity: ReviewCollectionIdentity,
  ): Promise<Result> {
    if (
      context.origin ||
      !validReviewRequest(request) ||
      !reviewId(identity.review_id) ||
      !reviewInteger(identity.revision)
    )
      return { status: 'denied' };
    if (
      request.previous_review_id === null
        ? identity.previous !== null || identity.revision !== 1
        : !identity.previous ||
          identity.previous.review_id !== request.previous_review_id ||
          identity.review_id !== request.previous_review_id ||
          identity.revision !== identity.previous.revision + 1 ||
          identity.previous.scope_id !== context.scopeId
    )
      return { status: 'denied' };
    try {
      const captured = await this.options.database.run(async (client) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const result = await this.capture(client, context, request, identity);
        await client.query('COMMIT');
        return result;
      }, true);
      if (captured.status === 'ok') await this.options.hooks?.afterCollection?.();
      const enriched = await this.missions(context, captured);
      const result = await this.calendars(context, enriched);
      return result.status === 'ok'
        ? result
        : { status: result.status, ...(result.status === 'denied' ? {} : { coverage: 'incomplete' }) };
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return incomplete();
      throw error;
    }
  }

  private async capture(
    client: PoolClient,
    context: KnowledgeContext,
    request: ReviewRequest,
    identity: ReviewCollectionIdentity,
  ): Promise<Result> {
    const { knowledge, work: workStore } = this.options,
      k = knowledge.answers.dependencies;
    if (!(await k.current(client, context))) return { status: 'denied' };
    const definition = await this.charter(client, context, request.charter_version);
    if (!definition) return { status: 'denied' };
    const asOf = ((await client.query('SELECT transaction_timestamp() AS now')).rows[0].now as Date).toISOString();
    if (Date.parse(asOf) < Date.parse(definition.starts_at) || Date.parse(asOf) > Date.parse(definition.ends_at))
      return { status: 'denied' };
    const calendar = await k.calendarContext(client, context, true);
    if (calendar.status !== 'ok') return { status: 'denied' };
    const sources = await this.sources(client, context, definition);
    if (!sources) return { status: 'denied' };
    const records = await this.records(client, context, definition);
    if (records.length !== definition.initiative_ids.length) return { status: 'denied' };
    await this.options.hooks?.afterRecords?.();
    const rawWork = await this.work(client, context, definition),
      rawObservations = await this.observations(client, context, definition, request.charter_version),
      rawDecisions = await this.decisions(client, context, definition),
      rawDirections = await this.directions(client, context, definition);
    const missionVersions = await missionProjection(client, context, definition);
    const calendarLocations = await this.calendarProjection(client, context, definition);
    let truncated = rawWork.length > 20 || rawObservations.length > 20 || rawDecisions.length > 20;
    const decisions: ReviewDecision[] = [],
      directions: ReviewDirection[] = [];
    const admission = new Map<string, boolean>();
    const admitted = async (id: string) => {
      if (!admission.has(id)) admission.set(id, await this.decisionAccess(client, context, definition, sources, id));
      return admission.get(id)!;
    };
    for (const row of rawDecisions.slice(0, 20)) {
      if (await admitted(row.proposal_id)) decisions.push(row);
      else truncated = true;
    }
    for (const row of rawDirections) {
      if (await admitted(row.proposal_id)) directions.push(row);
      else truncated = true;
    }
    const work: ReviewWork[] = [],
      observations: ReviewObservation[] = [];
    for (const row of rawWork.slice(0, 20)) {
      if (!(await workStore.evidenceAllowed(client, context, row.evidence, context, true))) {
        truncated = true;
        continue;
      }
      const { evidence: _evidence, ...item } = row;
      work.push(item as ReviewWork);
    }
    for (const row of rawObservations.slice(0, 20)) {
      if (!validStrategyObservationChange(row.body) || digest(row.body) !== row.digest) return incomplete();
      let selected = true;
      for (const ref of row.body.evidence)
        if (
          !(
            await client.query(
              'SELECT 1 FROM cos.evidence_refs WHERE scope_id=$1 AND id=$2 AND source_id=ANY($3::text[])',
              [context.scopeId, ref.evidence_id, definition.source_ids],
            )
          ).rowCount
        ) {
          selected = false;
          break;
        }
      if (!selected || !(await knowledge.answers.validateWorkEvidence(client, context, row.body.evidence, true))) {
        // Immutable history may outlive its source selection or revision. Withhold the entire
        // observation and disclose limited coverage; current context/source fences still apply.
        truncated = true;
        continue;
      }
      observations.push({ ...row.body, scope_id: context.scopeId, id: row.id });
    }
    // Even uncited source metadata influences this review; retain its version in the native context.
    for (const source of sources) {
      const inserted = await client.query(
        `INSERT INTO cos.evidence_refs(id,scope_id,source_id,revision_id,revision_digest,source_version,start_line,end_line,session_id,context_generation,processing_provider)
        SELECT $1,$2,$3,$4,$5,$6,c.start_line,c.end_line,$7,$8,$9 FROM cos.chunks c
        WHERE c.scope_id=$2 AND c.revision_id=$4 AND c.ordinal=0
        ON CONFLICT(scope_id,session_id,context_generation,revision_id,start_line,end_line,source_version) DO NOTHING`,
        [
          randomUUID(),
          context.scopeId,
          source.id,
          source.revision_id,
          source.digest,
          source.version,
          context.sessionId,
          context.generation,
          context.provider,
        ],
      );
      if (
        !inserted.rowCount &&
        !(
          await client.query(
            'SELECT 1 FROM cos.evidence_refs WHERE scope_id=$1 AND session_id=$2 AND context_generation=$3 AND source_id=$4 AND revision_id=$5 AND source_version=$6',
            [context.scopeId, context.sessionId, context.generation, source.id, source.revision_id, source.version],
          )
        ).rowCount
      )
        return incomplete();
    }
    const sourceEvidence = (
      await client.query(
        `SELECT scope_id,source_id,id AS evidence_id FROM cos.evidence_refs WHERE scope_id=$1 AND session_id=$2 AND processing_provider=$3
      AND source_id=ANY($4::text[]) AND (context_generation=$5 OR id=ANY($6::text[])) ORDER BY id LIMIT 101`,
        [
          context.scopeId,
          context.sessionId,
          context.provider,
          definition.source_ids,
          context.generation,
          observations.flatMap((o) => o.evidence.map((e) => e.evidence_id)),
        ],
      )
    ).rows;
    if (sourceEvidence.length > 100) return incomplete();
    const refs: Omit<ReviewVersionRefs, 'snapshot_digest'> = {
      format: 'cos-strategy-versions/v1',
      charter_digest: digest(definition),
      record_digest: digest(records),
      work_digest: digest(rawWork),
      observation_digest: digest(rawObservations),
      decision_digest: digest(rawDecisions),
      direction_digest: digest(rawDirections),
      sources,
      calendar_digest: digest(calendar.notice),
      calendar_projection_digest: digest(calendarLocations),
      mission_projection_digest: digest(missionVersions),
      mission_authorities: {
        single: missionVersions.some((m) => m.kind === 'single')
          ? (this.options.missionReviews?.reviewAuthorityDigest(context) ?? null)
          : null,
        team: missionVersions.some((m) => m.kind === 'team')
          ? (this.options.teamFinalReviews?.reviewAuthorityDigest(context) ?? null)
          : null,
      },
    };
    let snapshot: ReviewSnapshot;
    try {
      snapshot = buildReviewSnapshot({
        scope_id: context.scopeId,
        review_id: identity.review_id,
        revision: identity.revision,
        previous_review: identity.previous,
        as_of: asOf,
        charter: { version: request.charter_version, definition },
        records,
        work,
        observations,
        decisions,
        directions,
        source_coverage: sources.map((s) => ({
          scope_id: context.scopeId,
          source_id: s.id,
          version: s.version,
          state: s.status === 'stale' ? 'stale' : 'available',
        })),
        source_evidence: sourceEvidence,
        missions: [],
        calendar_allocations: [],
        truncated,
      } as ReviewInput);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('review_')) return incomplete();
      throw error;
    }
    if (!(await k.current(client, context))) return { status: 'denied' };
    return {
      status: 'ok',
      snapshot,
      version_refs: { ...refs, snapshot_digest: digest(snapshot) },
      calendar_locations: calendarLocations,
      mission_projection: missionVersions,
    };
  }

  /** Fresh publication/disclosure fence; no saved metadata can bypass current remote authority. */
  async validateSnapshot(
    client: PoolClient,
    context: KnowledgeContext,
    snapshot: ReviewSnapshot,
    value: unknown,
    historical = false,
  ): Promise<boolean> {
    const refs = value as ReviewVersionRefs | null;
    if (
      !refs ||
      refs.format !== 'cos-strategy-versions/v1' ||
      digest(snapshot) !== refs.snapshot_digest ||
      snapshot.scope_id !== context.scopeId ||
      context.origin ||
      !(await this.options.knowledge.answers.dependencies.current(client, context))
    )
      return false;
    const definition = await this.charter(client, context, snapshot.charter.version, historical);
    if (
      !definition ||
      digest(definition) !== refs.charter_digest ||
      digest(definition) !== digest(snapshot.charter.definition)
    )
      return false;
    const sources = await this.sources(client, context, definition);
    if (!sources || digest(sources) !== digest(refs.sources)) return false;
    for (const row of [...snapshot.decisions, ...snapshot.directions])
      if (!(await this.decisionAccess(client, context, definition, sources, row.proposal_id))) return false;
    for (const mission of snapshot.missions) {
      const kind = mission.mission_id.startsWith('team-') ? 'team' : 'single';
      const current =
        kind === 'single'
          ? this.options.missionReviews?.reviewAuthorityDigest(context)
          : this.options.teamFinalReviews?.reviewAuthorityDigest(context);
      if (!current || refs.mission_authorities?.[kind] !== current) return false;
    }
    if (historical) {
      // The already integrity-checked private artifact retains the old records and advice.
      // Source permission/version and native context authority still have to be current.
      const calendar = await this.options.knowledge.answers.dependencies.calendarContext(client, context, true);
      return calendar.status === 'ok' && digest(calendar.notice) === refs.calendar_digest;
    }
    if (digest(await this.calendarProjection(client, context, definition)) !== refs.calendar_projection_digest)
      return false;
    const records = await this.records(client, context, definition);
    if (digest(records) !== refs.record_digest || digest(records) !== digest(snapshot.initiatives)) return false;
    const work = await this.work(client, context, definition),
      observations = await this.observations(client, context, definition, snapshot.charter.version),
      decisions = await this.decisions(client, context, definition);
    if (
      digest(work) !== refs.work_digest ||
      digest(observations) !== refs.observation_digest ||
      digest(decisions) !== refs.decision_digest ||
      digest(await this.directions(client, context, definition)) !== refs.direction_digest ||
      digest(await missionProjection(client, context, definition)) !== refs.mission_projection_digest
    )
      return false;
    const calendar = await this.options.knowledge.answers.dependencies.calendarContext(client, context, true);
    return calendar.status === 'ok' && digest(calendar.notice) === refs.calendar_digest;
  }
}
