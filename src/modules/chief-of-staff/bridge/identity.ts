import type { InboundEvent } from '../../../channels/adapter.js';
import { validStatusInput, type StatusInput } from '../contracts/operations-protocol.js';

export type Binding = {
  scopeId: string;
  ownerId: string;
  botId: string;
  instanceId: string;
  channelId: string;
  agentGroupId: string;
  messagingGroupId: string;
  provider: 'codex' | 'claude';
};
export type ChannelFacts = {
  id: string;
  type: string;
  delete_at: number;
  members: string[];
  activeSubscription: boolean;
};
export type VerifiedIngress = { id: string; ownerId: string; text: string; timestamp: string };
export function validPrivateChannel(binding: Binding, facts: ChannelFacts): boolean {
  return (
    facts.id === binding.channelId &&
    facts.type === 'P' &&
    facts.delete_at === 0 &&
    facts.activeSubscription &&
    binding.ownerId !== binding.botId &&
    facts.members.length === 2 &&
    facts.members.includes(binding.ownerId) &&
    facts.members.includes(binding.botId)
  );
}
/** Only call with an adapter-originated event and freshly fetched host-side facts. */
export function verifyIngress(
  binding: Binding,
  facts: ChannelFacts,
  event: InboundEvent,
  now: number,
): VerifiedIngress | null {
  if (
    event.channelType !== 'mattermost' ||
    event.platformId !== `mattermost:${binding.instanceId}:${binding.channelId}` ||
    !validPrivateChannel(binding, facts) ||
    event.message.kind !== 'chat' ||
    !event.message.id ||
    event.message.id.length > 200
  )
    return null;
  const timestamp = Date.parse(event.message.timestamp);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now) || timestamp > now + 30_000 || timestamp < now - 300_000)
    return null;
  try {
    const content = JSON.parse(event.message.content);
    if (
      content === null ||
      typeof content !== 'object' ||
      Array.isArray(content) ||
      content.senderId !== `mattermost:${binding.ownerId}` ||
      typeof content.text !== 'string' ||
      Buffer.byteLength(content.text) > 16_000
    )
      return null;
    return { id: event.message.id, ownerId: binding.ownerId, text: content.text, timestamp: event.message.timestamp };
  } catch {
    return null;
  }
}
export type Control = { kind: 'approve' | 'reject'; proposalId: string; token: string } | { kind: 'pause' };
export function parseControl(text: string): Control | null {
  if (text === 'cos pause automation') return { kind: 'pause' };
  const match =
    /^cos (approve|reject) ([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) ([A-Za-z0-9_-]{32})$/i.exec(
      text,
    );
  if (!match || match[0] !== text) return null;
  return { kind: match[1].toLowerCase() as 'approve' | 'reject', proposalId: match[2], token: match[3] };
}
/** Exact deterministic owner command, including bounded continuation. Quoted prose is never a control. */
export function parseStatusControl(text: string): StatusInput | null {
  if (text === 'cos status') return {};
  const match = /^cos status ([a-z_]+)(?: offset (0|[1-9][0-9]{0,4}))?$/.exec(text);
  if (!match || match[0] !== text) return null;
  const value = { category: match[1], ...(match[2] !== undefined ? { offset: Number(match[2]) } : {}) };
  return validStatusInput(value) ? value : null;
}
