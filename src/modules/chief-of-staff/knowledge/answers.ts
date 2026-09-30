export type AnswerCitation =
  | { kind: 'source'; evidence_id: string }
  | { kind: 'record'; record_id: string; version: number };
export type AnswerDraft = {
  kind: 'answer' | 'summary';
  coverage: 'limited' | 'conflicting' | 'insufficient';
  claims: Array<{ kind: 'quote' | 'inference'; text: string; citations: AnswerCitation[] }>;
};
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
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const control = (character: string) => {
  const code = character.codePointAt(0)!;
  return code < 32 || (code >= 127 && code <= 159);
};
export function validAnswerCitation(citation: unknown): citation is AnswerCitation {
  if (!object(citation)) return false;
  if (citation.kind === 'source')
    return (
      keys(citation, ['kind', 'evidence_id']) &&
      typeof citation.evidence_id === 'string' &&
      uuid.test(citation.evidence_id)
    );
  return (
    citation.kind === 'record' &&
    keys(citation, ['kind', 'record_id', 'version']) &&
    typeof citation.record_id === 'string' &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(citation.record_id) &&
    Number.isSafeInteger(citation.version) &&
    Number(citation.version) > 0
  );
}
export function validAnswerDraft(value: unknown): value is AnswerDraft {
  if (
    !object(value) ||
    !keys(value, ['kind', 'coverage', 'claims']) ||
    !['answer', 'summary'].includes(String(value.kind)) ||
    !['limited', 'conflicting', 'insufficient'].includes(String(value.coverage)) ||
    !Array.isArray(value.claims) ||
    value.claims.length > 8
  )
    return false;
  if (
    value.coverage === 'insufficient'
      ? value.claims.length !== 0
      : value.claims.length < (value.coverage === 'conflicting' ? 2 : 1)
  )
    return false;
  for (const claim of value.claims) {
    if (
      !object(claim) ||
      !keys(claim, ['kind', 'text', 'citations']) ||
      !['quote', 'inference'].includes(String(claim.kind)) ||
      typeof claim.text !== 'string' ||
      !claim.text.trim() ||
      claim.text.length > 2000 ||
      [...claim.text].some((character) => character !== '\n' && character !== '\t' && control(character)) ||
      Buffer.from(claim.text).toString('utf8') !== claim.text ||
      !Array.isArray(claim.citations) ||
      !claim.citations.length ||
      claim.citations.length > 5 ||
      (claim.kind === 'quote' && claim.citations.length !== 1)
    )
      return false;
    if (!claim.citations.every(validAnswerCitation)) return false;
  }
  const unique = new Set(
    value.claims.flatMap((claim) => (claim as AnswerDraft['claims'][number]).citations.map(citationKey)),
  );
  return unique.size <= 10 && Buffer.byteLength(JSON.stringify(value)) <= 16000;
}
export const citationKey = (value: AnswerCitation | ResolvedCitation) =>
  value.kind === 'source' ? 'source:' + value.evidence_id : 'record:' + value.record_id + ':' + value.version;
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
