/** Canonical researcher submission contract; copied verbatim into the restricted worker. */
export type MissionCitation = {
  source_id: string;
  revision_id: string;
  ordinal: number;
  start_line: number;
  end_line: number;
};
export type MissionResult = {
  format: 'cos-research-result/v1';
  outcome: 'answer' | 'partial' | 'blocked';
  claims: Array<{ id: string; kind: 'quote' | 'inference'; text: string; citations: MissionCitation[] }>;
  criteria: Array<{ id: string; claim_ids: string[] }>;
  limitations: string[];
};
const identifier = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' };
export const missionResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['format', 'outcome', 'claims', 'criteria', 'limitations'],
  properties: {
    format: { type: 'string', enum: ['cos-research-result/v1'] },
    outcome: { type: 'string', enum: ['answer', 'partial', 'blocked'] },
    claims: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'text', 'citations'],
        properties: {
          id: identifier,
          kind: { type: 'string', enum: ['quote', 'inference'] },
          text: { type: 'string', minLength: 1, maxLength: 2000 },
          citations: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['source_id', 'revision_id', 'ordinal', 'start_line', 'end_line'],
              properties: {
                source_id: identifier,
                revision_id: identifier,
                ordinal: { type: 'integer', minimum: 0, maximum: 511 },
                start_line: { type: 'integer', minimum: 1, maximum: 1000000 },
                end_line: { type: 'integer', minimum: 1, maximum: 1000000 },
              },
            },
          },
        },
      },
    },
    criteria: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'claim_ids'],
        properties: { id: identifier, claim_ids: { type: 'array', maxItems: 8, uniqueItems: true, items: identifier } },
      },
      description:
        'Map every requested criterion to supporting claim IDs. Empty IDs mean missing coverage. This is a researcher assertion, never a passed review.',
    },
    limitations: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 1000 } },
  },
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= max &&
  Buffer.from(v).toString('utf8') === v &&
  [...v].every((c) => {
    const n = c.codePointAt(0)!;
    return (n >= 32 || n === 10 || n === 9) && (n < 127 || n > 159);
  });
export const missionCitationKey = (v: MissionCitation) =>
  [v.source_id, v.revision_id, v.ordinal, v.start_line, v.end_line].join(':');
function citation(v: unknown): v is MissionCitation {
  return (
    object(v) &&
    exact(v, ['source_id', 'revision_id', 'ordinal', 'start_line', 'end_line']) &&
    id(v.source_id) &&
    id(v.revision_id) &&
    integer(v.ordinal, 0, 511) &&
    integer(v.start_line, 1, 1000000) &&
    integer(v.end_line, v.start_line, 1000000)
  );
}
/** Syntax only. Current source access, evidence matching and coordinator review remain host responsibilities. */
export function validMissionResult(v: unknown, maxBytes = 16384): v is MissionResult {
  if (
    !integer(maxBytes, 512, 16384) ||
    !object(v) ||
    !exact(v, ['format', 'outcome', 'claims', 'criteria', 'limitations']) ||
    v.format !== 'cos-research-result/v1' ||
    !['answer', 'partial', 'blocked'].includes(String(v.outcome)) ||
    !Array.isArray(v.claims) ||
    v.claims.length > 8 ||
    !Array.isArray(v.criteria) ||
    v.criteria.length < 1 ||
    v.criteria.length > 8 ||
    !Array.isArray(v.limitations) ||
    v.limitations.length > 8 ||
    !v.limitations.every((s) => text(s, 1000)) ||
    (v.outcome !== 'answer' && v.limitations.length === 0) ||
    (v.outcome === 'blocked' ? v.claims.length !== 0 : v.outcome === 'answer' && v.claims.length === 0)
  )
    return false;
  const claims = new Set<string>();
  for (const c of v.claims) {
    if (
      !object(c) ||
      !exact(c, ['id', 'kind', 'text', 'citations']) ||
      !id(c.id) ||
      claims.has(c.id) ||
      !['quote', 'inference'].includes(String(c.kind)) ||
      !text(c.text, 2000) ||
      !Array.isArray(c.citations) ||
      c.citations.length < 1 ||
      c.citations.length > 8 ||
      (c.kind === 'quote' && c.citations.length !== 1) ||
      !c.citations.every(citation) ||
      new Set(c.citations.map(missionCitationKey)).size !== c.citations.length
    )
      return false;
    claims.add(c.id);
  }
  const criteria = new Set<string>(),
    usedClaims = new Set<string>();
  for (const c of v.criteria) {
    if (
      !object(c) ||
      !exact(c, ['id', 'claim_ids']) ||
      !id(c.id) ||
      criteria.has(c.id) ||
      !Array.isArray(c.claim_ids) ||
      c.claim_ids.length > 8 ||
      (v.outcome === 'answer' && c.claim_ids.length === 0) ||
      !c.claim_ids.every((claim) => id(claim) && claims.has(claim)) ||
      new Set(c.claim_ids).size !== c.claim_ids.length
    )
      return false;
    criteria.add(c.id);
    for (const claim of c.claim_ids) usedClaims.add(claim);
  }
  return claims.size === usedClaims.size && Buffer.byteLength(JSON.stringify(v), 'utf8') <= maxBytes;
}
