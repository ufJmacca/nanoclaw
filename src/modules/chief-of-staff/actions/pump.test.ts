import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CosBinding } from '../../../cos-boundary.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { Result } from '../domain/contracts.js';
import { ActionPump } from './pump.js';

function fixture() {
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    sessionId: 'main',
    agentGroupId: 'group',
    messagingGroupId: 'private-group',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    botId: 'bot',
  };
  let context: KnowledgeContext | null = {
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    sessionId: binding.sessionId,
    agentGroupId: binding.agentGroupId,
    ingressId: 'historical-owner',
    provider: 'codex',
    generation: randomUUID(),
  };
  const id = 'action-' + 'a'.repeat(64);
  const admitted = vi.fn(async () => true),
    recover = vi.fn(async (): Promise<Result> => ({ status: 'ok', next_offset: null })),
    pending = vi.fn(async (): Promise<Result> => ({ status: 'ok', action_ids: [id], next_after: null })),
    execute = vi.fn(async () => ({ status: 'ok' as const, state: 'verified' }));
  const pump = new ActionPump({ current: () => context, admitted, recover, pending, execute });
  return {
    binding,
    id,
    pump,
    admitted,
    recover,
    pending,
    execute,
    setContext: (value: KnowledgeContext | null) => {
      context = value;
    },
    context,
  };
}
it('does not execute after private membership is revoked during journal recovery', async () => {
  const f = fixture();
  f.recover.mockImplementation(async () => {
    f.admitted.mockResolvedValue(false);
    return { status: 'ok', next_offset: null };
  });
  await f.pump.drain(f.binding);
  expect(f.execute).not.toHaveBeenCalled();
});
it('does not execute after retained context replacement during queue discovery', async () => {
  const f = fixture();
  f.pending.mockImplementation(async () => {
    f.setContext({ ...f.context!, generation: randomUUID() });
    return { status: 'ok', action_ids: [f.id], next_after: null };
  });
  await f.pump.drain(f.binding);
  expect(f.execute).not.toHaveBeenCalled();
});
it.each(['too_many', 'invalid_id', 'duplicate', 'unsorted', 'bad_cursor', 'bad_journal_cursor'])(
  'closes a malformed %s host page before executing any effect',
  async (kind) => {
    const f = fixture(),
      other = 'action-' + 'b'.repeat(64);
    const ids =
      kind === 'too_many'
        ? Array.from({ length: 21 }, (_, index) => 'action-' + index.toString(16).padStart(64, '0'))
        : kind === 'invalid_id'
          ? ['other-scope']
          : kind === 'duplicate'
            ? [f.id, f.id]
            : kind === 'unsorted'
              ? [other, f.id]
              : [f.id];
    f.pending.mockResolvedValue({ status: 'ok', action_ids: ids, next_after: kind === 'bad_cursor' ? other : null });
    if (kind === 'bad_journal_cursor') f.recover.mockResolvedValue({ status: 'ok', next_offset: 0 });
    await f.pump.drain(f.binding);
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it('bounds each tick to one journal page and advances beyond an unresolved queue page', async () => {
  const f = fixture(),
    ids = Array.from({ length: 20 }, (_, index) => 'action-' + index.toString(16).padStart(64, '0'));
  f.recover.mockResolvedValueOnce({ status: 'ok', next_offset: 100 });
  f.pending.mockResolvedValueOnce({ status: 'ok', action_ids: ids, next_after: ids.at(-1) });
  f.execute.mockResolvedValue({ status: 'ok', state: 'outcome_uncertain' });
  await f.pump.drain(f.binding);
  expect(f.execute).toHaveBeenCalledTimes(20);
  await f.pump.drain(f.binding);
  expect(f.recover.mock.calls[1]).toEqual([f.context, 100]);
  expect(f.pending.mock.calls[1]).toEqual([f.context, ids.at(-1)]);
});
it('coalesces overlapping ticks and stops remaining work on shutdown', async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.recover.mockImplementation(async () => {
    entered();
    await gate;
    return { status: 'ok', next_offset: null };
  });
  const first = f.pump.drain(f.binding);
  await started;
  await f.pump.drain(f.binding);
  expect(f.recover).toHaveBeenCalledTimes(1);
  f.pump.close();
  release();
  await first;
  expect(f.execute).not.toHaveBeenCalled();
});
it('keeps private host diagnostics inside the pump and permits a later recovery tick', async () => {
  const f = fixture();
  f.recover.mockRejectedValueOnce(new Error('PRIVATE_ACCOUNT_ENDPOINT'));
  await expect(f.pump.drain(f.binding)).resolves.toBeUndefined();
  await f.pump.drain(f.binding);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
