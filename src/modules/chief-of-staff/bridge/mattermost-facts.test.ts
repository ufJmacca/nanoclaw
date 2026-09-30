import { describe, it, expect, vi } from 'vitest';
import { createMattermostFacts } from './mattermost-facts.js';
import type { CosBinding } from '../../../cos-boundary.js';
const binding = { instanceId: 'fixture', channelId: 'private', botId: 'bot', ownerId: 'owner' } as CosBinding;
function fixture() {
  const request = vi.fn().mockImplementation(async ({ url }: { url: string }) => ({
    status: 200,
    body: url.includes('/members')
      ? [{ user_id: 'bot' }, { user_id: 'owner' }]
      : url.endsWith('/users/me')
        ? { id: 'bot', is_bot: true, delete_at: 0 }
        : { id: 'private', type: 'P', delete_at: 0 },
  }));
  const facts = createMattermostFacts(
    { baseUrl: 'https://mattermost.invalid', botToken: 'synthetic-fixture-token', instanceKey: 'fixture' },
    { request },
    () => true,
  );
  return { request, facts };
}
describe('S01-UI01 authenticated current Mattermost facts', () => {
  it('checks bot identity and bounded current membership using only host GET requests', async () => {
    const f = fixture();
    expect(await f.facts(binding)).toMatchObject({
      id: 'private',
      type: 'P',
      members: ['bot', 'owner'],
      activeSubscription: true,
    });
    expect(f.request).toHaveBeenCalledTimes(3);
    for (const [request] of f.request.mock.calls) expect(request).toMatchObject({ method: 'GET', timeoutMs: 3000 });
    expect(f.request.mock.calls.some(([request]) => request.url.endsWith('/members?page=0&per_page=3'))).toBe(true);
  });
  it('fails closed on wrong authenticated bot or foreign instance without leaking transport errors', async () => {
    const f = fixture();
    f.request.mockResolvedValue({ status: 200, body: { id: 'foreign' } });
    await expect(f.facts(binding)).rejects.toThrow('CoS private channel verification unavailable');
    f.request.mockClear();
    await expect(f.facts({ ...binding, instanceId: 'foreign' })).rejects.toThrow(
      'CoS private channel verification unavailable',
    );
    expect(f.request).not.toHaveBeenCalled();
  });
  it('does not treat partial or unauthorised membership responses as private evidence', async () => {
    const f = fixture();
    f.request.mockResolvedValue({ status: 403, body: { message: 'secret synthetic diagnostic' } });
    await expect(f.facts(binding)).rejects.toThrow('CoS private channel verification unavailable');
  });
});
