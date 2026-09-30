/** Canonical bounded answer contract; copied verbatim into the runner and checked for drift. */
export type AnswerCitation =
  | { kind: 'source'; evidence_id: string }
  | { kind: 'record'; record_id: string; version: number };
export type AnswerDraft = {
  kind: 'answer' | 'summary';
  coverage: 'limited' | 'conflicting' | 'insufficient' | 'not_applicable';
  claims: Array<{ kind: 'quote' | 'inference'; text: string; citations: AnswerCitation[] }>;
  questions?: string[];
  notice?: 'approval_required';
};
/** Provider guidance; validAnswerDraft additionally enforces byte, Unicode and cross-field limits. */
export const answerDraftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'coverage', 'claims'],
  properties: {
    kind: { type: 'string', enum: ['answer', 'summary'] },
    coverage: { type: 'string', enum: ['limited', 'conflicting', 'insufficient', 'not_applicable'] },
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'string', minLength: 2, maxLength: 500, pattern: '\\?$' },
      description:
        'Clarifying questions only. Put any source-derived assertion in a cited claim instead. Questions are not evidence.',
    },
    notice: {
      type: 'string',
      enum: ['approval_required'],
      description:
        'Fixed reminder that proposals need owner approval; this makes no claim about a particular proposal status.',
    },
    claims: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'citations'],
        properties: {
          kind: { type: 'string', enum: ['quote', 'inference'] },
          text: { type: 'string', minLength: 1, maxLength: 2000 },
          citations: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'evidence_id'],
                  properties: {
                    kind: { type: 'string', enum: ['source'] },
                    evidence_id: { type: 'string', format: 'uuid' },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'record_id', 'version'],
                  properties: {
                    kind: { type: 'string', enum: ['record'] },
                    record_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' },
                    version: { type: 'integer', minimum: 1 },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
};
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
    !keys(value, ['kind', 'coverage', 'claims', 'questions', 'notice']) ||
    !['answer', 'summary'].includes(String(value.kind)) ||
    !['limited', 'conflicting', 'insufficient', 'not_applicable'].includes(String(value.coverage)) ||
    !Array.isArray(value.claims) ||
    value.claims.length > 8
  )
    return false;
  if (value.notice !== undefined && value.notice !== 'approval_required') return false;
  if (
    value.questions !== undefined &&
    (!Array.isArray(value.questions) ||
      value.questions.length < 1 ||
      value.questions.length > 3 ||
      value.questions.some(
        (question) =>
          typeof question !== 'string' ||
          question.trim().length < 2 ||
          question.length > 500 ||
          !question.endsWith('?') ||
          [...question].some(control) ||
          Buffer.from(question).toString('utf8') !== question,
      ))
  )
    return false;
  if (value.coverage === 'not_applicable' && (value.kind !== 'answer' || (!value.notice && !value.questions)))
    return false;
  if (
    value.coverage === 'insufficient' || value.coverage === 'not_applicable'
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
export const citationKey = (value: AnswerCitation) =>
  value.kind === 'source' ? 'source:' + value.evidence_id : 'record:' + value.record_id + ':' + value.version;
