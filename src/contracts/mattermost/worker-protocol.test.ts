import { describe, expect, it } from 'vitest';

import {
  encodeMattermostContractWorkerEvent,
  MATTERMOST_CONTRACT_EVENT_PREFIX,
  parseMattermostContractWorkerCommand,
  parseMattermostContractWorkerEventLine,
} from './worker-protocol.js';

describe('Mattermost contract worker protocol', () => {
  it('accepts only bounded commands for the configured disposable instance', () => {
    expect(
      parseMattermostContractWorkerCommand(
        JSON.stringify({
          id: 'command-1',
          kind: 'deliver',
          platformId: 'mattermost:contract:channel-a',
          threadId: 'root-a',
          text: 'contract reply',
        }),
        'contract',
      ),
    ).toEqual({
      id: 'command-1',
      kind: 'deliver',
      platformId: 'mattermost:contract:channel-a',
      threadId: 'root-a',
      text: 'contract reply',
    });

    for (const candidate of [
      '{',
      JSON.stringify({ id: 'command-2', kind: 'deliver', platformId: 'mattermost:other:channel-a', text: 'x' }),
      JSON.stringify({ id: 'command-3', kind: 'deliver', platformId: 'mattermost:contract:../escape', text: 'x' }),
      JSON.stringify({
        id: 'command-4',
        kind: 'deliver',
        platformId: 'mattermost:contract:channel-a',
        text: 'x'.repeat(20_001),
      }),
      JSON.stringify({ id: 'command-5', kind: 'shutdown', unexpected: true }),
    ]) {
      expect(() => parseMattermostContractWorkerCommand(candidate, 'contract')).toThrow(
        'Mattermost contract worker command was invalid',
      );
    }
  });

  it('parses snapshot, deactivation, and shutdown control without accepting foreign fields', () => {
    expect(
      parseMattermostContractWorkerCommand(JSON.stringify({ id: 'command-snapshot', kind: 'snapshot' }), 'contract'),
    ).toEqual({ id: 'command-snapshot', kind: 'snapshot' });
    expect(
      parseMattermostContractWorkerCommand(
        JSON.stringify({ id: 'command-deactivate', kind: 'deactivate', channelId: 'channel-a' }),
        'contract',
      ),
    ).toEqual({ id: 'command-deactivate', kind: 'deactivate', channelId: 'channel-a' });
    expect(
      parseMattermostContractWorkerCommand(JSON.stringify({ id: 'command-shutdown', kind: 'shutdown' }), 'contract'),
    ).toEqual({ id: 'command-shutdown', kind: 'shutdown' });
  });

  it('emits bounded prefixed events without credential-bearing fields', () => {
    expect(
      encodeMattermostContractWorkerEvent({
        kind: 'inbound',
        postId: 'post-a',
        platformId: 'mattermost:contract:channel-a',
        threadId: 'root-a',
      }),
    ).toBe(
      `${MATTERMOST_CONTRACT_EVENT_PREFIX}{"kind":"inbound","postId":"post-a","platformId":"mattermost:contract:channel-a","threadId":"root-a"}`,
    );

    for (const event of [
      { kind: 'error', token: 'synthetic-contract-token' },
      { kind: 'error', nested: { authorization: 'Bearer synthetic' } },
      { kind: 'error', message: 'x'.repeat(65_537) },
    ]) {
      expect(() => encodeMattermostContractWorkerEvent(event)).toThrow('Mattermost contract worker event was unsafe');
    }
    expect(() =>
      encodeMattermostContractWorkerEvent({ kind: 'error', message: 'request failed with synthetic-contract-token' }, [
        'synthetic-contract-token',
      ]),
    ).toThrow('Mattermost contract worker event was unsafe');
  });

  it('ignores ordinary logs while strictly parsing prefixed worker events', () => {
    expect(parseMattermostContractWorkerEventLine('Central DB initialized')).toBeNull();
    expect(() =>
      parseMattermostContractWorkerEventLine('unexpected log synthetic-contract-token', ['synthetic-contract-token']),
    ).toThrow('Mattermost contract worker event was invalid');
    expect(
      parseMattermostContractWorkerEventLine(
        `${MATTERMOST_CONTRACT_EVENT_PREFIX}{"kind":"ready","instanceKey":"contract","pid":123}`,
      ),
    ).toEqual({ kind: 'ready', instanceKey: 'contract', pid: 123 });
    expect(() => parseMattermostContractWorkerEventLine(`${MATTERMOST_CONTRACT_EVENT_PREFIX}{`)).toThrow(
      'Mattermost contract worker event was invalid',
    );
    expect(() =>
      parseMattermostContractWorkerEventLine(
        `${MATTERMOST_CONTRACT_EVENT_PREFIX}{"kind":"error","botToken":"synthetic"}`,
      ),
    ).toThrow('Mattermost contract worker event was invalid');
  });
});
