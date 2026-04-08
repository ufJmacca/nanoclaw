import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_REASONING_EFFORTS,
  resolveCodexRuntimeConfig,
  resolveCodexRuntimeDefaults,
} from './runtime-config.js';

const ORIGINAL_ENV = { ...process.env };
const tempRoots: string[] = [];

function restoreProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createTempRepo(envFileContent?: string): string {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-codex-runtime-config-'),
  );
  tempRoots.push(tempRoot);

  if (envFileContent) {
    fs.writeFileSync(path.join(tempRoot, '.env'), envFileContent);
  }

  return tempRoot;
}

afterEach(() => {
  restoreProcessEnv();

  while (tempRoots.length > 0) {
    const tempRoot = tempRoots.pop();
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

describe('resolveCodexRuntimeDefaults', () => {
  it('reads Codex runtime defaults from .env when process.env is unset', () => {
    // Arrange
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
    const projectRoot = createTempRepo(
      ['CODEX_MODEL=gpt-5-codex', 'CODEX_REASONING_EFFORT=high'].join('\n'),
    );

    // Act
    const runtimeConfig = resolveCodexRuntimeDefaults(projectRoot);

    // Assert
    expect(runtimeConfig).toEqual({
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
    });
  });

  it('prefers process.env over .env values', () => {
    // Arrange
    process.env.CODEX_MODEL = 'gpt-5-codex-fast';
    process.env.CODEX_REASONING_EFFORT = 'xhigh';
    const projectRoot = createTempRepo(
      ['CODEX_MODEL=gpt-5-codex', 'CODEX_REASONING_EFFORT=medium'].join('\n'),
    );

    // Act
    const runtimeConfig = resolveCodexRuntimeDefaults(projectRoot);

    // Assert
    expect(runtimeConfig).toEqual({
      model: 'gpt-5-codex-fast',
      reasoningEffort: 'xhigh',
    });
  });

  it('treats blank process.env values as unset and falls back to .env defaults', () => {
    // Arrange
    process.env.CODEX_MODEL = '   ';
    process.env.CODEX_REASONING_EFFORT = '';
    const projectRoot = createTempRepo(
      ['CODEX_MODEL=gpt-5-codex', 'CODEX_REASONING_EFFORT=high'].join('\n'),
    );

    // Act
    const runtimeConfig = resolveCodexRuntimeDefaults(projectRoot);

    // Assert
    expect(runtimeConfig).toEqual({
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
    });
  });

  it('returns undefined when no Codex runtime defaults resolve', () => {
    // Arrange
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
    const projectRoot = createTempRepo();

    // Act
    const runtimeConfig = resolveCodexRuntimeDefaults(projectRoot);

    // Assert
    expect(runtimeConfig).toBeUndefined();
  });

  it('rejects invalid reasoning effort defaults with a clear error', () => {
    // Arrange
    delete process.env.CODEX_REASONING_EFFORT;
    const projectRoot = createTempRepo('CODEX_REASONING_EFFORT=turbo\n');

    // Act
    const resolveDefaults = () => resolveCodexRuntimeDefaults(projectRoot);

    // Assert
    expect(resolveDefaults).toThrowError(
      'Invalid Codex reasoning effort "turbo". Expected one of: low, medium, high, xhigh.',
    );
  });
});

describe('resolveCodexRuntimeConfig', () => {
  it('prefers canonical provider options over legacy keys and env defaults', () => {
    // Arrange
    const projectRoot = createTempRepo(
      ['CODEX_MODEL=gpt-env', 'CODEX_REASONING_EFFORT=medium'].join('\n'),
    );

    // Act
    const runtimeConfig = resolveCodexRuntimeConfig(projectRoot, {
      model: 'gpt-canonical',
      profile: 'gpt-legacy',
      reasoningEffort: 'low',
      reasoning: 'high',
    });

    // Assert
    expect(runtimeConfig).toEqual({
      model: 'gpt-canonical',
      reasoningEffort: 'low',
    });
  });

  it('treats blank provider-option strings as unset and falls back by precedence', () => {
    // Arrange
    const projectRoot = createTempRepo(
      ['CODEX_MODEL=gpt-env', 'CODEX_REASONING_EFFORT=high'].join('\n'),
    );

    // Act
    const runtimeConfig = resolveCodexRuntimeConfig(projectRoot, {
      model: '   ',
      profile: '',
      reasoningEffort: ' ',
      reasoning: '   ',
    });

    // Assert
    expect(runtimeConfig).toEqual({
      model: 'gpt-env',
      reasoningEffort: 'high',
    });
  });

  it('falls back to legacy provider-option keys when canonical values are blank', () => {
    // Arrange
    const projectRoot = createTempRepo(
      ['CODEX_MODEL=gpt-env', 'CODEX_REASONING_EFFORT=high'].join('\n'),
    );

    // Act
    const runtimeConfig = resolveCodexRuntimeConfig(projectRoot, {
      model: '   ',
      profile: 'gpt-legacy',
      reasoningEffort: ' ',
      reasoning: 'medium',
    });

    // Assert
    expect(runtimeConfig).toEqual({
      model: 'gpt-legacy',
      reasoningEffort: 'medium',
    });
  });

  it('rejects invalid provider-option reasoning values with a clear error', () => {
    // Arrange
    const projectRoot = createTempRepo();

    // Act
    const resolveRuntimeConfig = () =>
      resolveCodexRuntimeConfig(projectRoot, {
        reasoningEffort: 'turbo',
      });

    // Assert
    expect(resolveRuntimeConfig).toThrowError(
      'Invalid Codex reasoning effort "turbo". Expected one of: low, medium, high, xhigh.',
    );
  });

  it('returns undefined when neither provider options nor env defaults resolve', () => {
    // Arrange
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
    const projectRoot = createTempRepo();

    // Act
    const runtimeConfig = resolveCodexRuntimeConfig(projectRoot, {});

    // Assert
    expect(runtimeConfig).toBeUndefined();
  });
});

describe('CODEX_REASONING_EFFORTS', () => {
  it('exports the allowed reasoning-effort values', () => {
    // Arrange
    const expectedReasoningEfforts = ['low', 'medium', 'high', 'xhigh'];

    // Act
    const reasoningEfforts = CODEX_REASONING_EFFORTS;

    // Assert
    expect(reasoningEfforts).toEqual(expectedReasoningEfforts);
  });
});
