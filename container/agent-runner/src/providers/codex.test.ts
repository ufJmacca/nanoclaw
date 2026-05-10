import { describe, expect, it } from 'bun:test';

import { codexProgressMessages } from './codex.js';
import type { JsonRpcNotification } from './codex-app-server.js';

describe('codexProgressMessages', () => {
  it('emits completed reasoning summaries as user-facing progress', () => {
    const messages = codexProgressMessages(
      notification('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: Date.now(),
        item: {
          type: 'reasoning',
          id: 'item-1',
          summary: ['Inspecting the Telegram delivery path.', 'Adding a regression test.'],
          content: ['raw reasoning should not be sent'],
        },
      }),
    );

    expect(messages).toEqual(['Inspecting the Telegram delivery path.\nAdding a regression test.']);
  });

  it('does not expose raw reasoning text deltas', () => {
    const messages = codexProgressMessages(
      notification('item/reasoning/textDelta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        contentIndex: 0,
        delta: 'private raw reasoning',
      }),
    );

    expect(messages).toEqual([]);
  });

  it('emits the current plan step when Codex updates its turn plan', () => {
    const messages = codexProgressMessages(
      notification('turn/plan/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        explanation: 'Checking the visible progress behavior.',
        plan: [
          { step: 'Inspect current code', status: 'completed' },
          { step: 'Add tests', status: 'inProgress' },
          { step: 'Open a PR', status: 'pending' },
        ],
      }),
    );

    expect(messages).toEqual(['Checking the visible progress behavior.\nAdd tests']);
  });

  it('skips completed goal notifications so completion does not replay progress', () => {
    const messages = codexProgressMessages(
      notification('thread/goal/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        goal: {
          threadId: 'thread-1',
          objective: 'Implement Telegram progress visibility',
          status: 'complete',
          tokenBudget: null,
          tokensUsed: 100,
          timeUsedSeconds: 30,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    );

    expect(messages).toEqual([]);
  });
});

function notification(method: string, params: Record<string, unknown>): JsonRpcNotification {
  return { method, params };
}
