import { expect, it, vi } from 'vitest';

import type { Session } from './types.js';

const admissionMocks = vi.hoisted(() => ({
  getAgentGroup: vi.fn(),
}));

vi.mock('./channels/mattermost-subscription.js', () => ({
  validateMattermostSessionForExecution: vi.fn(() => ({ strict: false })),
}));

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: admissionMocks.getAgentGroup,
}));

import { deliverSessionMessages } from './delivery.js';

it('keeps delivery intake closed until exclusive host startup opens it', async () => {
  const session: Session = {
    id: 'session-before-host-lease',
    agent_group_id: 'agent-before-host-lease',
    messaging_group_id: 'channel-before-host-lease',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-07-11T00:00:00.000Z',
  };

  await deliverSessionMessages(session);

  expect(admissionMocks.getAgentGroup).not.toHaveBeenCalled();
});
