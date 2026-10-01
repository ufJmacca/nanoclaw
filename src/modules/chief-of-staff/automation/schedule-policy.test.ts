import { describe, it, expect } from 'vitest';
import {
  planBriefOccurrence,
  validBriefSchedulePolicy,
  type BriefSchedulePolicy,
  type ScheduleIdentity,
} from './schedule-policy.js';
const policy: BriefSchedulePolicy = {
  state: 'active',
  time_zone: 'Australia/Sydney',
  local_time: '09:00',
  weekdays: [1, 2, 3, 4, 5],
  quiet_hours: { start: '22:00', end: '08:00' },
  snooze_until: null,
};
const identity: ScheduleIdentity = {
  scopeId: 'scope',
  scheduleId: 'weekday',
  revision: 1,
  activatedAt: '2026-09-01T00:00:00Z',
  lastLocalDate: null,
};
describe('S04-T05 approved brief occurrence policy', () => {
  it('validates a narrow explicit local schedule and refuses malformed or expanded authority', () => {
    expect(validBriefSchedulePolicy(policy)).toBe(true);
    for (const patch of [
      { time_zone: '+11:00' },
      { local_time: '25:00' },
      { weekdays: [] },
      { weekdays: [1, 1] },
      { weekdays: [0] },
      { weekdays: [8] },
      { quiet_hours: { start: '09:00', end: '09:00' } },
      { snooze_until: 'tomorrow' },
      { owner_id: 'forged' },
      { state: 'running' },
    ])
      expect(validBriefSchedulePolicy({ ...policy, ...patch })).toBe(false);
  });
  it('uses local time and stable scope/revision/instant identity for repeated wakes', () => {
    const now = '2026-10-01T23:00:00Z'; // Friday 09:00 Sydney
    const a = planBriefOccurrence(policy, identity, now);
    expect(a.due).toMatchObject({ intendedAt: '2026-10-01T23:00:00.000Z', localDate: '2026-10-02' });
    expect(a.nextWakeAt).toBe('2026-10-04T22:00:00.000Z');
    expect(planBriefOccurrence(policy, identity, '2026-10-02T00:00:00Z').due?.key).toBe(a.due?.key);
    expect(planBriefOccurrence(policy, { ...identity, scopeId: 'other' }, now).due?.key).not.toBe(a.due?.key);
    expect(planBriefOccurrence(policy, { ...identity, revision: 2 }, now).due?.key).not.toBe(a.due?.key);
  });
  it('does not replay work before approval or run a second brief on the same actual local date', () => {
    const now = '2026-10-01T22:00:00Z';
    expect(planBriefOccurrence(policy, { ...identity, activatedAt: now }, now)).toEqual({
      due: null,
      nextWakeAt: '2026-10-01T23:00:00.000Z',
    });
    expect(planBriefOccurrence(policy, { ...identity, lastLocalDate: '2026-10-02' }, '2026-10-02T01:00:00Z')).toEqual({
      due: null,
      nextWakeAt: '2026-10-04T22:00:00.000Z',
    });
  });
  it('coalesces a long downtime into one current brief and counts its actual delivery date', () => {
    const now = '2026-10-04T21:15:00Z'; // Monday 08:15, before the new scheduled morning
    const plan = planBriefOccurrence(policy, { ...identity, lastLocalDate: '2026-09-01' }, now);
    expect(plan.due).toMatchObject({
      intendedAt: '2026-10-01T23:00:00.000Z',
      intendedLocalDate: '2026-10-02',
      localDate: '2026-10-05',
    });
    expect(
      planBriefOccurrence(policy, { ...identity, lastLocalDate: '2026-10-05' }, '2026-10-04T23:00:00Z').due,
    ).toBeNull();
  });
  it('holds current delivery during quiet hours and snooze and resumes without a backlog', () => {
    expect(planBriefOccurrence(policy, identity, '2026-10-01T13:00:00Z')).toEqual({
      due: null,
      nextWakeAt: '2026-10-01T22:00:00.000Z',
    });
    const snoozed = { ...policy, snooze_until: '2026-10-02T01:00:00Z' };
    expect(planBriefOccurrence(snoozed, identity, '2026-10-01T23:00:00Z')).toEqual({
      due: null,
      nextWakeAt: '2026-10-02T01:00:00.000Z',
    });
    expect(planBriefOccurrence(snoozed, identity, '2026-10-02T01:00:00Z').due?.localDate).toBe('2026-10-02');
    expect(planBriefOccurrence({ ...policy, state: 'paused' }, identity, '2026-10-01T23:00:00Z')).toEqual({
      due: null,
      nextWakeAt: null,
    });
  });
  it('shifts a nonexistent DST local time forward and runs once during a repeated local hour', () => {
    const daily = { ...policy, weekdays: [1, 2, 3, 4, 5, 6, 7], local_time: '02:30', quiet_hours: null };
    const gap = planBriefOccurrence(daily, identity, '2026-10-03T16:30:00Z');
    expect(gap.due).toMatchObject({ intendedAt: '2026-10-03T16:30:00.000Z', localDate: '2026-10-04' });
    const fall = { ...identity, activatedAt: '2026-03-01T00:00:00Z' };
    const first = planBriefOccurrence(daily, fall, '2026-04-04T15:30:00Z');
    expect(first.due).toMatchObject({ intendedAt: '2026-04-04T15:30:00.000Z', localDate: '2026-04-05' });
    expect(planBriefOccurrence(daily, { ...fall, lastLocalDate: '2026-04-05' }, '2026-04-04T16:30:00Z').due).toBeNull();
    expect(planBriefOccurrence(daily, fall, '2026-04-04T16:30:00Z').due?.key).toBe(first.due?.key);
  });
  it('fails closed on invalid clock and identity metadata', () => {
    for (const id of [
      { ...identity, revision: 0 },
      { ...identity, activatedAt: 'invalid' },
      { ...identity, lastLocalDate: '2026-02-30' },
    ])
      expect(() => planBriefOccurrence(policy, id, '2026-10-01T00:00:00Z')).toThrow();
    expect(() => planBriefOccurrence(policy, identity, 'invalid')).toThrow();
  });
  it('keeps quiet hours in force during the second repeated hour instead of choosing an end in the past', () => {
    const repeated = {
      ...policy,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      local_time: '01:00',
      quiet_hours: { start: '01:45', end: '02:15' },
    };
    expect(
      planBriefOccurrence(repeated, { ...identity, activatedAt: '2026-03-01T00:00:00Z' }, '2026-04-04T16:00:00Z'),
    ).toEqual({ due: null, nextWakeAt: '2026-04-04T16:15:00.000Z' });
  });
});
