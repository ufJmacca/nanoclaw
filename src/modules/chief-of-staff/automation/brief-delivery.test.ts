import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { BriefDelivery } from './brief-delivery.js';
import type { BriefRunStore } from './brief-store.js';
import type { BriefArtifacts } from './brief-artifacts.js';

function fixture() {
  const context = {
    scopeId: 'scope',
    sessionId: 'session',
    ownerId: 'owner',
    agentGroupId: 'group',
    ingressId: 'scheduled',
    provider: 'codex',
    generation: 'context',
    origin: { kind: 'schedule' as const, runId: 'run', generation: 1 },
  };
  const reference = {
    artifact_id: 'artifact',
    output_digest: digest('Checked brief'),
    context_generation: 'context',
    provider: 'codex',
  };
  let state = 'queued';
  const runs = {
    beginDelivery: vi.fn<BriefRunStore['beginDelivery']>(async (_context, _run, _generation, attempt) => {
      if (state !== 'queued') return { status: 'denied' as const };
      state = 'delivering';
      return { status: 'ok' as const, notification_id: 'brief-run', attempt_id: attempt, reference };
    }),
    deliveryCurrent: vi.fn<BriefRunStore['deliveryCurrent']>(async () => ({ status: 'ok' as const })),
    finishDelivery: vi.fn<BriefRunStore['finishDelivery']>(async (_context, _run, _generation, _attempt, outcome) => {
      state = outcome.state;
      return { status: 'ok' as const, state };
    }),
  };
  const artifacts = {
    get: vi.fn<BriefArtifacts['get']>(async () => ({
      status: 'ok' as const,
      artifact_id: 'artifact',
      text: 'Checked brief',
    })),
  };
  const current = vi.fn(() => context);
  const admitted = vi.fn(async () => true);
  const send = vi.fn(async () => 'post-id' as string | undefined);
  const delivery = new BriefDelivery({ runs, artifacts, current, admitted, send });
  return { delivery, runs, artifacts, current, admitted, send, context, reference };
}
it('S04 sends the checked artifact once with its stable notification identity', async () => {
  const f = fixture();
  expect((await f.delivery.deliver(f.context)).status).toBe('ok');
  expect(f.send).toHaveBeenCalledExactlyOnceWith(f.context, 'Checked brief', 'brief-run');
  expect(f.artifacts.get).toHaveBeenCalledWith(f.context, 'artifact', true);
  expect(f.runs.finishDelivery.mock.calls[0][4]).toEqual({ state: 'delivered', platform_receipt: 'post-id' });
  await f.delivery.deliver(f.context);
  expect(f.send).toHaveBeenCalledTimes(1);
});
it.each(['missing', 'throw', 'invalid'])(
  'S04 leaves %s transport receipts uncertain without resending',
  async (kind) => {
    const f = fixture();
    f.send.mockImplementation(async () => {
      if (kind === 'throw') throw Error('transport lost');
      return kind === 'missing' ? undefined : 'not a receipt';
    });
    await f.delivery.deliver(f.context);
    expect(f.runs.finishDelivery.mock.calls[0][4]).toEqual({ state: 'uncertain' });
    await f.delivery.deliver(f.context);
    expect(f.send).toHaveBeenCalledTimes(1);
  },
);
it.each(['channel', 'context', 'artifact', 'run', 'digest'])(
  'S04 revocation of %s after reservation prevents disclosure',
  async (kind) => {
    const f = fixture();
    if (kind === 'channel') f.admitted.mockResolvedValue(false);
    if (kind === 'context')
      f.admitted.mockImplementation(async () => {
        f.current.mockReturnValue({ ...f.context, generation: 'new' });
        return true;
      });
    if (kind === 'artifact') f.artifacts.get.mockResolvedValue({ status: 'denied' });
    if (kind === 'run') f.runs.deliveryCurrent.mockResolvedValue({ status: 'denied' });
    if (kind === 'digest') f.reference.output_digest = digest('unverified');
    await f.delivery.deliver(f.context);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.runs.finishDelivery.mock.calls[0][4]).toEqual({ state: 'failed', reason: 'admission_denied' });
  },
);
it('S04 unknown database acknowledgement never authorizes a transport retry', async () => {
  const f = fixture();
  f.runs.beginDelivery.mockResolvedValue({ status: 'pending' });
  expect((await f.delivery.deliver(f.context)).status).toBe('pending');
  expect(f.send).not.toHaveBeenCalled();
  expect(f.runs.finishDelivery).not.toHaveBeenCalled();
});
it('S04 rechecks source access after asynchronous channel validation', async () => {
  const f = fixture();
  f.admitted.mockImplementation(async () => {
    f.artifacts.get.mockResolvedValue({ status: 'denied' });
    return true;
  });
  await f.delivery.deliver(f.context);
  expect(f.send).not.toHaveBeenCalled();
});
it('S04 unknown final persistence leaves the consumed send fenced across another call', async () => {
  const f = fixture();
  f.runs.finishDelivery.mockResolvedValue({ status: 'pending' });
  expect((await f.delivery.deliver(f.context)).status).toBe('pending');
  await f.delivery.deliver(f.context);
  expect(f.send).toHaveBeenCalledTimes(1);
});
