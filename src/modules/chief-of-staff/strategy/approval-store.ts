import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Context, Result } from '../domain/contracts.js';
import { digest } from '../domain/contracts.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import {
  validReviewCharterChange,
  validReviewCharterDefinition,
  validStrategyObservationChange,
  type ReviewCharterChange,
  type ReviewCharterDefinition,
  type StrategyObservationChange,
} from '../contracts/strategy-protocol.js';

export type StrategyChange = ReviewCharterChange | StrategyObservationChange;
export const validStrategyChange = (value: unknown): value is StrategyChange =>
  validReviewCharterChange(value) || validStrategyObservationChange(value);
type ReviewDependencies = {
  records: Array<{ id: string; version: number }>;
  sources: Array<{ id: string; version: number; revision_id: string; digest: string }>;
};
export type StrategyProposalContext = KnowledgeContext & { review_dependencies: ReviewDependencies };

/** Runs inside the existing proposal transaction. Approval grants no execution or cadence. */
export class StrategyApprovalStore {
  constructor(readonly knowledge?: KnowledgeStore) {}

  /** Pin selected versions on the host, never accept a model-supplied dependency snapshot. */
  async prepareContext(
    client: PoolClient,
    context: Context,
    change: StrategyChange,
    retained?: KnowledgeContext,
  ): Promise<StrategyProposalContext | undefined> {
    if (!(await this.authority(client, context, retained))) return undefined;
    const definition = validReviewCharterChange(change)
      ? change.definition
      : await this.charter(client, context, change.charter_version, false);
    if (!definition || !(await this.selected(client, retained!, definition))) return undefined;
    const records = (
      await client.query(
        'SELECT id,version FROM cos.records WHERE scope_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE',
        [context.scopeId, definition.initiative_ids],
      )
    ).rows;
    const sources = (
      await client.query(
        `SELECT s.id,s.version,s.current_revision_id AS revision_id,r.digest
      FROM cos.sources s JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.id=s.current_revision_id AND r.source_id=s.id
      JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id AND a.lifecycle='published'
      WHERE s.scope_id=$1 AND s.id=ANY($2::text[]) ORDER BY s.id FOR SHARE OF s`,
        [context.scopeId, definition.source_ids],
      )
    ).rows;
    if (records.length !== definition.initiative_ids.length || sources.length !== definition.source_ids.length)
      return undefined;
    const saved = {
      scopeId: retained!.scopeId,
      ownerId: retained!.ownerId,
      sessionId: retained!.sessionId,
      agentGroupId: retained!.agentGroupId,
      ingressId: retained!.ingressId,
      generation: retained!.generation,
      provider: retained!.provider,
      review_dependencies: { records, sources },
    };
    return Buffer.byteLength(JSON.stringify(saved)) <= 4096 ? saved : undefined;
  }

  private async versionsCurrent(
    client: PoolClient,
    context: KnowledgeContext,
    definition: ReviewCharterDefinition,
    historical: boolean,
  ): Promise<boolean> {
    const refs = (context as Partial<StrategyProposalContext>).review_dependencies;
    if (
      !refs ||
      !Array.isArray(refs.records) ||
      !Array.isArray(refs.sources) ||
      digest(refs.records.map((r) => r.id).sort()) !== digest([...definition.initiative_ids].sort()) ||
      digest(refs.sources.map((s) => s.id).sort()) !== digest([...definition.source_ids].sort())
    )
      return false;
    if (!historical) {
      const records = (
        await client.query(
          'SELECT id,version FROM cos.records WHERE scope_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE',
          [context.scopeId, definition.initiative_ids],
        )
      ).rows;
      if (digest(records) !== digest(refs.records)) return false;
    }
    const sources = (
      await client.query(
        `SELECT s.id,s.version,s.current_revision_id AS revision_id,r.digest
      FROM cos.sources s JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.id=s.current_revision_id AND r.source_id=s.id
      JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id AND a.lifecycle='published'
      WHERE s.scope_id=$1 AND s.id=ANY($2::text[]) ORDER BY s.id FOR SHARE OF s`,
        [context.scopeId, definition.source_ids],
      )
    ).rows;
    return digest(sources) === digest(refs.sources);
  }

  private async authority(client: PoolClient, context: Context, retained?: KnowledgeContext): Promise<boolean> {
    return (
      !context.origin &&
      !!this.knowledge &&
      !!retained &&
      !retained.origin &&
      retained.scopeId === context.scopeId &&
      retained.ownerId === context.ownerId &&
      retained.sessionId === context.sessionId &&
      retained.agentGroupId === context.agentGroupId &&
      (await this.knowledge.answers.dependencies.current(client, retained))
    );
  }

  private async selected(
    client: PoolClient,
    context: KnowledgeContext,
    definition: ReviewCharterDefinition,
  ): Promise<boolean> {
    const records = await client.query(
      "SELECT id FROM cos.records WHERE scope_id=$1 AND id=ANY($2::text[]) AND kind IN ('goal','project') AND lifecycle='active' FOR SHARE",
      [context.scopeId, definition.initiative_ids],
    );
    if (records.rowCount !== definition.initiative_ids.length) return false;
    if (!definition.source_ids.length) return true;
    if (!this.knowledge!.retrievalEnabled()) return false;
    const sources = await client.query(
      `SELECT s.id FROM cos.sources s WHERE s.scope_id=$1 AND s.id=ANY($2::text[])
      AND s.status IN ('current','stale') AND s.current_revision_id IS NOT NULL AND $3=ANY(s.processing_providers)
      AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id) FOR SHARE`,
      [context.scopeId, definition.source_ids, context.provider],
    );
    return (
      sources.rowCount === definition.source_ids.length &&
      (await this.knowledge!.answers.dependencies.sourcesReadable(client, context, definition.source_ids))
    );
  }

  private async charter(
    client: PoolClient,
    context: Context,
    version: number,
    historical: boolean,
  ): Promise<ReviewCharterDefinition | null> {
    const row = (
      await client.query(
        `SELECT r.body,r.digest,c.version,c.state,c.definition,c.digest AS head_digest
        FROM cos.review_charter_revisions r JOIN cos.review_charters c ON c.scope_id=r.scope_id
        WHERE r.scope_id=$1 AND r.version=$2 AND c.owner_id=$3 AND c.session_id=$4 AND c.agent_group_id=$5 FOR SHARE OF c`,
        [context.scopeId, version, context.ownerId, context.sessionId, context.agentGroupId],
      )
    ).rows[0];
    if (
      !row ||
      !validReviewCharterChange(row.body?.change) ||
      digest(row.body) !== row.digest ||
      row.body.change.expected_version + 1 !== version ||
      row.body.context?.ownerId !== context.ownerId ||
      row.body.context?.sessionId !== context.sessionId ||
      row.body.context?.agentGroupId !== context.agentGroupId ||
      row.body.context?.scopeId !== context.scopeId ||
      (!historical &&
        (row.version !== version ||
          row.state !== 'active' ||
          digest(row.definition) !== row.head_digest ||
          digest(row.definition) !== digest(row.body.change.definition)))
    )
      return null;
    return row.body.change.definition;
  }

  async validateChange(
    client: PoolClient,
    context: Context,
    change: StrategyChange,
    retained?: KnowledgeContext,
    appliedProposal?: string,
  ): Promise<boolean> {
    if (!validStrategyChange(change) || !(await this.authority(client, context, retained))) return false;
    const historical = !!appliedProposal;
    if (validReviewCharterChange(change)) {
      if (!validReviewCharterDefinition(change.definition)) return false;
      if (historical) {
        const row = (
          await client.query(
            'SELECT body,digest FROM cos.review_charter_revisions WHERE scope_id=$1 AND proposal_id=$2',
            [context.scopeId, appliedProposal],
          )
        ).rows[0];
        if (!row || digest(row.body) !== row.digest || digest(row.body.change) !== digest(change)) return false;
      } else {
        const head = (
          await client.query('SELECT * FROM cos.review_charters WHERE scope_id=$1 FOR SHARE', [context.scopeId])
        ).rows[0];
        if (
          (head?.version ?? 0) !== change.expected_version ||
          (head &&
            (head.owner_id !== context.ownerId ||
              head.session_id !== context.sessionId ||
              head.agent_group_id !== context.agentGroupId ||
              !(await this.charter(client, context, head.version, false)))) ||
          !(await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [change.definition.ends_at]))
            .rows[0].valid
        )
          return false;
      }
      return (
        (await this.selected(client, retained!, change.definition)) &&
        this.versionsCurrent(client, retained!, change.definition, historical)
      );
    }
    if (historical) {
      const row = (
        await client.query('SELECT body,digest FROM cos.strategy_observations WHERE scope_id=$1 AND proposal_id=$2', [
          context.scopeId,
          appliedProposal,
        ])
      ).rows[0];
      if (!row || digest(row.body) !== row.digest || digest(row.body) !== digest(change)) return false;
    }
    const definition = await this.charter(client, context, change.charter_version, historical);
    if (!definition || !definition.initiative_ids.includes(change.initiative_id)) return false;
    const target =
      change.target.kind === 'outcome'
        ? definition.measures.some((m) => m.id === change.target.id && m.initiative_id === change.initiative_id)
        : change.target.kind === 'assumption'
          ? definition.assumptions.some((a) => a.id === change.target.id && a.initiative_id === change.initiative_id)
          : change.target.id === change.initiative_id;
    if (
      !target ||
      !(await this.selected(client, retained!, definition)) ||
      !(await this.versionsCurrent(client, retained!, definition, historical)) ||
      !(
        await client.query(
          'SELECT $1::timestamptz<=clock_timestamp() AND $1::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz AS valid',
          [change.observed_at, definition.starts_at, definition.ends_at],
        )
      ).rows[0].valid
    )
      return false;
    for (const ref of change.evidence)
      if (
        !(
          await client.query(
            'SELECT 1 FROM cos.evidence_refs WHERE scope_id=$1 AND id=$2 AND source_id=ANY($3::text[])',
            [context.scopeId, ref.evidence_id, definition.source_ids],
          )
        ).rowCount
      )
        return false;
    return this.knowledge!.answers.validateWorkEvidence(client, retained!, change.evidence);
  }

  async applyApproved(
    client: PoolClient,
    context: Context,
    proposal: { id: string; decision_ingress_id: string },
    change: StrategyChange,
    retained?: KnowledgeContext,
  ): Promise<Result> {
    if (!(await this.validateChange(client, context, change, retained))) return { status: 'conflict' };
    const provenance = {
      proposal_id: proposal.id,
      owner_id: context.ownerId,
      ingress_id: proposal.decision_ingress_id,
    };
    if (validReviewCharterChange(change)) {
      const version = change.expected_version + 1,
        body = { change, context: retained, provenance };
      // The parent scope lock serialises these changes. Both head and revision commit together.
      await client.query(
        `INSERT INTO cos.review_charters(scope_id,owner_id,session_id,agent_group_id,version,state,definition,digest,provenance)
        VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8)
        ON CONFLICT(scope_id) DO UPDATE SET version=EXCLUDED.version,state='active',definition=EXCLUDED.definition,
        digest=EXCLUDED.digest,provenance=EXCLUDED.provenance,updated_at=clock_timestamp()`,
        [
          context.scopeId,
          context.ownerId,
          context.sessionId,
          context.agentGroupId,
          version,
          JSON.stringify(change.definition),
          digest(change.definition),
          JSON.stringify(provenance),
        ],
      );
      await client.query(
        'INSERT INTO cos.review_charter_revisions(scope_id,version,body,digest,proposal_id) VALUES($1,$2,$3,$4,$5)',
        [context.scopeId, version, JSON.stringify(body), digest(body), proposal.id],
      );
      return { status: 'ok', record_id: 'review-charter-' + digest(context.scopeId) };
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO cos.strategy_observations(scope_id,id,initiative_id,charter_version,body,digest,context,proposal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        context.scopeId,
        id,
        change.initiative_id,
        change.charter_version,
        JSON.stringify(change),
        digest(change),
        JSON.stringify(retained),
        proposal.id,
      ],
    );
    return { status: 'ok', record_id: id };
  }
}
