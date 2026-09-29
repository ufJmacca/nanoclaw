import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestCorrelatedApproval, type CorrelatedApproval } from './correlated.js';
const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), deliver: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ createPendingApproval: mocks.create, getPendingApproval: mocks.get }));
vi.mock('../../delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver: mocks.deliver }) }));
beforeEach(() => {
  mocks.create.mockReset().mockReturnValue(true);
  mocks.get.mockReset();
  mocks.deliver.mockReset().mockResolvedValue('fixture-message');
});
const fixture = (): CorrelatedApproval => ({
  id: 'cos-fixture',
  session: { id: 'session', agent_group_id: 'group' } as CorrelatedApproval['session'],
  ownerId: 'owner',
  destination: {
    id: 'private',
    channel_type: 'mattermost',
    platform_id: 'mattermost:fixture:private',
  } as CorrelatedApproval['destination'],
  payload: { proposal_id: 'fixture', hash: 'immutable' },
  text: 'Exact fixture preview',
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  validateDestination: async () => true,
});
describe('S01 correlated native approval projection', () => {
  it('persists stable owner/destination correlation before delivering an exact private preview', async () => {
    const request = fixture();
    expect(await requestCorrelatedApproval(request)).toBe(true);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        approval_id: request.id,
        action: 'cos_change',
        channel_type: 'mattermost',
        platform_id: request.destination.platform_id,
      }),
    );
    expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(mocks.deliver.mock.invocationCallOrder[0]);
    expect(mocks.deliver).toHaveBeenCalledWith(
      'mattermost',
      request.destination.platform_id,
      null,
      'chat',
      JSON.stringify({ text: request.text }),
      undefined,
      request.id,
    );
  });
  it('has no generic-admin or DM fallback when private destination validation fails', async () => {
    expect(await requestCorrelatedApproval({ ...fixture(), validateDestination: async () => false })).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
  it('retains pending state after a failed delivery', async () => {
    mocks.deliver.mockRejectedValue(new Error('transport failed'));
    expect(await requestCorrelatedApproval(fixture())).toBe(false);
    expect(mocks.create).toHaveBeenCalled();
  });
  it('refuses a reused ID whose immutable payload differs', async () => {
    mocks.get.mockReturnValue({ payload: 'different' });
    expect(await requestCorrelatedApproval(fixture())).toBe(false);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
