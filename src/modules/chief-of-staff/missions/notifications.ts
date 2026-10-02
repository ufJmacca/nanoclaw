import type { PoolClient } from 'pg';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import { validMissionResult, type MissionResult } from '../contracts/mission-result.js';
import type { MissionReviews } from './review-store.js';
import { validTeamBrief } from '../contracts/team-brief.js';
import { renderTeamNotification } from './team-notification-render.js';

const uuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export type MissionDeliveryReceipt =
  | { state: 'delivered'; platform_receipt: string }
  | { state: 'uncertain' }
  | { state: 'failed'; reason: 'admission_denied' };

/** Host-only, single-send consumption of the atomic review notification intent.
 * A delivering/uncertain command is never automatically retried, including after a restart. */
export class MissionNotifications {
  constructor(
    readonly database: BoundedDatabase,
    readonly reviews: Pick<MissionReviews, 'read'>,
    readonly route: 'single' | 'team' = 'single',
  ) {}
  private get kind() {
    return this.route === 'team' ? 'team_review_notification' : 'mission_review_notification';
  }
  private get prefix() {
    return this.route === 'team' ? 'team-review-' : 'mission-review-';
  }
  private get rootField() {
    return this.route === 'team' ? 'team_id' : 'mission_id';
  }
  private async transaction(operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    try {
      return await this.database.run(async (client) => {
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
  private async command(client: PoolClient, context: KnowledgeContext, reviewId: string, active = true) {
    if (context.origin || context.provider !== 'codex' || !uuid(context.generation) || !uuid(reviewId)) return null;
    const scope = (
      await client.query('SELECT status FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 FOR SHARE', [
        context.scopeId,
        context.ownerId,
        context.agentGroupId,
      ])
    ).rows[0];
    if (!scope || (active && scope.status !== 'active')) return null;
    const table = this.route === 'team' ? 'cos.mission_team_reviews' : 'cos.mission_reviews';
    const columns =
      this.route === 'team' ? 'r.team_id AS mission_id,r.submission_id AS result_id' : 'r.mission_id,r.result_id';
    const row = (
      await client.query(
        `SELECT o.*,${columns},r.provenance
      FROM cos.outbox o JOIN ${table} r ON r.scope_id=o.scope_id AND r.id=$2
      WHERE o.scope_id=$1 AND o.id=$3 AND o.kind=$4 FOR UPDATE OF o`,
        [context.scopeId, reviewId, this.prefix + reviewId, this.kind],
      )
    ).rows[0];
    if (
      !row ||
      row.payload.review_id !== reviewId ||
      row.payload[this.rootField] !== row.mission_id ||
      row.payload.submission_id !== row.result_id ||
      row.payload.result_digest !== row.provenance.result_digest ||
      row.payload.session_id !== context.sessionId ||
      row.provenance.session_id !== context.sessionId ||
      row.provenance.owner_id !== context.ownerId ||
      row.payload.context_generation !== context.generation ||
      row.provenance.context_generation !== context.generation
    )
      return null;
    return row;
  }
  async pending(context: KnowledgeContext): Promise<Result> {
    if (context.origin || context.provider !== 'codex' || !uuid(context.generation)) return { status: 'denied' };
    return this.transaction(async (client) => {
      const rows = (
        await client.query(
          `SELECT o.payload->>'review_id' AS review_id FROM cos.outbox o
        JOIN cos.scopes s ON s.id=o.scope_id AND s.owner_id=$2 AND s.agent_group_id=$3 AND s.status='active'
        WHERE o.scope_id=$1 AND o.kind=$6 AND o.delivered_at IS NULL AND o.attempts=0
        AND o.payload->>'session_id'=$4 AND o.payload->>'context_generation'=$5
        ORDER BY o.created_at,o.id LIMIT 20`,
          [context.scopeId, context.ownerId, context.agentGroupId, context.sessionId, context.generation, this.kind],
        )
      ).rows;
      return { status: 'ok', review_ids: rows.map((r) => r.review_id).filter((v) => typeof v === 'string' && uuid(v)) };
    });
  }
  async begin(context: KnowledgeContext, reviewId: string, attemptId: string): Promise<Result> {
    if (!uuid(attemptId)) return { status: 'denied' };
    return this.transaction(async (client) => {
      const row = await this.command(client, context, reviewId);
      if (!row || row.delivered_at || row.attempts !== 0 || row.payload.delivery) return { status: 'denied' };
      await client.query(
        `UPDATE cos.outbox SET attempts=attempts+1,payload=payload || jsonb_build_object('delivery',
        jsonb_build_object('state','delivering','attempt_id',$3::text,'started_at',clock_timestamp())) WHERE scope_id=$1 AND id=$2`,
        [context.scopeId, row.id, attemptId],
      );
      return { status: 'ok', notification_id: row.id };
    });
  }
  /** Permission and immutable artifact checks occur after all transport-admission awaits. */
  async read(context: KnowledgeContext, reviewId: string, attemptId: string): Promise<Result> {
    if (!uuid(attemptId)) return { status: 'denied' };
    const command = await this.transaction(async (client) => {
      const row = await this.command(client, context, reviewId);
      return row &&
        row.attempts === 1 &&
        !row.delivered_at &&
        row.payload.delivery?.state === 'delivering' &&
        row.payload.delivery.attempt_id === attemptId
        ? { status: 'ok', reference: row.payload }
        : { status: 'denied' };
    });
    if (command.status !== 'ok') return command;
    const ref = command.reference as Record<string, string>,
      rootId = ref[this.rootField];
    const result = await this.reviews.read(context, rootId, ref.submission_id);
    if (result.status !== 'ok') return result;
    const submission = result.submission as { id: string; digest: string },
      mission = result.mission as { id: string; state: string },
      review = result.review as { id: string; decision: string } | null;
    if (
      !review ||
      review.id !== reviewId ||
      submission?.id !== ref.submission_id ||
      submission.digest !== ref.result_digest ||
      mission?.id !== rootId ||
      { accept: 'completed', partial: 'partial', reject: 'blocked' }[review.decision] !== mission.state ||
      digest(result.result) !== ref.result_digest
    )
      return { status: 'denied' };
    if (this.route === 'team')
      return validTeamBrief(result.result)
        ? { status: 'ok', text: renderTeamNotification(rootId, mission.state, result.result) }
        : { status: 'denied' };
    return validMissionResult(result.result)
      ? { status: 'ok', text: renderMissionNotification(rootId, mission.state, result.result) }
      : { status: 'denied' };
  }
  /** Record an already-performed transport effect even after pause/revocation; this never grants a new send. */
  async finish(
    context: KnowledgeContext,
    reviewId: string,
    attemptId: string,
    receipt: MissionDeliveryReceipt,
  ): Promise<Result> {
    if (
      !uuid(attemptId) ||
      !receipt ||
      !['delivered', 'uncertain', 'failed'].includes(receipt.state) ||
      (receipt.state === 'delivered' && !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.platform_receipt)) ||
      (receipt.state === 'failed' && receipt.reason !== 'admission_denied')
    )
      return { status: 'denied' };
    const captured = structuredClone(receipt);
    return this.transaction(async (client) => {
      const row = await this.command(client, context, reviewId, false),
        delivery = row?.payload.delivery;
      if (!row || row.attempts !== 1 || delivery?.attempt_id !== attemptId) return { status: 'denied' };
      if (digest(delivery.receipt ?? null) === digest(captured)) return { status: 'ok', state: captured.state };
      if (delivery.state !== 'delivering' && !(delivery.state === 'uncertain' && captured.state === 'delivered'))
        return { status: 'denied' };
      await client.query(
        `UPDATE cos.outbox SET payload=payload || jsonb_build_object('delivery',$3::jsonb),
        delivered_at=CASE WHEN $4='delivered' THEN clock_timestamp() ELSE delivered_at END WHERE scope_id=$1 AND id=$2`,
        [
          context.scopeId,
          row.id,
          JSON.stringify({ ...delivery, state: captured.state, receipt: captured }),
          captured.state,
        ],
      );
      return { status: 'ok', state: captured.state };
    });
  }
}

/** Render the reviewed submission without letting source prose create mentions, links or fake headings. */
export function renderMissionNotification(missionId: string, state: string, result: MissionResult): string {
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(missionId) ||
    !['completed', 'partial', 'blocked'].includes(state) ||
    !validMissionResult(result)
  )
    throw Error('invalid_mission_notification');
  const quote = (text: string) => {
    const safe = text.replaceAll('@', '＠'),
      fence = '`'.repeat(Math.max(3, ...[...safe.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `${fence}\n${safe}\n${fence}`;
  };
  const lines = [
    `Research result — ${state === 'completed' ? 'accepted' : state} (coordinator review)`,
    `Mission: ${missionId}`,
    'The coordinator’s quality judgement is advisory; citations do not prove an inference.',
  ];
  if (state === 'blocked' && result.claims.length)
    lines.push('The following specialist claims were not accepted as a completed answer.');
  for (const claim of result.claims) {
    lines.push(
      `${claim.kind === 'quote' ? 'Source quotation' : 'Specialist inference'} (${claim.id})`,
      quote(claim.text),
    );
    lines.push(
      ...claim.citations.map(
        (c) => `Source ${c.source_id}, revision ${c.revision_id}, chunk ${c.ordinal}, L${c.start_line}–L${c.end_line}.`,
      ),
    );
  }
  if (result.limitations.length) lines.push('Limitations', ...result.limitations.map(quote));
  const text = lines.join('\n\n');
  if ([...text].length > 16383) throw Error('mission_notification_too_large');
  return text;
}
