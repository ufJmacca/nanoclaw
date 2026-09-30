import { expect, it, vi } from 'vitest';
import { guardConversationAccess } from './conversation-access.js';
import { ChannelAccessRevoked } from './mattermost-facts.js';
import type { CosBinding } from '../../../cos-boundary.js';
const binding = { ownerId: 'owner', botId: 'bot', channelId: 'private' } as CosBinding;
const facts = { id: 'private', type: 'P', delete_at: 0, activeSubscription: true, members: ['owner', 'bot'] };
it('invalidates confirmed membership or subscription revocation but retains context during a transport outage', async () => {
  const invalidate = vi.fn();
  let active = true,
    members = facts.members;
  let error: Error | undefined;
  const read = guardConversationAccess({
    active: () => active,
    revoke: invalidate,
    facts: async () => {
      if (error) throw error;
      return { ...facts, members };
    },
  });
  expect(await read(binding)).toEqual(facts);
  error = new Error('transport unavailable');
  await expect(read(binding)).rejects.toThrow();
  expect(invalidate).not.toHaveBeenCalled();
  error = undefined;
  members = ['owner', 'bot', 'unexpected'];
  await expect(read(binding)).rejects.toThrow();
  expect(invalidate).toHaveBeenCalledTimes(1);
  members = facts.members;
  active = false;
  await expect(read(binding)).rejects.toThrow();
  expect(invalidate).toHaveBeenCalledTimes(2);
  active = true;
  error = new ChannelAccessRevoked();
  await expect(read(binding)).rejects.toThrow();
  expect(invalidate).toHaveBeenCalledTimes(3);
});
