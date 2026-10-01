import { expect, it } from 'vitest';
import { validProposalChange, validRequest } from './protocol.js';
import fs from 'node:fs';
it('packages the identical schedule authority contract into the worker', () => {
  expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/schedule-protocol.ts', 'utf8')).toBe(
    fs.readFileSync('src/modules/chief-of-staff/contracts/schedule-protocol.ts', 'utf8'),
  );
});
const change = {
  kind: 'brief_schedule',
  title: 'Weekday morning brief',
  reason: 'Owner requested a morning briefing',
  expected_version: 0,
  policy: {
    state: 'active',
    time_zone: 'Australia/Sydney',
    local_time: '09:00',
    weekdays: [1, 2, 3, 4, 5],
    quiet_hours: { start: '22:00', end: '08:00' },
    snooze_until: null,
  },
  limits: { max_turns: 2, max_tool_calls: 12, deadline_seconds: 120, refresh_seconds: 20 },
};
const request = {
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_brief_schedule_propose',
  params: { change },
};
it('S04-T10 only exact owner-approval proposals can define bounded brief schedules', () => {
  expect(validProposalChange(change)).toBe(true);
  expect(validRequest(request)).toBe(true);
  expect(validRequest({ ...request, params: { change, approved: true } })).toBe(false);
  expect(
    validProposalChange({
      ...change,
      record_id: 'schedule-1',
      expected_version: 2,
      policy: { ...change.policy, state: 'paused' },
    }),
  ).toBe(true);
});
it.each([
  { approved: true },
  { owner_id: 'forged' },
  { destination: 'foreign' },
  { script: 'send messages' },
  { recurrence: '* * * * *' },
  { expected_version: 1 },
  { record_id: 'unknown', expected_version: 0 },
  { limits: { ...change.limits, max_turns: 100 } },
  { limits: { ...change.limits, max_tool_calls: 1000 } },
  { limits: { ...change.limits, deadline_seconds: 301 } },
  { limits: { ...change.limits, refresh_seconds: 31 } },
  { limits: { ...change.limits, max_spend: 100 } },
  { policy: { ...change.policy, local_time: 'every minute' } },
  { policy: { ...change.policy, weekdays: [] } },
])('S04 rejects expanded schedule authority or unbounded policy: %j', (patch) => {
  expect(validProposalChange({ ...change, ...patch })).toBe(false);
  expect(validRequest({ ...request, params: { change: { ...change, ...patch } } })).toBe(false);
});
