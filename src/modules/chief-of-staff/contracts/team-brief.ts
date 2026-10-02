import type { MissionWorkerResult } from './mission-worker-protocol.js';
import type { TeamTemplateId } from './team-templates.js';

/** Verified submitted evidence, including superseded opinions; never private working histories. */
export type TeamBriefOutput = {
  step_id: string;
  template_id: TeamTemplateId;
  required: boolean;
} & (
  | {
      state: 'submitted';
      mission_id: string;
      submission_id: string;
      artifact_id: string;
      result_digest: string;
      result: MissionWorkerResult;
    }
  | {
      state: 'failed';
      reason: string;
    }
);
export type TeamBrief = {
  format: 'cos-team-brief/v1';
  team_id: string;
  generation: number;
  work_order_digest: string;
  question: string;
  deadline_at: string;
  partial_policy: 'block' | 'allow_labelled';
  acceptance_criteria: Array<{ id: string; description: string }>;
  review_status: 'specialist_opinions_advisory_coordinator_review_required';
  outputs: TeamBriefOutput[];
  superseded_outputs: TeamBriefOutput[];
  limitations: string[];
};
