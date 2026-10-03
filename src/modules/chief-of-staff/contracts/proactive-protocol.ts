import { validProactivePolicy, type ProactivePolicy } from './proactive-policy.js';
import { validMissionRequest, type MissionRequest } from './mission-protocol.js';
export type ProactivePolicyChange = {
  kind: 'proactive_policy';
  state: 'active' | 'paused';
  policy: ProactivePolicy;
  expected_version: number;
  reason: string;
};
export type ProactiveDispositionRequest = {
  suggestion_id: string;
  expected_version: number;
  decision: 'accept' | 'defer' | 'dismiss';
  review_at: string | null;
  reason: string;
  usefulness: 'useful' | 'not_useful' | 'unrated';
  review_seconds: number;
};
export type ProactiveDraft = {
  candidate_key: string;
  title: string;
  purpose: string;
  goal_id: string;
  recommendation: 'act' | 'wait' | 'stop' | 'question';
  action_class: 'research' | 'clarification' | 'project_review' | 'wait';
  confidence: 'low' | 'medium' | 'high';
  uncertainty: string;
  expected_benefit: string;
  estimated_effort: { minutes: number; assumptions: string };
  opportunity_cost: string;
  permission_requirements: Array<'owner_approval' | 'source_access' | 'delegation_consent'>;
  work_order: MissionRequest | null;
  review_at: string;
  expires_at: string;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const integer = (v: unknown, min: number, max: number) =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= max &&
  [...v].every((c) => {
    const n = c.codePointAt(0)!;
    return (n >= 32 || n === 10 || n === 9) && (n < 127 || n > 159);
  }) &&
  Buffer.from(v).toString('utf8') === v;
const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export const proactiveInstant = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().replace('.000Z', 'Z') === v;
export function validProactivePolicyChange(v: unknown): v is ProactivePolicyChange {
  return (
    object(v) &&
    exact(v, ['kind', 'state', 'policy', 'expected_version', 'reason']) &&
    v.kind === 'proactive_policy' &&
    ['active', 'paused'].includes(String(v.state)) &&
    validProactivePolicy(v.policy) &&
    integer(v.expected_version, 0, 2147483646) &&
    text(v.reason, 2000)
  );
}
export function validProactiveDisposition(v: unknown): v is ProactiveDispositionRequest {
  return (
    object(v) &&
    exact(v, [
      'suggestion_id',
      'expected_version',
      'decision',
      'review_at',
      'reason',
      'usefulness',
      'review_seconds',
    ]) &&
    typeof v.suggestion_id === 'string' &&
    /^suggestion-[a-f0-9]{64}$/.test(v.suggestion_id) &&
    integer(v.expected_version, 1, 2147483646) &&
    ['accept', 'defer', 'dismiss'].includes(String(v.decision)) &&
    (v.decision === 'defer' ? proactiveInstant(v.review_at) : v.review_at === null) &&
    text(v.reason, 2000) &&
    ['useful', 'not_useful', 'unrated'].includes(String(v.usefulness)) &&
    integer(v.review_seconds, 0, 3600)
  );
}
export function validProactiveDraft(v: unknown): v is ProactiveDraft {
  if (
    !object(v) ||
    !exact(v, [
      'candidate_key',
      'title',
      'purpose',
      'goal_id',
      'recommendation',
      'action_class',
      'confidence',
      'uncertainty',
      'expected_benefit',
      'estimated_effort',
      'opportunity_cost',
      'permission_requirements',
      'work_order',
      'review_at',
      'expires_at',
    ])
  )
    return false;
  return (
    typeof v.candidate_key === 'string' &&
    /^[a-f0-9]{64}$/.test(v.candidate_key) &&
    text(v.title, 200) &&
    text(v.purpose, 2000) &&
    id(v.goal_id) &&
    ['act', 'wait', 'stop', 'question'].includes(String(v.recommendation)) &&
    ['research', 'clarification', 'project_review', 'wait'].includes(String(v.action_class)) &&
    ['low', 'medium', 'high'].includes(String(v.confidence)) &&
    text(v.uncertainty, 2000) &&
    text(v.expected_benefit, 2000) &&
    object(v.estimated_effort) &&
    exact(v.estimated_effort, ['minutes', 'assumptions']) &&
    integer(v.estimated_effort.minutes, 1, 480) &&
    text(v.estimated_effort.assumptions, 1000) &&
    text(v.opportunity_cost, 2000) &&
    Array.isArray(v.permission_requirements) &&
    v.permission_requirements.length >= 1 &&
    v.permission_requirements.length <= 3 &&
    v.permission_requirements.includes('owner_approval') &&
    new Set(v.permission_requirements).size === v.permission_requirements.length &&
    v.permission_requirements.every((p) => ['owner_approval', 'source_access', 'delegation_consent'].includes(p)) &&
    (v.action_class === 'research'
      ? v.recommendation === 'act' &&
        validMissionRequest(v.work_order) &&
        v.permission_requirements.includes('source_access') &&
        v.permission_requirements.includes('delegation_consent')
      : v.work_order === null) &&
    proactiveInstant(v.review_at) &&
    proactiveInstant(v.expires_at) &&
    Date.parse(v.expires_at) > Date.parse(v.review_at)
  );
}
