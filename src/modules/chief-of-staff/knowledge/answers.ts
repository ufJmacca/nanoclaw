import { citationKey, validAnswerDraft, type AnswerDraft } from '../contracts/answer-protocol.js';
export {
  citationKey,
  validAnswerCitation,
  validAnswerDraft,
  type AnswerCitation,
  type AnswerDraft,
} from '../contracts/answer-protocol.js';
export type ResolvedCitation =
  | {
      kind: 'source';
      evidence_id: string;
      source_id: string;
      revision_id: string;
      revision_digest: string;
      source_version: number;
      start_line: number;
      end_line: number;
      ordinal: number;
      title: string;
      status: string;
      text: string;
      artifact_id: string;
    }
  | { kind: 'record'; record_id: string; version: number; title: string; record_kind: string; description: string };
const control = (character: string) => {
  const code = character.codePointAt(0)!;
  return code < 32 || (code >= 127 && code <= 159);
};
const label = (value: string) =>
  [...value]
    .map((character) => (control(character) ? ' ' : character))
    .join('')
    .replace(/[\\`*_{}[\]<>]/g, (character) => '\\' + character);
/** Reference correctness is blocking; whether an inference follows is a separate quality judgement. */
export function renderAnswer(draft: AnswerDraft, resolved: ResolvedCitation[]): string {
  if (!validAnswerDraft(draft)) throw new Error('invalid_answer_draft');
  if (draft.coverage === 'insufficient')
    return 'The admitted evidence is insufficient to answer this question. No supported conclusion is available.';
  const found = new Map(resolved.map((item) => [citationKey(item), item])),
    used = new Map<string, number>(),
    footnotes: string[] = [];
  const sections = draft.claims.map((claim) => {
    const refs = claim.citations.map((citation) => {
      const key = citationKey(citation),
        item = found.get(key);
      if (!item) throw new Error('invalid_answer_evidence');
      if (
        claim.kind === 'quote' &&
        !(item.kind === 'source' ? item.text : item.title + '\n' + item.description).includes(claim.text)
      )
        throw new Error('invalid_answer_quotation');
      if (!used.has(key)) {
        const number = used.size + 1;
        used.set(key, number);
        footnotes.push(
          item.kind === 'source'
            ? `[${number}] ${label(item.title)} — lines ${item.start_line}–${item.end_line}, revision ${item.revision_id}, digest ${item.revision_digest}${item.status === 'stale' ? ' (stale source)' : ''}.`
            : `[${number}] Approved ${item.record_kind}: ${label(item.title)} — ${item.record_id}, version ${item.version}.`,
        );
      }
      return `[${used.get(key)}]`;
    });
    return (
      (claim.kind === 'quote'
        ? claim.text
            .split('\n')
            .map((line) => '> ' + line)
            .join('\n')
        : 'Inference: ' + claim.text) +
      ' ' +
      refs.join(' ')
    );
  });
  if (draft.coverage === 'conflicting' && used.size < 2) throw new Error('invalid_answer_evidence');
  return [
    draft.coverage === 'conflicting'
      ? 'The admitted evidence conflicts; these claims are not a settled conclusion.'
      : 'This answer has limited coverage of the admitted evidence.',
    ...sections,
    ...footnotes,
  ].join('\n\n');
}
