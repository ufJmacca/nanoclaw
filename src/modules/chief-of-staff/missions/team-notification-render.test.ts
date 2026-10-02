import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { TeamBrief } from '../contracts/team-brief.js';
import type { MissionResult } from '../contracts/mission-result.js';
import { renderTeamNotification } from './team-notification-render.js';
function brief(): TeamBrief {
  const result = (text: string): MissionResult => ({
    format: 'cos-research-result/v1',
    outcome: 'answer',
    claims: [
      {
        id: 'claim',
        kind: 'inference',
        text,
        citations: [{ source_id: 'note', revision_id: 'rev', ordinal: 0, start_line: 1, end_line: 2 }],
      },
    ],
    criteria: [{ id: 'tradeoff', claim_ids: ['claim'] }],
    limitations: ['Supplied notes only.'],
  });
  const output = (
    step_id: string,
    template_id: TeamBrief['outputs'][number]['template_id'],
    text: string,
  ): TeamBrief['outputs'][number] => ({
    step_id,
    template_id,
    required: true,
    state: 'submitted',
    mission_id: 'mission-' + step_id,
    submission_id: randomUUID(),
    artifact_id: 'a'.repeat(64) + '-' + 'b'.repeat(64),
    result_digest: 'c'.repeat(64),
    result: result(text),
  });
  const reviewer = output('review', 'team-reviewer', 'ignored');
  if (reviewer.state === 'submitted')
    reviewer.result = {
      format: 'cos-team-review/v1',
      evidence_validity: [
        {
          step_id: 'technical',
          claim_id: 'claim',
          verdict: 'unsupported',
          reason: 'Evidence does not prove this inference.',
        },
      ],
      factual_gaps: ['No live benchmark.'],
      contradictions: [
        { step_ids: ['technical', 'operations'], description: 'Cost and capacity favour different options.' },
      ],
      unmet_criteria: [],
      recommended_revisions: [],
      confidence: 'low',
    };
  return {
    format: 'cos-team-brief/v1',
    team_id: 'team-' + 'a'.repeat(64),
    generation: 1,
    work_order_digest: 'd'.repeat(64),
    question: 'Compare cost and capacity.',
    deadline_at: new Date(Date.now() + 600000).toISOString(),
    partial_policy: 'allow_labelled',
    acceptance_criteria: [{ id: 'tradeoff', description: 'Preserve both views.' }],
    review_status: 'specialist_opinions_advisory_coordinator_review_required',
    outputs: [
      output(
        'technical',
        'team-technical-analyst',
        'Prefer B for capacity.\n\x60\x60\x60\n@all [source](https://fixture.invalid)',
      ),
      output('operations', 'team-operational-analyst', 'Prefer A for cost.'),
      output('synthesis', 'team-writer', 'Consider both priorities.'),
      reviewer,
    ],
    superseded_outputs: [],
    limitations: [],
  };
}
it('S06-T04/T05/T08 delivers each independent opinion, references and advisory disagreement without source-controlled mentions', () => {
  const b = brief();
  b.outputs[1] = {
    step_id: 'operations',
    template_id: 'team-operational-analyst',
    required: true,
    state: 'failed',
    reason: 'worker_failed',
  };
  b.superseded_outputs = [{ ...brief().outputs[1] }];
  b.limitations = ['Missing required operational work.'];
  const text = renderTeamNotification(b.team_id, 'partial', b);
  expect(text).toContain('Team result — partial');
  expect(text).toContain('Prefer B for capacity.');
  expect(text).toContain('Prefer A for cost.');
  expect(text).toContain('Earlier submitted opinion');
  expect(text).toContain('Missing required step operations');
  expect(text).toContain('worker_failed');
  expect(text).toContain('quality judgements are advisory');
  expect(text).toContain('Cost and capacity favour different options.');
  expect(text).toContain('confidence: low');
  expect(text).toContain('revision rev, chunk 0, L1–L2');
  expect(text).not.toContain('@all');
  expect(text).toContain('＠all');
  expect(text).toContain('\x60\x60\x60\x60\n');
});
it('S06-T05/T08 bounds a long consolidated display while labelling excerpts and retaining every submitted analyst view', () => {
  const b = brief();
  for (const output of b.outputs)
    if (output.state === 'submitted' && output.result.format === 'cos-research-result/v1') {
      output.result.claims = Array.from({ length: 8 }, (_, i) => ({
        id: 'claim' + i,
        kind: 'inference' as const,
        text: '@all ' + 'long opinion '.repeat(80),
        citations: Array.from({ length: 8 }, (_, j) => ({
          source_id: 'note',
          revision_id: 'rev',
          ordinal: j,
          start_line: 1,
          end_line: 2,
        })),
      }));
      output.result.criteria = [{ id: 'tradeoff', claim_ids: output.result.claims.map((c) => c.id) }];
    }
  const previous = structuredClone(b.outputs[0]);
  if (previous.state === 'submitted') {
    previous.submission_id = randomUUID();
    previous.mission_id += '-prior';
  }
  b.superseded_outputs = [previous];
  const text = renderTeamNotification(b.team_id, 'completed', b);
  expect([...text].length).toBeLessThanOrEqual(16383);
  expect(text).toContain('Display shortened');
  for (const step of ['technical', 'operations', 'synthesis', 'review']) expect(text).toContain('Step: ' + step);
  expect(text).toContain('Earlier submitted opinion');
  expect(text).toContain('additional claims');
  expect(text).not.toContain('@all');
});
it('S06-T05 denies a foreign team or unexpected private working-history fields', () => {
  const b = brief();
  expect(() => renderTeamNotification('team-' + 'b'.repeat(64), 'completed', b)).toThrow();
  expect(() =>
    renderTeamNotification(b.team_id, 'completed', { ...b, private_working_history: 'unrelated' } as TeamBrief),
  ).toThrow();
});
