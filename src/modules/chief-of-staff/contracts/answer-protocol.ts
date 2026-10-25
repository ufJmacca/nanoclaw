/** Canonical bounded answer contract; copied verbatim into the runner and checked for drift. */
export type AnswerCitation =
  | { kind: 'source'; evidence_id: string }
  | { kind: 'record'; record_id: string; version: number };
export type CalendarEmptyWindow = {
  binding_id: string;
  calendar_id: string;
  time_min: string;
  time_max: string;
};
export type AnswerDraft = {
  kind: 'answer' | 'summary';
  coverage: 'limited' | 'conflicting' | 'insufficient' | 'not_applicable';
  claims: Array<{ kind: 'quote' | 'inference'; text: string; citations: AnswerCitation[] }>;
  questions?: string[];
  notice?: 'approval_required';
  calendar?: 'coverage';
  calendar_window?: CalendarEmptyWindow;
  mail_draft?: { operation_id: string };
};
/** Provider guidance; validAnswerDraft additionally enforces byte, Unicode and cross-field limits. */
export const answerDraftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'coverage', 'claims'],
  properties: {
    mail_draft: {
      type: 'object',
      additionalProperties: false,
      required: ['operation_id'],
      properties: { operation_id: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      description:
        'Append the host-checked, as-of saved-draft receipt for the original operation_id from cos_mail_draft_create/status. Use kind answer and coverage limited. Cite the source email in claims when requested. The host supplies the actual status and verification time; never add your own save confirmation to the returned text.',
    },
    calendar_window: {
      type: 'object',
      additionalProperties: false,
      required: ['binding_id', 'calendar_id', 'time_min', 'time_max'],
      properties: {
        binding_id: { type: 'string', format: 'uuid' },
        calendar_id: { type: 'string', minLength: 1, maxLength: 1024 },
        time_min: { type: 'string', format: 'date-time' },
        time_max: { type: 'string', format: 'date-time' },
      },
      description:
        'Request a host-rendered empty-window reply after a complete zero-event calendar read. Use kind answer, coverage limited, claims [], calendar coverage, and these exact selected calendar/window bounds. No questions, notice, claim text or freshness overrides. The host rejects overlapping events, incomplete coverage and changed access.',
    },
    calendar: {
      type: 'string',
      enum: ['coverage'],
      description:
        'Append current host-verified calendar coverage and freshness. The host rechecks this notice before publication. This does not refresh the provider or prove an empty day.',
    },
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
export function validCalendarEmptyWindow(value: unknown): value is CalendarEmptyWindow {
  const instant = (v: unknown) =>
    typeof v === 'string' &&
    v.length <= 80 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v);
  return (
    object(value) &&
    keys(value, ['binding_id', 'calendar_id', 'time_min', 'time_max']) &&
    typeof value.binding_id === 'string' &&
    uuid.test(value.binding_id) &&
    typeof value.calendar_id === 'string' &&
    value.calendar_id.length > 0 &&
    value.calendar_id.length <= 1024 &&
    !/[\s\u007f-\u009f]/u.test(value.calendar_id) &&
    !['.', '..'].includes(value.calendar_id) &&
    instant(value.time_min) &&
    instant(value.time_max)
  );
}
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
    !keys(value, ['kind', 'coverage', 'claims', 'questions', 'notice', 'calendar', 'calendar_window', 'mail_draft']) ||
    !['answer', 'summary'].includes(String(value.kind)) ||
    !['limited', 'conflicting', 'insufficient', 'not_applicable'].includes(String(value.coverage)) ||
    !Array.isArray(value.claims) ||
    value.claims.length > 8
  )
    return false;
  if (value.notice !== undefined && value.notice !== 'approval_required') return false;
  if (value.calendar !== undefined && value.calendar !== 'coverage') return false;
  if (
    value.mail_draft !== undefined &&
    (!object(value.mail_draft) ||
      !keys(value.mail_draft, ['operation_id']) ||
      typeof value.mail_draft.operation_id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.mail_draft.operation_id) ||
      value.kind !== 'answer' ||
      value.coverage !== 'limited' ||
      value.calendar_window !== undefined)
  )
    return false;
  if (
    value.calendar_window !== undefined &&
    (!validCalendarEmptyWindow(value.calendar_window) ||
      value.kind !== 'answer' ||
      value.coverage !== 'limited' ||
      value.calendar !== 'coverage' ||
      value.claims.length !== 0 ||
      value.questions !== undefined ||
      value.notice !== undefined)
  )
    return false;
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
    value.calendar_window !== undefined || value.coverage === 'insufficient' || value.coverage === 'not_applicable'
      ? value.claims.length !== 0
      : value.claims.length < (value.coverage === 'conflicting' ? 2 : value.mail_draft ? 0 : 1)
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
