import { describe, expect, it, vi } from 'vitest';

const { isMattermostOwnedAgentGroup } = vi.hoisted(() => ({
  isMattermostOwnedAgentGroup: vi.fn(),
}));

vi.mock('../src/channels/mattermost-subscription.js', () => ({ isMattermostOwnedAgentGroup }));

import { assertGenericAgentGroupRegistrationAllowed, assertGenericChannelRegistrationAllowed } from './register.js';

describe('generic channel registration boundary', () => {
  it('rejects Mattermost before a caller can select or reuse an agent folder', () => {
    expect(() => assertGenericChannelRegistrationAllowed('mattermost')).toThrow(
      'Mattermost requires strict channel subscription',
    );
    expect(() => assertGenericChannelRegistrationAllowed('telegram')).not.toThrow();
  });

  it('rejects a generic channel when its selected agent is owned by Mattermost', () => {
    isMattermostOwnedAgentGroup.mockImplementation((agentGroupId) => agentGroupId === 'ag-mattermost-owned');

    expect(() => assertGenericAgentGroupRegistrationAllowed('ag-mattermost-owned')).toThrow(
      'Mattermost-owned agent groups cannot be reused by generic registration',
    );
    expect(() => assertGenericAgentGroupRegistrationAllowed('ag-telegram')).not.toThrow();
  });
});
