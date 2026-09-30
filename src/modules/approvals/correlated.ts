import type { Session, MessagingGroup } from '../../types.js';
import { createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';

export type CorrelatedApproval = {
  id: string;
  session: Session;
  ownerId: string;
  destination: MessagingGroup;
  payload: Record<string, unknown>;
  text: string;
  expiresAt: string;
  validateDestination(): Promise<boolean>;
};
export async function requestCorrelatedApproval(request: CorrelatedApproval): Promise<boolean> {
  if (
    !/^cos-[a-zA-Z0-9-]{1,100}$/.test(request.id) ||
    !request.ownerId ||
    request.destination.channel_type !== 'mattermost' ||
    Date.parse(request.expiresAt) <= Date.now() ||
    !Number.isFinite(Date.parse(request.expiresAt)) ||
    !(await request.validateDestination())
  )
    return false;
  const adapter = getDeliveryAdapter();
  if (!adapter) return false;
  const payload = JSON.stringify({
    owner_id: request.ownerId,
    destination: request.destination.platform_id,
    intent: request.payload,
  });
  const existing = getPendingApproval(request.id);
  if (
    existing &&
    (existing.action !== 'cos_change' ||
      existing.payload !== payload ||
      existing.session_id !== request.session.id ||
      existing.expires_at !== request.expiresAt)
  )
    return false;
  createPendingApproval({
    approval_id: request.id,
    request_id: request.id,
    session_id: request.session.id,
    agent_group_id: request.session.agent_group_id,
    action: 'cos_change',
    payload,
    channel_type: request.destination.channel_type,
    platform_id: request.destination.platform_id,
    expires_at: request.expiresAt,
    created_at: new Date().toISOString(),
    title: 'Chief-of-Staff proposal',
    options_json: '[]',
  });
  if (!(await request.validateDestination())) return false;
  try {
    await adapter.deliver(
      'mattermost',
      request.destination.platform_id,
      null,
      'chat',
      JSON.stringify({ text: request.text }),
      undefined,
      request.id,
    );
    return true;
  } catch {
    return false;
  }
}
