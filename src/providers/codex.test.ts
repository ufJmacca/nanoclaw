import { describe, expect, it } from 'vitest';

import { resolveCodexContainerEnvironment } from './codex.js';

describe('resolveCodexContainerEnvironment', () => {
  it('loads project-level model defaults without copying unrelated values', () => {
    expect(
      resolveCodexContainerEnvironment(
        { HOME: '/home/test' },
        {
          CODEX_MODEL: 'gpt-5.6-sol',
          CODEX_REASONING_EFFORT: 'ultra',
          OPENAI_API_KEY: 'must-not-be-copied-from-project-defaults',
        },
      ),
    ).toEqual({
      CODEX_MODEL: 'gpt-5.6-sol',
      CODEX_REASONING_EFFORT: 'ultra',
    });
  });

  it('prefers explicit host values over project defaults', () => {
    expect(
      resolveCodexContainerEnvironment(
        {
          CODEX_MODEL: 'host-model',
          CODEX_REASONING_EFFORT: 'high',
          OPENAI_BASE_URL: 'https://api.example.test',
        },
        {
          CODEX_MODEL: 'project-model',
          CODEX_REASONING_EFFORT: 'ultra',
        },
      ),
    ).toEqual({
      OPENAI_BASE_URL: 'https://api.example.test',
      CODEX_MODEL: 'host-model',
      CODEX_REASONING_EFFORT: 'high',
    });
  });
});
