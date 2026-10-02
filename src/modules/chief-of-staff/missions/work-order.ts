import { RESEARCH_TEMPLATE } from '../contracts/research-template.js';
import { canonical, digest } from '../domain/contracts.js';
import { validMissionRequest, type MissionRequest } from '../contracts/mission-protocol.js';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export { RESEARCH_TEMPLATE } from '../contracts/research-template.js';
export type MissionSourceSnapshot = {
  source_id: string;
  revision_id: string;
  source_version: number;
  revision_digest: string;
  title: string;
  status: 'current' | 'stale';
  chunks: Array<{ ordinal: number; start_line: number; end_line: number; text: string }>;
};
export type MissionOrigin = {
  scopeId: string;
  ownerId: string;
  sessionId: string;
  agentGroupId: string;
  ingressId: string;
  bindingDigest: string;
  delegationDigest: string;
  contextGeneration: string;
};
type RelatedRecord = { id: string; version: number } | null;
type Input = {
  missionId: string;
  request: MissionRequest;
  origin: MissionOrigin;
  related: { goal: RelatedRecord; project: RelatedRecord };
  sources: MissionSourceSnapshot[];
  provider: { profile: string; model: string; policyDigest: string };
  reviewedTemplateDigest: string;
  issuedAt: string;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown, min: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const text = (v: unknown, max: number, allowEmpty = false): v is string =>
  typeof v === 'string' &&
  (allowEmpty || v.length > 0) &&
  v.length <= max &&
  Buffer.from(v).toString('utf8') === v &&
  [...v].every((c) => {
    const n = c.codePointAt(0)!;
    return (n >= 32 || n === 10 || n === 9) && (n < 127 || n > 159);
  });
const instant = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
function related(v: unknown, requested: string | null): boolean {
  return requested === null
    ? v === null
    : object(v) && exact(v, ['id', 'version']) && v.id === requested && integer(v.version, 1);
}
function source(v: unknown): v is MissionSourceSnapshot {
  if (
    !object(v) ||
    !exact(v, ['source_id', 'revision_id', 'source_version', 'revision_digest', 'title', 'status', 'chunks']) ||
    !id(v.source_id) ||
    !id(v.revision_id) ||
    !integer(v.source_version, 1) ||
    !hash(v.revision_digest) ||
    !text(v.title, 200) ||
    !['current', 'stale'].includes(String(v.status)) ||
    !Array.isArray(v.chunks) ||
    v.chunks.length < 1 ||
    v.chunks.length > 512
  )
    return false;
  let nextLine = 1;
  return v.chunks.every((c, index) => {
    if (
      !object(c) ||
      !exact(c, ['ordinal', 'start_line', 'end_line', 'text']) ||
      c.ordinal !== index ||
      c.start_line !== nextLine ||
      !integer(c.end_line, nextLine) ||
      !text(c.text, 2000, true) ||
      Number(c.end_line) - nextLine + 1 !== c.text.split('\n').length
    )
      return false;
    nextLine = Number(c.end_line) + 1;
    return true;
  });
}
function valid(v: unknown): v is Input {
  if (
    !object(v) ||
    !exact(v, [
      'missionId',
      'request',
      'origin',
      'related',
      'sources',
      'provider',
      'reviewedTemplateDigest',
      'issuedAt',
    ]) ||
    !id(v.missionId) ||
    !validMissionRequest(v.request) ||
    !object(v.origin) ||
    !exact(v.origin, [
      'scopeId',
      'ownerId',
      'sessionId',
      'agentGroupId',
      'ingressId',
      'bindingDigest',
      'delegationDigest',
      'contextGeneration',
    ]) ||
    !['scopeId', 'ownerId', 'sessionId', 'agentGroupId', 'ingressId', 'contextGeneration'].every((key) =>
      id((v.origin as Record<string, unknown>)[key]),
    ) ||
    !hash(v.origin.bindingDigest) ||
    !hash(v.origin.delegationDigest) ||
    !object(v.related) ||
    !exact(v.related, ['goal', 'project']) ||
    !related(v.related.goal, v.request.goal_id) ||
    !related(v.related.project, v.request.project_id) ||
    !object(v.provider) ||
    !exact(v.provider, ['profile', 'model', 'policyDigest']) ||
    v.provider.profile !== RESEARCH_TEMPLATE.providerProfile ||
    typeof v.provider.model !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(v.provider.model) ||
    !hash(v.provider.policyDigest) ||
    v.reviewedTemplateDigest !== digest(RESEARCH_TEMPLATE) ||
    !instant(v.issuedAt) ||
    !Array.isArray(v.sources) ||
    v.sources.length !== v.request.sources.length ||
    !v.sources.every(source)
  )
    return false;
  const selected = new Map(v.sources.map((s) => [s.source_id, s.revision_id]));
  return (
    selected.size === v.sources.length && v.request.sources.every((s) => selected.get(s.source_id) === s.revision_id)
  );
}
/** Pure snapshot only: caller must verify current access, operator review and private origin before and after persistence. */
export function sealResearchWorkOrder(input: unknown) {
  if (!valid(input)) throw new Error('work_order_denied');
  const value = JSON.parse(JSON.stringify(input)) as Input;
  const context = { format: 'cos-mission-context/v1', sources: value.sources };
  if (Buffer.byteLength(canonical(context), 'utf8') > value.request.limits.context_bytes)
    throw new Error('mission_context_too_large');
  const body = {
    format: 'cos-research-work-order/v1',
    missionId: value.missionId,
    origin: value.origin,
    request: value.request,
    related: value.related,
    template: { id: RESEARCH_TEMPLATE.id, version: RESEARCH_TEMPLATE.version, digest: value.reviewedTemplateDigest },
    provider: value.provider,
    issuedAt: value.issuedAt,
    deadlineAt: new Date(Date.parse(value.issuedAt) + value.request.limits.wall_seconds * 1000).toISOString(),
    resultSchema: RESEARCH_TEMPLATE.resultSchema,
    contextDigest: digest(context),
  };
  return freeze({ body, context, digest: digest(body) });
}
export type ResearchWorkOrder = ReturnType<typeof sealResearchWorkOrder>;
