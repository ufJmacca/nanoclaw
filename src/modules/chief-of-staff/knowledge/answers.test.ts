import { expect, it } from 'vitest';
import { validAnswerDraft, renderAnswer, type ResolvedCitation } from './answers.js';
const evidence = '11111111-1111-4111-8111-111111111111';
const draft = {
  kind: 'answer',
  coverage: 'limited',
  claims: [
    { kind: 'quote', text: 'Supplier approval is pending.', citations: [{ kind: 'source', evidence_id: evidence }] },
  ],
};
const source: ResolvedCitation = {
  kind: 'source',
  evidence_id: evidence,
  source_id: 'source',
  revision_id: 'revision',
  revision_digest: 'a'.repeat(64),
  source_version: 1,
  start_line: 2,
  end_line: 2,
  ordinal: 0,
  title: 'Pilot note',
  status: 'current',
  text: 'Supplier approval is pending.',
  artifact_id: 'private-host-only',
};
it('accepts bounded source and approved-record claims, including explicitly insufficient coverage', () => {
  expect(validAnswerDraft(draft)).toBe(true);
  expect(
    validAnswerDraft({
      kind: 'summary',
      coverage: 'limited',
      claims: [
        {
          kind: 'inference',
          text: 'Prioritise the approved project.',
          citations: [{ kind: 'record', record_id: 'record', version: 1 }],
        },
      ],
    }),
  ).toBe(true);
  expect(validAnswerDraft({ kind: 'answer', coverage: 'insufficient', claims: [] })).toBe(true);
});
it.each([
  { ...draft, scope_id: 'foreign' },
  { ...draft, claims: [{ kind: 'quote', text: 'unsupported', citations: [] }] },
  {
    ...draft,
    claims: [{ ...draft.claims[0], citations: [{ kind: 'source', evidence_id: evidence, source_id: 'forged' }] }],
  },
  { ...draft, claims: [{ ...draft.claims[0], kind: 'approved_fact' }] },
  { ...draft, claims: [{ ...draft.claims[0], text: 'x'.repeat(2001) }] },
  { ...draft, coverage: 'complete' },
  { ...draft, claims: [] },
])('rejects unsupported authority, uncited claims and unbounded payloads', (value) =>
  expect(validAnswerDraft(value)).toBe(false),
);
it('renders source evidence and labelled inferences without exposing host paths', () => {
  const value = {
    ...draft,
    claims: [
      draft.claims[0],
      {
        kind: 'inference',
        text: 'Ask the supplier for a date.',
        citations: [{ kind: 'source', evidence_id: evidence }],
      },
    ],
  };
  if (!validAnswerDraft(value)) throw new Error('invalid fixture');
  const text = renderAnswer(value, [source]);
  expect(text).toContain('> Supplier approval is pending.');
  expect(text).toContain('Inference: Ask the supplier for a date.');
  expect(text).toContain('lines 2–2');
  expect(text).not.toContain('private-host-only');
  expect(text).toContain('limited');
  expect(renderAnswer({ kind: 'answer', coverage: 'insufficient', claims: [] }, [])).toContain('insufficient');
});
it('blocks an invented quotation or a missing reference instead of rendering a plausible citation', () => {
  if (!validAnswerDraft(draft)) throw new Error('invalid fixture');
  expect(() => renderAnswer(draft, [])).toThrow('invalid_answer_evidence');
  expect(() => renderAnswer(draft, [{ ...source, text: 'The supplier has approved it.' }])).toThrow(
    'invalid_answer_quotation',
  );
});
it('supports clarifying questions and a fixed approval notice without treating them as factual claims', () => {
  const value = {
    kind: 'answer',
    coverage: 'not_applicable',
    claims: [],
    questions: ['Which project should we focus on?'],
    notice: 'approval_required',
  };
  expect(validAnswerDraft(value)).toBe(true);
  if (!validAnswerDraft(value)) throw new Error('invalid fixture');
  expect(renderAnswer(value, [])).toBe(
    'Proposed changes require your approval before they take effect.\n\nQuestion: Which project should we focus on?',
  );
  for (const invalid of [
    { ...value, claims: draft.claims },
    { ...value, notice: 'already_approved' },
    { ...value, questions: ['The project is approved.'] },
    { ...value, questions: ['x'.repeat(501) + '?'] },
    { ...value, questions: ['a?', 'b?', 'c?', 'd?'] },
    { ...value, questions: ['Injected\nassertion?'] },
    { ...value, kind: 'summary' },
    { kind: 'answer', coverage: 'not_applicable', claims: [] },
  ])
    expect(validAnswerDraft(invalid)).toBe(false);
});
