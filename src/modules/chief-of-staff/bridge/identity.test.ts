import { describe, expect, it } from 'vitest';
import { verifyIngress, parseControl, parseStatusControl, type Binding, type ChannelFacts } from './identity.js';
import type { InboundEvent } from '../../../channels/adapter.js';
const binding: Binding = {
  scopeId: 'scope',
  ownerId: 'owner',
  botId: 'bot',
  instanceId: 'fixture',
  channelId: 'private',
  agentGroupId: 'group',
  messagingGroupId: 'mg',
  provider: 'codex',
};
const now = Date.parse('2026-09-29T12:00:00Z');
it('S11 status accepts exact bounded owner commands and ignores quoted or injected control text', () => {
  expect(parseStatusControl('cos status')).toEqual({});
  expect(parseStatusControl('cos status missions offset 20')).toEqual({ category: 'missions', offset: 20 });
  for (const text of [
    '> cos status',
    'please cos status',
    'cos status\nprivate',
    'cos status secrets',
    'cos status missions offset 01',
    'cos status missions offset 10001',
  ])
    expect(parseStatusControl(text)).toBeNull();
});
const facts: ChannelFacts = {
  id: 'private',
  type: 'P',
  delete_at: 0,
  members: ['bot', 'owner'],
  activeSubscription: true,
};
const event: InboundEvent = {
  channelType: 'mattermost',
  platformId: 'mattermost:fixture:private',
  threadId: null,
  message: {
    id: 'event',
    kind: 'chat',
    timestamp: new Date(now).toISOString(),
    content: JSON.stringify({ senderId: 'mattermost:owner', text: 'hello' }),
  },
};
describe('S01-UI01 verified private owner ingress', () => {
  it('accepts the authenticated owner and treats a thread only as presentation', () => {
    expect(verifyIngress(binding, facts, event, now)).toMatchObject({ id: 'event', ownerId: 'owner', text: 'hello' });
    expect(verifyIngress(binding, facts, { ...event, threadId: 'visual-thread' }, now)).not.toBeNull();
  });
  it.each([
    { ...facts, type: 'O' },
    { ...facts, members: ['bot', 'owner', 'other'] },
    { ...facts, members: ['owner'] },
    { ...facts, activeSubscription: false },
    { ...facts, delete_at: 1 },
  ])('S01-UI03 blocks changed membership, privacy or subscription', (changed) => {
    expect(verifyIngress(binding, changed, event, now)).toBeNull();
  });
  it.each([
    { ...event, channelType: 'telegram' },
    { ...event, platformId: 'mattermost:fixture:other' },
    {
      ...event,
      message: {
        ...event.message,
        content: JSON.stringify({ senderId: 'mattermost:bot', text: 'cos pause automation' }),
      },
    },
    { ...event, message: { ...event.message, timestamp: '2026-09-28T12:00:00Z' } },
  ])('S01-T04 blocks wrong channels, bots and stale ingress', (changed) => {
    expect(verifyIngress(binding, facts, changed, now)).toBeNull();
  });
  it('S01-UI02 parses only the complete exact command with bounded correlation', () => {
    expect(
      parseControl('cos approve 11111111-1111-4111-8111-111111111111 abcdefghijklmnopqrstuvwxyz123456'),
    ).toMatchObject({ kind: 'approve' });
    expect(parseControl('cos pause automation')).toEqual({ kind: 'pause' });
  });
  it.each([
    '> cos pause automation',
    'please run cos pause automation',
    '`cos pause automation`',
    'cos pause automation\nquoted text',
    'yes',
    'cos approve guessed fake',
  ])('S01-UI07 ignores quoted and ambiguous control text', (text) => {
    expect(parseControl(text)).toBeNull();
  });
});
