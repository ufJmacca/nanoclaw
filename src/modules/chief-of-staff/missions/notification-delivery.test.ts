import { expect, it, vi } from 'vitest';
import { MissionNotificationDelivery } from './notification-delivery.js';
import type { MissionNotifications } from './notifications.js';
import { renderMissionNotification } from './notifications.js';

function fixture() {
  const context = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'main',
    ingressId: 'owner-event',
    provider: 'codex',
    generation: 'context',
  };
  let used = false;
  const notifications = {
    begin: vi.fn<MissionNotifications['begin']>(async () => {
      if (used) return { status: 'denied' };
      used = true;
      return { status: 'ok', notification_id: 'mission-review-review' };
    }),
    read: vi.fn<MissionNotifications['read']>(async () => ({ status: 'ok', text: 'Reviewed partial research' })),
    finish: vi.fn<MissionNotifications['finish']>(async (_c, _r, _a, receipt) => ({
      status: 'ok',
      state: receipt.state,
    })),
  };
  const admitted = vi.fn(async () => true),
    current = vi.fn(() => context),
    send = vi.fn(async (): Promise<string | undefined> => 'post-id');
  const delivery = new MissionNotificationDelivery({ notifications, admitted, current, send });
  return { context, notifications, admitted, current, send, delivery };
}
it('S05-T08 sends a reviewed result once using its durable notification identity', async () => {
  const f = fixture();
  expect((await f.delivery.deliver(f.context, 'review')).state).toBe('delivered');
  expect(f.send).toHaveBeenCalledExactlyOnceWith(f.context, 'Reviewed partial research', 'mission-review-review');
  await f.delivery.deliver(f.context, 'review');
  expect(f.send).toHaveBeenCalledTimes(1);
});
it.each(['channel', 'context', 'source', 'database'])(
  'S05-T07 %s uncertainty prevents result delivery',
  async (failure) => {
    const f = fixture();
    if (failure === 'channel') f.admitted.mockResolvedValue(false);
    if (failure === 'context') f.current.mockReturnValue({ ...f.context, generation: 'replaced' });
    if (failure === 'source')
      f.admitted.mockImplementation(async () => {
        f.notifications.read.mockResolvedValue({ status: 'denied' });
        return true;
      });
    if (failure === 'database') f.notifications.begin.mockResolvedValue({ status: 'pending' });
    await f.delivery.deliver(f.context, 'review');
    expect(f.send).not.toHaveBeenCalled();
  },
);
it.each(['throw', 'missing', 'invalid'])(
  'S05-T06 %s platform receipt stays uncertain without automatic resend',
  async (failure) => {
    const f = fixture();
    f.send.mockImplementation(async () => {
      if (failure === 'throw') throw Error('unknown send');
      return failure === 'missing' ? undefined : 'bad receipt';
    });
    expect((await f.delivery.deliver(f.context, 'review')).state).toBe('uncertain');
    await f.delivery.deliver(f.context, 'review');
    expect(f.send).toHaveBeenCalledTimes(1);
  },
);
it('S05-T06 lost receipt persistence does not reopen the consumed send grant', async () => {
  const f = fixture();
  f.notifications.finish.mockResolvedValue({ status: 'pending' });
  expect((await f.delivery.deliver(f.context, 'review')).status).toBe('pending');
  await f.delivery.deliver(f.context, 'review');
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('S05-T08 renders labelled evidence and limitations without mentions or source-controlled markdown escapes', () => {
  const output = renderMissionNotification('mission', 'blocked', {
    format: 'cos-research-result/v1',
    outcome: 'partial',
    claims: [
      {
        id: 'claim',
        kind: 'inference',
        text: '```\n@all [untrusted](https://fixture.invalid)',
        citations: [{ source_id: 'note', revision_id: 'rev', ordinal: 0, start_line: 1, end_line: 2 }],
      },
    ],
    criteria: [{ id: 'criterion', claim_ids: ['claim'] }],
    limitations: ['Evidence is incomplete.'],
  });
  expect(output).toContain('Research result — blocked');
  expect(output).toContain('not accepted as a completed answer');
  expect(output).toContain('````\n```\n＠all');
  expect(output).not.toContain('@all');
  expect(output).toContain('revision rev, chunk 0, L1–L2');
  expect(output).toContain('Evidence is incomplete.');
});
