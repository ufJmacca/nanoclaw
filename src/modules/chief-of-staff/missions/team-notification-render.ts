import { validTeamBrief, type TeamBrief, type TeamBriefOutput } from '../contracts/team-brief.js';

type Display = { text: number; claims: number; citations: number; notes: number; shortened: boolean };
const clip = (text: string, max: number) =>
  [...text].length > max ? [...text].slice(0, max).join('') + '… [excerpt shortened]' : text;
const quote = (text: string) => {
  const safe = text.replaceAll('@', '＠'),
    fence = '`'.repeat(Math.max(3, ...[...safe.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return fence + '\n' + safe + '\n' + fence;
};
function outputLines(output: TeamBriefOutput, display: Display, prior: boolean): string[] {
  const labels = {
    'team-technical-analyst': 'Technical analysis',
    'team-operational-analyst': 'Operational analysis',
    'team-writer': 'Recommendation',
    'team-reviewer': 'Specialist evidence review',
  };
  const lines = [prior ? 'Earlier submitted opinion' : labels[output.template_id], `Step: ${output.step_id}`];
  if (output.state === 'failed')
    return [...lines, `Missing ${output.required ? 'required' : 'optional'} step ${output.step_id}: ${output.reason}.`];
  lines.push('Submitted evidence: ' + output.submission_id);
  const result = output.result;
  if (result.format === 'cos-research-result/v1') {
    lines.push('Specialist outcome: ' + result.outcome);
    for (const claim of result.claims.slice(0, display.claims)) {
      lines.push(
        claim.kind === 'quote' ? 'Source quotation' : 'Specialist inference',
        quote(clip(claim.text, display.text)),
      );
      for (const c of claim.citations.slice(0, display.citations))
        lines.push(
          `Source ${c.source_id}, revision ${c.revision_id}, chunk ${c.ordinal}, L${c.start_line}–L${c.end_line}.`,
        );
      if (claim.citations.length > display.citations)
        lines.push(`${claim.citations.length - display.citations} additional references in the submitted evidence.`);
    }
    if (result.claims.length > display.claims)
      lines.push(`${result.claims.length - display.claims} additional claims in the submitted evidence.`);
    for (const note of result.limitations.slice(0, display.notes))
      lines.push('Limitation', quote(clip(note, display.text)));
    if (result.limitations.length > display.notes)
      lines.push(`${result.limitations.length - display.notes} additional limitations in the submitted evidence.`);
  } else {
    lines.push('Advisory confidence: ' + result.confidence);
    for (const verdict of ['supported', 'unsupported', 'uncertain'])
      lines.push(
        `${verdict}: ${result.evidence_validity.filter((e) => e.verdict === verdict).length} claim assessments.`,
      );
    for (const gap of result.factual_gaps.slice(0, display.notes))
      lines.push('Factual gap', quote(clip(gap, display.text)));
    for (const contradiction of result.contradictions.slice(0, display.notes))
      lines.push(
        'Disagreement: ' + contradiction.step_ids.join(', '),
        quote(clip(contradiction.description, display.text)),
      );
    if (result.unmet_criteria.length) lines.push('Unmet criteria: ' + result.unmet_criteria.join(', '));
    for (const revision of result.recommended_revisions)
      lines.push('Advisory revision for ' + revision.step_id, quote(clip(revision.instructions, display.text)));
    if (result.factual_gaps.length > display.notes || result.contradictions.length > display.notes)
      lines.push('Additional gaps/disagreements are retained in the submitted evidence.');
  }
  return lines;
}
function render(teamId: string, state: string, brief: TeamBrief, display: Display) {
  const lines = [
    `Team result — ${state === 'completed' ? 'accepted' : state} (coordinator review)`,
    `Team: ${teamId}`,
    'Specialist and coordinator quality judgements are advisory; citations do not prove an inference.',
  ];
  if (display.shortened)
    lines.push(
      'Display shortened. This is an excerpt; ask for the full brief using the team reference above. Every submitted opinion remains in its evidence receipt.',
    );
  if (state === 'blocked') lines.push('The following work was not accepted as a completed recommendation.');
  lines.push('Question', quote(clip(brief.question, display.text)));
  for (const output of brief.outputs) lines.push(...outputLines(output, display, false));
  for (const output of brief.superseded_outputs) lines.push(...outputLines(output, display, true));
  for (const limitation of brief.limitations) lines.push('Graph limitation', quote(clip(limitation, display.text)));
  return lines.join('\n\n');
}
/** One bounded display. Full verified artifacts remain available; abbreviated prose is explicitly labelled. */
export function renderTeamNotification(teamId: string, state: string, input: unknown): string {
  if (!validTeamBrief(input) || input.team_id !== teamId || !['completed', 'partial', 'blocked'].includes(state))
    throw Error('invalid_team_notification');
  for (const display of [
    { text: 2000, claims: 8, citations: 8, notes: 8, shortened: false },
    { text: 400, claims: 8, citations: 2, notes: 2, shortened: true },
    { text: 180, claims: 2, citations: 1, notes: 1, shortened: true },
    { text: 100, claims: 1, citations: 1, notes: 1, shortened: true },
  ]) {
    const text = render(teamId, state, input, display);
    if ([...text].length <= 16383) return text;
  }
  throw Error('team_notification_too_large');
}
