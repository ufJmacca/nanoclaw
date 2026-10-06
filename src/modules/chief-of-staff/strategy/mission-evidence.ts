import type { PoolClient } from 'pg';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MissionReviews } from '../missions/review-store.js';
import type { TeamFinalReviews } from '../missions/team-final-review.js';
import type { ReviewCharterDefinition } from '../contracts/strategy-protocol.js';
import { validMissionResult } from '../contracts/mission-result.js';
import { validTeamBrief } from '../contracts/team-brief.js';
import { digest } from '../domain/contracts.js';
import type { ReviewMission, ReviewMissionCoverage } from './review.js';

export type MissionProjection = {
  kind: 'single' | 'team';
  id: string;
  state: string;
  version: number;
  generation: number;
  order_digest: string;
  context_digest: string;
  goal_id: string | null;
  project_id: string | null;
  sources: Array<{ source_id: string; revision_id: string }>;
  submission_id: string | null;
  submission_digest: string | null;
  details: unknown;
};
/** Metadata only. Private result bytes are read later by the accepted S05/S06 stores after capture releases its lease. */
export async function missionProjection(
  client: PoolClient,
  context: KnowledgeContext,
  charter: ReviewCharterDefinition,
): Promise<MissionProjection[]> {
  const single = (
    await client.query(
      `SELECT 'single' AS kind,m.id,m.state,m.version,m.generation,w.digest AS order_digest,w.context_digest,
      w.body->'request'->>'goal_id' AS goal_id,w.body->'request'->>'project_id' AS project_id,
      w.body->'request'->'sources' AS sources,s.id AS submission_id,s.digest AS submission_digest,
      jsonb_build_object('artifact_id',s.artifact_id,'body',s.body,'review',r.id,'decision',r.decision) AS details
    FROM cos.missions m JOIN cos.mission_work_orders w ON w.scope_id=m.scope_id AND w.id=m.id
    LEFT JOIN cos.mission_result_submissions s ON s.scope_id=m.scope_id AND s.mission_id=m.id AND s.generation=m.generation
    LEFT JOIN cos.mission_reviews r ON r.scope_id=m.scope_id AND r.mission_id=m.id AND r.result_id=s.id
    WHERE m.scope_id=$1 AND (w.body->'request'->>'project_id'=ANY($2::text[]) OR w.body->'request'->>'goal_id'=ANY($2::text[]))
      AND NOT EXISTS(SELECT 1 FROM cos.mission_team_children c WHERE c.scope_id=m.scope_id AND c.mission_id=m.id)
    ORDER BY m.id LIMIT 21`,
      [context.scopeId, charter.initiative_ids],
    )
  ).rows;
  const teams = (
    await client.query(
      `SELECT 'team' AS kind,m.id,m.state,m.version,m.generation,w.digest AS order_digest,w.context_digest,
      w.body->'request'->>'goal_id' AS goal_id,w.body->'request'->>'project_id' AS project_id,
      w.body->'request'->'sources' AS sources,
      (SELECT s.provenance->>'submission_id' FROM cos.mission_team_steps s WHERE s.scope_id=m.scope_id AND s.team_id=m.id AND s.state='submitted'
        ORDER BY CASE s.definition->>'template_id' WHEN 'team-reviewer' THEN 0 WHEN 'team-writer' THEN 1 ELSE 2 END,s.step_id LIMIT 1) AS submission_id,
      NULL AS submission_digest,
      jsonb_build_object('steps',(SELECT jsonb_agg(jsonb_build_object('id',s.step_id,'version',s.version,'state',s.state,'definition',s.definition,
        'provenance',s.provenance,'child',s.child_mission_id) ORDER BY s.step_id) FROM cos.mission_team_steps s WHERE s.scope_id=m.scope_id AND s.team_id=m.id),
      'children',(SELECT jsonb_agg(jsonb_build_object('id',c.mission_id,'step',c.step_id,'revision',c.revision,'submission',s.id,'digest',s.digest,'artifact',s.artifact_id)
        ORDER BY c.step_id,c.revision,s.id) FROM cos.mission_team_children c LEFT JOIN cos.mission_result_submissions s ON s.scope_id=c.scope_id AND s.mission_id=c.mission_id
        WHERE c.scope_id=m.scope_id AND c.team_id=m.id),
      'reviews',(SELECT jsonb_agg(jsonb_build_object('id',r.id,'digest',r.result_digest,'decision',r.decision) ORDER BY r.id)
        FROM cos.mission_team_reviews r WHERE r.scope_id=m.scope_id AND r.team_id=m.id)) AS details
    FROM cos.mission_team_roots m JOIN cos.mission_team_work_orders w ON w.scope_id=m.scope_id AND w.id=m.id
    WHERE m.scope_id=$1 AND (w.body->'request'->>'project_id'=ANY($2::text[]) OR w.body->'request'->>'goal_id'=ANY($2::text[]))
    ORDER BY m.id LIMIT 21`,
      [context.scopeId, charter.initiative_ids],
    )
  ).rows;
  return [...single, ...teams].sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
export type MissionReaders = {
  missionReviews?: Pick<MissionReviews, 'read' | 'reviewAuthorityDigest'>;
  teamFinalReviews?: Pick<TeamFinalReviews, 'read' | 'reviewAuthorityDigest'>;
};
export async function readReviewMissions(
  context: KnowledgeContext,
  charter: ReviewCharterDefinition,
  sources: Array<{ id: string; revision_id: string }>,
  projection: MissionProjection[],
  readers: MissionReaders,
): Promise<
  | { status: 'ok'; missions: ReviewMission[]; coverage: ReviewMissionCoverage[]; truncated: boolean }
  | { status: 'unavailable'; coverage: 'incomplete' }
> {
  const unavailable = () => ({ status: 'unavailable' as const, coverage: 'incomplete' as const });
  const missions: ReviewMission[] = [],
    coverage: ReviewMissionCoverage[] = [];
  // A selected result without its trusted reader is a missing implementation, not evidence of no result.
  if (
    projection.some(
      (p) => p.submission_id && !(p.kind === 'single' ? readers.missionReviews : readers.teamFinalReviews),
    )
  )
    return unavailable();
  for (const p of projection.slice(0, 20)) {
    const base: ReviewMissionCoverage = {
      scope_id: context.scopeId,
      mission_id: p.id,
      goal_id: p.goal_id,
      project_id: p.project_id,
      state: p.state,
      coverage: 'missing',
    };
    const relatedAllowed = [p.goal_id, p.project_id].every((id) => id === null || charter.initiative_ids.includes(id));
    const sourceAllowed =
      Array.isArray(p.sources) &&
      p.sources.length <= 6 &&
      p.sources.every((s) => sources.some((v) => v.id === s.source_id && v.revision_id === s.revision_id));
    if (!relatedAllowed || !sourceAllowed) {
      coverage.push({ ...base, coverage: 'withheld' });
      continue;
    }
    if (!p.submission_id) {
      coverage.push(base);
      continue;
    }
    const reader = p.kind === 'single' ? readers.missionReviews! : readers.teamFinalReviews!;
    const read = await reader.read(context, p.id, p.submission_id);
    if (['unavailable', 'pending', 'conflict'].includes(read.status)) return unavailable();
    if (read.status !== 'ok') {
      coverage.push({ ...base, coverage: 'withheld' });
      continue;
    }
    const result = read.result;
    const mission = read.mission as { id: string; state: ReviewMission['state']; version: number };
    const submission = read.submission as { id: string; digest: string };
    if (
      !(p.kind === 'single' ? validMissionResult(result) : validTeamBrief(result)) ||
      !(validMissionResult(result) || validTeamBrief(result)) ||
      mission.id !== p.id ||
      mission.version !== p.version ||
      mission.state !== p.state ||
      submission.id !== p.submission_id ||
      submission.digest !== digest(result) ||
      (p.submission_digest !== null && submission.digest !== p.submission_digest)
    )
      return unavailable();
    const limited =
      result.format === 'cos-research-result/v1'
        ? result.outcome !== 'answer' || result.limitations.length > 0
        : result.limitations.length > 0 ||
          result.outputs.some(
            (o) =>
              o.state === 'failed' ||
              (o.result.format === 'cos-research-result/v1' &&
                (o.result.outcome !== 'answer' || o.result.limitations.length > 0)),
          );
    missions.push({
      scope_id: context.scopeId,
      mission_id: p.id,
      submission_id: submission.id,
      digest: submission.digest,
      goal_id: p.goal_id,
      project_id: p.project_id,
      source_ids: p.sources.map((s) => s.source_id),
      state: mission.state,
      conclusion: 'Submitted specialist research; advisory claims require separate outcome evidence.',
      evidence: [],
      result,
    });
    coverage.push({ ...base, coverage: limited ? 'partial' : 'available' });
  }
  return {
    status: 'ok',
    missions,
    coverage,
    truncated: projection.length > 20 || coverage.some((c) => ['missing', 'withheld'].includes(c.coverage)),
  };
}
