import type { PoolClient } from 'pg';
import { canonical, digest, type Context } from '../domain/contracts.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { TeamBrief, TeamBriefOutput } from '../contracts/team-brief.js';
import type { TeamProposalStore } from './team-proposal-store.js';
import type { TeamChildWorkOrder } from './team-work-order.js';
import { readVerifiedSubmission } from './submission-reader.js';
import { teamReviewPayload } from './team-review-payload.js';

export type CurrentTeamSnapshot = {
  row: { id: string; state: string; generation: number; version: number; provenance: Record<string, unknown> };
  order: NonNullable<Awaited<ReturnType<TeamProposalStore['captureChange']>>>;
};
export type TeamReviewSnapshot = {
  root: CurrentTeamSnapshot['row'];
  order: CurrentTeamSnapshot['order'];
  brief: TeamBrief;
  resultDigest: string;
  anchor: NonNullable<Awaited<ReturnType<typeof readVerifiedSubmission>>>['submission'] & { mission_id: string };
  checks: {
    status: 'review_required';
    outcome: 'answer' | 'partial' | 'blocked';
    criteria: Array<{ id: string; coverage: 'claimed' | 'missing' }>;
  };
};
/** Caller captures current root/source authority and locks the root before reading every published artifact. */
export async function buildTeamReviewSnapshot(
  client: PoolClient,
  context: Context,
  current: CurrentTeamSnapshot,
  knowledge: KnowledgeStore,
  orderFor: (missionId: string) => Promise<TeamChildWorkOrder | null>,
): Promise<TeamReviewSnapshot | null> {
  const steps = (
    await client.query(
      'SELECT * FROM cos.mission_team_steps WHERE scope_id=$1 AND team_id=$2 ORDER BY step_id FOR SHARE',
      [context.scopeId, current.row.id],
    )
  ).rows;
  if (
    steps.length !== current.order.body.request.steps.length ||
    steps.some((s) => !['submitted', 'failed'].includes(s.state))
  )
    return null;
  const outputs: TeamBriefOutput[] = [],
    superseded: TeamBriefOutput[] = [],
    verifiedSubmissions = [];
  let incomplete = false,
    blocked = false;
  const verify = async (stepId: string, missionId: string, submissionId: string) => {
    const order = await orderFor(missionId);
    const submission = (
      await client.query(
        'SELECT generation FROM cos.mission_result_submissions WHERE scope_id=$1 AND mission_id=$2 AND id=$3',
        [context.scopeId, missionId, submissionId],
      )
    ).rows[0];
    if (!order || order.body.team.stepId !== stepId || !submission) return null;
    return readVerifiedSubmission(
      client,
      knowledge.artifacts,
      context.scopeId,
      missionId,
      submissionId,
      submission.generation,
      order,
      true,
    );
  };
  for (const step of steps) {
    const definition = current.order.body.request.steps.find((s) => s.step_id === step.step_id)!;
    if (!definition || digest(definition) !== digest(step.definition)) return null;
    const role = { step_id: step.step_id, template_id: definition.template_id, required: definition.required };
    if (step.state === 'failed') {
      const reason = ['worker_failed', 'budget_exhausted', 'deadline', 'missing_coverage'].includes(
        step.provenance.failure_reason,
      )
        ? step.provenance.failure_reason
        : 'worker_failed';
      outputs.push({ ...role, state: 'failed', reason });
      incomplete = true;
      if (definition.required) {
        if (current.order.body.request.partial_policy === 'block') blocked = true;
      }
      continue;
    }
    const verified = await verify(step.step_id, step.child_mission_id, step.provenance.submission_id);
    if (
      !verified ||
      verified.submission.digest !== step.provenance.result_digest ||
      verified.submission.artifact_id !== step.provenance.artifact_id
    )
      return null;
    outputs.push({
      ...role,
      state: 'submitted',
      mission_id: step.child_mission_id,
      submission_id: verified.submission.id,
      artifact_id: verified.submission.artifact_id,
      result_digest: verified.submission.digest,
      result: verified.result,
    });
    verifiedSubmissions.push({ template: definition.template_id, submission: verified.submission });
    if (verified.result.format === 'cos-research-result/v1') {
      if (verified.result.outcome !== 'answer') incomplete = true;
      if (verified.result.outcome === 'blocked') blocked = true;
      if (
        definition.required &&
        verified.checks.status === 'review_required' &&
        verified.checks.criteria.some((c) => c.coverage === 'missing')
      )
        incomplete = true;
    }
  }
  const prior = (
    await client.query(
      `SELECT c.step_id,c.mission_id,r.id AS submission_id FROM cos.mission_team_children c
    JOIN cos.mission_team_steps s ON s.scope_id=c.scope_id AND s.team_id=c.team_id AND s.step_id=c.step_id
    JOIN cos.mission_result_submissions r ON r.scope_id=c.scope_id AND r.mission_id=c.mission_id
    WHERE c.scope_id=$1 AND c.team_id=$2 AND c.mission_id IS DISTINCT FROM s.child_mission_id ORDER BY c.step_id,c.revision,r.id`,
      [context.scopeId, current.row.id],
    )
  ).rows;
  for (const old of prior) {
    const definition = current.order.body.request.steps.find((s) => s.step_id === old.step_id)!;
    const verified = await verify(old.step_id, old.mission_id, old.submission_id);
    if (!definition || !verified) return null;
    superseded.push({
      step_id: old.step_id,
      template_id: definition.template_id,
      required: definition.required,
      state: 'submitted',
      mission_id: old.mission_id,
      submission_id: verified.submission.id,
      artifact_id: verified.submission.artifact_id,
      result_digest: verified.submission.digest,
      result: verified.result,
    });
  }
  const anchor =
    verifiedSubmissions.find((s) => s.template === 'team-reviewer') ??
    verifiedSubmissions.find((s) => s.template === 'team-writer') ??
    verifiedSubmissions[0];
  if (!anchor) return null;
  const limitations = outputs
    .filter((o) => o.state === 'failed')
    .map(
      (o) =>
        `Missing ${o.required ? 'required' : 'optional'} step ${o.step_id}: ${o.state === 'failed' ? o.reason : ''}.`,
    );
  if (incomplete) limitations.push('The graph has incomplete work; it cannot be presented as a comprehensive result.');
  const brief: TeamBrief = {
    format: 'cos-team-brief/v1',
    team_id: current.row.id,
    generation: current.row.generation,
    work_order_digest: current.order.digest,
    question: current.order.body.request.question,
    deadline_at: current.order.body.deadlineAt,
    partial_policy: current.order.body.request.partial_policy,
    acceptance_criteria: current.order.body.request.acceptance_criteria,
    review_status: 'specialist_opinions_advisory_coordinator_review_required',
    outputs,
    superseded_outputs: superseded,
    limitations,
  };
  if (Buffer.byteLength(canonical(brief), 'utf8') > current.order.body.request.limits.context_bytes) return null;
  const writer = outputs.find((s) => s.template_id === 'team-writer');
  const criteria = current.order.body.request.acceptance_criteria.map((c) => ({
    id: c.id,
    coverage:
      writer?.state === 'submitted' &&
      writer.result.format === 'cos-research-result/v1' &&
      writer.result.criteria.some((r) => r.id === c.id && r.claim_ids.length > 0)
        ? ('claimed' as const)
        : ('missing' as const),
  }));
  const snapshot: TeamReviewSnapshot = {
    root: current.row,
    order: current.order,
    brief,
    resultDigest: digest(brief),
    anchor: anchor.submission,
    checks: { status: 'review_required', outcome: blocked ? 'blocked' : incomplete ? 'partial' : 'answer', criteria },
  };
  return teamReviewPayload(snapshot) ? snapshot : null;
}
