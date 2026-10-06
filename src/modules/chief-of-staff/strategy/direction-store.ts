import type { PoolClient } from 'pg';
import { digest, type Context, type Result } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import {
  validDirectionRequest,
  validStrategyDirectionChange,
  reviewInstant,
  type DirectionRequest,
  type StrategyDirectionChange,
} from '../contracts/strategy-protocol.js';
import type { StrategyProposalContext } from './approval-store.js';
import type { ReviewArtifacts } from './artifacts.js';
import type { ReviewArtifact } from './review.js';
import type { ReviewVersionRefs } from './collector.js';

type Metadata = {
  snapshot_digest: string;
  draft_digest: string;
  result_artifact_id: string;
  result_artifact_digest: string;
  snapshot_artifact_id: string;
  snapshot_artifact_digest: string;
  charter_version: number;
  version_refs: ReviewVersionRefs;
};
export type DirectionProposalContext = StrategyProposalContext & {
  direction_dependencies: {
    snapshot_artifact_id: string;
    snapshot_artifact_digest: string;
    forecast_until: string;
    mission_kinds: Array<'single' | 'team'>;
  };
};
export type PreparedDirection = { change: StrategyDirectionChange; context: DirectionProposalContext };

/** Owner choices use the existing exact approval/outbox path. This store never cancels or dispatches work. */
export class DirectionStore {
  constructor(readonly reviews: ReviewArtifacts) {}
  private get knowledge() {
    return this.reviews.collector.options.knowledge;
  }
  private async metadata(
    client: PoolClient,
    context: KnowledgeContext,
    request: DirectionRequest,
  ): Promise<Metadata | null> {
    const row = (
      await client.query(
        `SELECT s.snapshot_digest,s.charter_version,s.version_refs,s.artifact_id AS snapshot_artifact_id,a.digest AS snapshot_artifact_digest,
        r.draft_digest,r.artifact_id AS result_artifact_id,b.digest AS result_artifact_digest
      FROM cos.strategy_review_snapshots s JOIN cos.strategy_review_results r ON r.scope_id=s.scope_id AND r.review_id=s.id AND r.revision=s.revision
      JOIN cos.artifacts a ON a.scope_id=s.scope_id AND a.id=s.artifact_id AND a.lifecycle='published' AND a.kind='summary'
      JOIN cos.artifacts b ON b.scope_id=r.scope_id AND b.id=r.artifact_id AND b.lifecycle='published' AND b.kind='summary'
      WHERE s.scope_id=$1 AND s.id=$2 AND s.revision=$3 AND s.owner_id=$4 AND s.session_id=$5 AND s.processing_provider=$6
        AND s.context->>'agentGroupId'=$7 AND a.provenance->>'format'='cos-strategy-snapshot/v1' AND b.provenance->>'format'='cos-strategy-review/v1'`,
        [
          context.scopeId,
          request.review_id,
          request.revision,
          context.ownerId,
          context.sessionId,
          context.provider,
          context.agentGroupId,
        ],
      )
    ).rows[0];
    return row ?? null;
  }
  /** Both integrity-checked private artifacts are read outside the proposal transaction. */
  async prepare(context: KnowledgeContext, request: DirectionRequest): Promise<Result> {
    if (context.origin || !validDirectionRequest(request)) return { status: 'denied' };
    const pinned = structuredClone(request);
    const first = await this.knowledge.answers.dependencies.transaction(async (client) => {
      const metadata = await this.metadata(client, context, pinned);
      return metadata ? { status: 'ok', metadata } : { status: 'denied' };
    });
    if (first.status !== 'ok') return first;
    const metadata = first.metadata as Metadata;
    const read = await this.reviews.readHistory(context, pinned.review_id, pinned.revision);
    if (read.status !== 'ok') return read;
    const artifact = read.review as ReviewArtifact,
      snapshot = artifact.snapshot;
    const option = artifact.draft.options.find((o) => o.id === pinned.option_id);
    const record = snapshot.initiatives.find((r) => r.id === option?.initiative_id);
    if (
      !option ||
      !record ||
      record.version !== pinned.expected_record_version ||
      digest(snapshot) !== metadata.snapshot_digest ||
      digest(artifact.draft) !== metadata.draft_digest ||
      snapshot.charter.version !== metadata.charter_version
    )
      return { status: 'denied' };
    const change: StrategyDirectionChange = {
      kind: 'strategy_direction',
      request: pinned,
      option: structuredClone(option),
      charter_version: metadata.charter_version,
      snapshot_digest: metadata.snapshot_digest,
      draft_digest: metadata.draft_digest,
      result_artifact_id: metadata.result_artifact_id,
      result_artifact_digest: metadata.result_artifact_digest,
    };
    const retained: DirectionProposalContext = {
      ...context,
      review_dependencies: {
        records: snapshot.initiatives
          .map((r) => ({ id: r.id, version: r.version }))
          .sort((a, b) => a.id.localeCompare(b.id, 'en')),
        sources: metadata.version_refs.sources.map(({ status: _status, ...source }) => source),
      },
      direction_dependencies: {
        snapshot_artifact_id: metadata.snapshot_artifact_id,
        snapshot_artifact_digest: metadata.snapshot_artifact_digest,
        forecast_until: artifact.draft.forecast_until,
        mission_kinds: [
          ...new Set(
            snapshot.missions.map((m) => (m.mission_id.startsWith('team-') ? ('team' as const) : ('single' as const))),
          ),
        ],
      },
    };
    if (Buffer.byteLength(JSON.stringify(retained)) > 4096) return { status: 'denied' };
    const fresh = await this.knowledge.answers.dependencies.transaction(async (client) => {
      const current = await this.metadata(client, context, pinned);
      return current &&
        digest(current) === digest(metadata) &&
        (await this.validateAccess(client, context, change, retained))
        ? { status: 'ok', prepared: { change, context: retained } }
        : { status: 'denied' };
    }, true);
    return fresh;
  }
  /** Fresh metadata/source/native authority, with no private file or model wait under this lease. */
  async validateAccess(
    client: PoolClient,
    context: Context,
    change: StrategyDirectionChange,
    retained?: KnowledgeContext,
    historical = false,
  ): Promise<boolean> {
    const saved = retained as DirectionProposalContext | undefined;
    if (
      !validStrategyDirectionChange(change) ||
      !saved?.direction_dependencies ||
      !reviewInstant(saved.direction_dependencies.forecast_until) ||
      !Array.isArray(saved.direction_dependencies.mission_kinds) ||
      saved.direction_dependencies.mission_kinds.length > 2 ||
      !saved.direction_dependencies.mission_kinds.every((kind) => ['single', 'team'].includes(kind)) ||
      context.origin ||
      saved.origin ||
      context.scopeId !== saved.scopeId ||
      context.ownerId !== saved.ownerId ||
      context.sessionId !== saved.sessionId ||
      context.agentGroupId !== saved.agentGroupId ||
      !(await this.knowledge.answers.dependencies.current(client, saved))
    )
      return false;
    const metadata = await this.metadata(client, saved, change.request);
    if (
      !metadata ||
      metadata.snapshot_digest !== change.snapshot_digest ||
      metadata.draft_digest !== change.draft_digest ||
      metadata.result_artifact_id !== change.result_artifact_id ||
      metadata.result_artifact_digest !== change.result_artifact_digest ||
      metadata.charter_version !== change.charter_version ||
      metadata.snapshot_artifact_id !== saved.direction_dependencies.snapshot_artifact_id ||
      metadata.snapshot_artifact_digest !== saved.direction_dependencies.snapshot_artifact_digest ||
      digest(metadata.version_refs.sources.map(({ status: _status, ...source }) => source)) !==
        digest(saved.review_dependencies?.sources)
    )
      return false;
    if (
      !historical &&
      !(
        await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [
          saved.direction_dependencies.forecast_until,
        ])
      ).rows[0].valid
    )
      return false;
    const calendar = await this.knowledge.answers.dependencies.calendarContext(client, saved, true);
    if (calendar.status !== 'ok' || digest(calendar.notice) !== metadata.version_refs.calendar_digest) return false;
    for (const kind of saved.direction_dependencies.mission_kinds) {
      const readers = this.reviews.collector.options;
      const current =
        kind === 'single'
          ? readers.missionReviews?.reviewAuthorityDigest(saved)
          : readers.teamFinalReviews?.reviewAuthorityDigest(saved);
      if (!current || metadata.version_refs.mission_authorities?.[kind] !== current) return false;
    }
    const rows = (
      await client.query(
        'SELECT evidence_id FROM cos.derivation_links WHERE scope_id=$1 AND artifact_id=ANY($2::text[]) ORDER BY evidence_id LIMIT 1001',
        [context.scopeId, [metadata.snapshot_artifact_id, metadata.result_artifact_id]],
      )
    ).rows;
    if (rows.length > 1000) return false;
    for (let n = 0; n < rows.length; n += 10)
      if (
        !(await this.knowledge.answers.validateWorkEvidence(
          client,
          saved,
          rows.slice(n, n + 10).map((row) => ({ kind: 'source' as const, evidence_id: row.evidence_id })),
          true,
        ))
      )
        return false;
    return true;
  }
  async versionsCurrent(client: PoolClient, context: Context, change: StrategyDirectionChange): Promise<boolean> {
    const record = (
      await client.query(
        "SELECT version FROM cos.records WHERE scope_id=$1 AND id=$2 AND kind IN ('goal','project') AND lifecycle='active' FOR SHARE",
        [context.scopeId, change.option.initiative_id],
      )
    ).rows[0];
    const direction = (
      await client.query(
        'SELECT version FROM cos.strategy_directions WHERE scope_id=$1 AND initiative_id=$2 FOR SHARE',
        [context.scopeId, change.option.initiative_id],
      )
    ).rows[0];
    return (
      record?.version === change.request.expected_record_version &&
      (direction?.version ?? 0) === change.request.expected_direction_version
    );
  }
  async appliedCurrent(
    client: PoolClient,
    context: Context,
    change: StrategyDirectionChange,
    proposalId: string,
  ): Promise<boolean> {
    const row = (
      await client.query(
        'SELECT body,expected_record_version FROM cos.strategy_direction_revisions WHERE scope_id=$1 AND proposal_id=$2 AND initiative_id=$3',
        [context.scopeId, proposalId, change.option.initiative_id],
      )
    ).rows[0];
    return (
      !!row &&
      row.expected_record_version === change.request.expected_record_version &&
      digest(row.body.change) === digest(change) &&
      row.body.provenance?.owner_id === context.ownerId
    );
  }
  async recordDecision(
    client: PoolClient,
    context: Context,
    proposalId: string,
    change: StrategyDirectionChange,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    await client.query(
      `INSERT INTO cos.strategy_decisions(scope_id,proposal_id,review_id,review_revision,initiative_id,option_id,decision,direction,rationale,provenance)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        context.scopeId,
        proposalId,
        change.request.review_id,
        change.request.revision,
        change.option.initiative_id,
        change.option.id,
        decision === 'approve' ? 'approved' : 'rejected',
        change.option.direction,
        change.request.reason,
        JSON.stringify({
          owner_id: context.ownerId,
          session_id: context.sessionId,
          ingress_id: context.ingressId,
          change_digest: digest(change),
          expected_record_version: change.request.expected_record_version,
          expected_direction_version: change.request.expected_direction_version,
          approval_is_not_outcome_evidence: true,
        }),
      ],
    );
  }
  async applyApproved(
    client: PoolClient,
    context: Context,
    proposal: { id: string; decision_ingress_id: string },
    change: StrategyDirectionChange,
  ): Promise<Result> {
    const decision = (
      await client.query('SELECT * FROM cos.strategy_decisions WHERE scope_id=$1 AND proposal_id=$2', [
        context.scopeId,
        proposal.id,
      ])
    ).rows[0];
    if (
      !decision ||
      decision.decision !== 'approved' ||
      decision.provenance?.ingress_id !== proposal.decision_ingress_id ||
      decision.provenance?.change_digest !== digest(change) ||
      !(await this.versionsCurrent(client, context, change))
    )
      return { status: 'conflict' };
    const version = change.request.expected_direction_version + 1;
    const provenance = {
      proposal_id: proposal.id,
      owner_id: context.ownerId,
      ingress_id: proposal.decision_ingress_id,
    };
    await client.query(
      `INSERT INTO cos.strategy_direction_revisions(scope_id,initiative_id,version,expected_record_version,proposal_id,body)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [
        context.scopeId,
        change.option.initiative_id,
        version,
        change.request.expected_record_version,
        proposal.id,
        JSON.stringify({ change, provenance, superseded_version: change.request.expected_direction_version || null }),
      ],
    );
    await client.query(
      `INSERT INTO cos.strategy_directions(scope_id,initiative_id,version,direction,rationale,provenance)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(scope_id,initiative_id) DO UPDATE SET version=EXCLUDED.version,direction=EXCLUDED.direction,
      rationale=EXCLUDED.rationale,provenance=EXCLUDED.provenance,updated_at=clock_timestamp()`,
      [
        context.scopeId,
        change.option.initiative_id,
        version,
        change.option.direction,
        change.request.reason,
        JSON.stringify(provenance),
      ],
    );
    return { status: 'ok', record_id: change.option.initiative_id };
  }
}
