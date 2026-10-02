/** Canonical host-pinned specialist configuration; copied verbatim into the worker. */
export type MissionRuntimeBinding = {
  missionId: string;
  attemptId: string;
  inputId: string;
  generation: number;
  workOrderDigest: string;
  contextDigest: string;
  templateDigest: string;
};
export type MissionRuntimeConfig = {
  provider: 'codex';
  model: string;
  runtime: 'codex-subscription/v1';
  profile: 'research';
  contextGeneration: string;
  agentGroupId: string;
  assistantName: 'CoS Research';
  groupName: 'CoS Research';
  maxMessagesPerPrompt: 1;
  mcpServers: Record<string, never>;
  mission: MissionRuntimeBinding;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validMissionRuntimeBinding(v: unknown): v is MissionRuntimeBinding {
  return (
    object(v) &&
    exact(v, [
      'missionId',
      'attemptId',
      'inputId',
      'generation',
      'workOrderDigest',
      'contextDigest',
      'templateDigest',
    ]) &&
    id(v.missionId) &&
    typeof v.attemptId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.attemptId) &&
    id(v.inputId) &&
    Number.isSafeInteger(v.generation) &&
    Number(v.generation) > 0 &&
    hash(v.workOrderDigest) &&
    hash(v.contextDigest) &&
    hash(v.templateDigest)
  );
}
export function validMissionRuntimeConfig(v: unknown): v is MissionRuntimeConfig {
  return (
    object(v) &&
    exact(v, [
      'provider',
      'model',
      'runtime',
      'profile',
      'contextGeneration',
      'agentGroupId',
      'assistantName',
      'groupName',
      'maxMessagesPerPrompt',
      'mcpServers',
      'mission',
    ]) &&
    v.provider === 'codex' &&
    v.runtime === 'codex-subscription/v1' &&
    v.profile === 'research' &&
    typeof v.model === 'string' &&
    /^[a-zA-Z0-9._-]{1,100}$/.test(v.model) &&
    id(v.agentGroupId) &&
    v.assistantName === 'CoS Research' &&
    v.groupName === 'CoS Research' &&
    v.maxMessagesPerPrompt === 1 &&
    object(v.mcpServers) &&
    Object.keys(v.mcpServers).length === 0 &&
    validMissionRuntimeBinding(v.mission) &&
    v.contextGeneration === v.mission.attemptId
  );
}
