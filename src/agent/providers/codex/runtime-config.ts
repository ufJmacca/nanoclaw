import { readEnvFileAt } from '../../../env.js';

export const CODEX_RUNTIME_ENV_KEYS = [
  'CODEX_MODEL',
  'CODEX_REASONING_EFFORT',
] as const;

export const CODEX_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export interface CodexProviderRuntimeConfig {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export function resolveCodexRuntimeDefaults(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexProviderRuntimeConfig | undefined {
  const envFileKeys = readEnvFileAt(projectRoot, [...CODEX_RUNTIME_ENV_KEYS]);
  const model = pickFirstConfiguredString(
    env.CODEX_MODEL,
    envFileKeys.CODEX_MODEL,
  );
  const reasoningEffort = pickFirstReasoningEffort(
    env.CODEX_REASONING_EFFORT,
    envFileKeys.CODEX_REASONING_EFFORT,
  );

  return buildRuntimeConfig(model, reasoningEffort);
}

export function resolveCodexRuntimeConfig(
  projectRoot: string,
  providerOptions?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): CodexProviderRuntimeConfig | undefined {
  const defaults = resolveCodexRuntimeDefaults(projectRoot, env);
  const model = pickFirstConfiguredString(
    providerOptions?.model,
    providerOptions?.profile,
    defaults?.model,
  );
  const reasoningEffort = pickFirstReasoningEffort(
    providerOptions?.reasoningEffort,
    providerOptions?.reasoning,
    defaults?.reasoningEffort,
  );

  return buildRuntimeConfig(model, reasoningEffort);
}

function pickFirstConfiguredString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmedValue = value.trim();
    if (trimmedValue.length > 0) {
      return trimmedValue;
    }
  }

  return undefined;
}

function pickFirstReasoningEffort(
  ...values: unknown[]
): CodexReasoningEffort | undefined {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === 'string' && value.trim().length === 0) {
      continue;
    }

    return parseReasoningEffort(value);
  }

  return undefined;
}

function parseReasoningEffort(value: unknown): CodexReasoningEffort {
  if (typeof value !== 'string') {
    throw invalidReasoningEffortError(value);
  }

  const trimmedValue = value.trim();
  if (isCodexReasoningEffort(trimmedValue)) {
    return trimmedValue;
  }

  throw invalidReasoningEffortError(value);
}

function isCodexReasoningEffort(
  value: string,
): value is CodexReasoningEffort {
  return CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
}

function invalidReasoningEffortError(value: unknown): Error {
  return new Error(
    `Invalid Codex reasoning effort "${String(
      value,
    )}". Expected one of: ${CODEX_REASONING_EFFORTS.join(', ')}.`,
  );
}

function buildRuntimeConfig(
  model?: string,
  reasoningEffort?: CodexReasoningEffort,
): CodexProviderRuntimeConfig | undefined {
  if (!model && !reasoningEffort) {
    return undefined;
  }

  const runtimeConfig: CodexProviderRuntimeConfig = {};

  if (model) {
    runtimeConfig.model = model;
  }

  if (reasoningEffort) {
    runtimeConfig.reasoningEffort = reasoningEffort;
  }

  return runtimeConfig;
}
