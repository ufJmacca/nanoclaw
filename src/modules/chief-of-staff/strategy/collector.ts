import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import type { WorkStore } from '../store/work.js';
import {
  validReviewCharterChange,
  validStrategyObservationChange,
  validReviewRequest,
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
  sources: SourceVersion[];
  calendar_digest: string;
};
const sorted = <T extends { id: string }>(rows: T[]): T[] => rows.sort((a, b) => a.id.localeCompare(b.id, 'en'));
const incomplete = (): Result => ({ status: 'unavailable', coverage: 'incomplete' });

/** Database collection is bounded and complete before any review analysis or artifact publication.
 * Prior summaries come only from verified private artifacts. Mission/calendar adapters remain closed. */
export class ReviewCollector {
  constructor(
    readonly options: {
      database: BoundedDatabase;
      knowledge: KnowledgeStore;
      work: WorkStore;
      hooks?: { afterRecords?(): Promise<void> };
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
    return sorted(
      (
        await client.query(
          `SELECT id::text,body,digest,proposal_id FROM cos.strategy_observations
      WHERE scope_id=$1 AND initiative_id=ANY($2::text[]) AND charter_version<=$3 ORDER BY id LIMIT 21`,
          [context.scopeId, definition.initiative_ids, version],
        )
      ).rows,
    );
  }
  private async decisions(client: PoolClient, context: KnowledgeContext, definition: ReviewCharterDefinition) {
    return (
      await client.query(
        `SELECT scope_id,review_id,review_revision,initiative_id,decision,direction,rationale,created_at AS decided_at
      FROM cos.strategy_decisions WHERE scope_id=$1 AND initiative_id=ANY($2::text[]) ORDER BY created_at,proposal_id LIMIT 21`,
        [context.scopeId, definition.initiative_ids],
      )
    ).rows.map((r) => ({ ...r, decided_at: (r.decided_at as Date).toISOString() }));
  }
  private async unsupportedEvidence(
    client: PoolClient,
    context: KnowledgeContext,
    definition: ReviewCharterDefinition,
  ): Promise<boolean> {
    // Do not claim a complete review while required adapters have not been implemented.
    const row = (
      await client.query(
        `SELECT EXISTS(SELECT 1 FROM cos.mission_result_submissions s JOIN cos.mission_work_orders w
        ON w.scope_id=s.scope_id AND w.id=s.mission_id WHERE s.scope_id=$1 AND
        (w.body->'request'->>'project_id'=ANY($2::text[]) OR w.body->'request'->>'goal_id'=ANY($2::text[])))
      OR EXISTS(SELECT 1 FROM cos.mission_team_work_orders w WHERE w.scope_id=$1 AND
        (w.body->'request'->>'project_id'=ANY($2::text[]) OR w.body->'request'->>'goal_id'=ANY($2::text[])))
      OR EXISTS(SELECT 1 FROM cos.calendar_observations c WHERE c.scope_id=$1 AND c.source_id=ANY($3::text[])) AS required`,
        [context.scopeId, definition.initiative_ids, definition.source_ids],
      )
    ).rows[0];
    return row.required;
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
      return await this.options.database.run(async (client) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const result = await this.capture(client, context, request, identity);
        await client.query('COMMIT');
        return result;
      }, true);
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
      rawDecisions = await this.decisions(client, context, definition);
    if (await this.unsupportedEvidence(client, context, definition)) return incomplete();
    let truncated = rawWork.length > 20 || rawObservations.length > 20 || rawDecisions.length > 20;
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
      for (const ref of row.body.evidence)
        if (
          !(
            await client.query(
              'SELECT 1 FROM cos.evidence_refs WHERE scope_id=$1 AND id=$2 AND source_id=ANY($3::text[])',
              [context.scopeId, ref.evidence_id, definition.source_ids],
            )
          ).rowCount
        )
          return incomplete();
      if (!(await knowledge.answers.validateWorkEvidence(client, context, row.body.evidence, true)))
        return { status: 'denied' };
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
      sources,
      calendar_digest: digest(calendar.notice),
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
        decisions: rawDecisions.slice(0, 20),
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
    return { status: 'ok', snapshot, version_refs: { ...refs, snapshot_digest: digest(snapshot) } };
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
    if (historical) {
      // The already integrity-checked private artifact retains the old records and advice.
      // Source permission/version and native context authority still have to be current.
      const calendar = await this.options.knowledge.answers.dependencies.calendarContext(client, context, true);
      return calendar.status === 'ok' && digest(calendar.notice) === refs.calendar_digest;
    }
    const records = await this.records(client, context, definition);
    if (digest(records) !== refs.record_digest || digest(records) !== digest(snapshot.initiatives)) return false;
    const work = await this.work(client, context, definition),
      observations = await this.observations(client, context, definition, snapshot.charter.version),
      decisions = await this.decisions(client, context, definition);
    if (
      digest(work) !== refs.work_digest ||
      digest(observations) !== refs.observation_digest ||
      digest(decisions) !== refs.decision_digest ||
      (await this.unsupportedEvidence(client, context, definition))
    )
      return false;
    const calendar = await this.options.knowledge.answers.dependencies.calendarContext(client, context, true);
    return calendar.status === 'ok' && digest(calendar.notice) === refs.calendar_digest;
  }
}
