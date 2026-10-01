import { expect, it } from 'vitest';
import { buildBriefSnapshot, renderBrief, type BriefInputs, type BriefWork } from './brief-snapshot.js';
const base: BriefInputs = {
  generatedAt: '2026-10-03T23:00:00Z',
  timeZone: 'Australia/Sydney',
  records: [],
  work: [],
  calendars: [],
  coverage: {
    knowledge: 'not_connected',
    calendar: 'not_connected',
    truncated: false,
    withheld: 0,
    refresh: 'not_requested',
  },
};
const work = (id: string, patch: Partial<BriefWork> = {}): BriefWork => ({
  id,
  version: 1,
  kind: 'commitment',
  state: 'confirmed',
  title: id,
  project_id: null,
  due: null,
  defer_until: null,
  evidence: [],
  ...patch,
});
it('S04 selects at most three stable attention items, excludes resolved/deferred work and never confirms suggestions', () => {
  const input = {
    ...base,
    work: [
      work('done', { state: 'completed' }),
      work('later', { state: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
      work('dismissed', { state: 'dismissed' }),
      work('future', { due: { kind: 'date', date: '2026-12-10', time_zone: 'Australia/Sydney' } }),
      work('a', { due: { kind: 'date', date: '2026-10-03', time_zone: 'Australia/Sydney' } }),
      work('b', { kind: 'decision', state: 'needed' }),
      work('c', { kind: 'decision', state: 'needed' }),
      work('d', { kind: 'decision', state: 'needed' }),
      work('no-date'),
    ],
  };
  const snapshot = buildBriefSnapshot(input);
  expect(snapshot.attention.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  expect(snapshot.commitments.map((x) => x.id)).toEqual(['a', 'future', 'no-date']);
  expect(snapshot.decisions.map((x) => x.id)).toEqual(['b', 'c', 'd']);
  expect(snapshot.suggested_work).toEqual([]);
  expect(JSON.stringify(snapshot)).not.toContain('dismissed');
  expect(buildBriefSnapshot({ ...input, work: [...input.work].reverse() })).toEqual(snapshot);
});
it('S04 preserves timezone date deadlines and ranks only currently active projects', () => {
  const snapshot = buildBriefSnapshot({
    ...base,
    records: [
      { id: 'inactive', kind: 'project', title: 'Hidden project', description: '', version: 2, lifecycle: 'inactive' },
      { id: 'active', kind: 'project', title: 'Current project', description: '', version: 3, lifecycle: 'active' },
    ],
    work: [
      work('hidden', { project_id: 'inactive' }),
      work('due', { due: { kind: 'date', date: '2026-10-04', time_zone: 'Australia/Sydney' } }),
    ],
  });
  expect(snapshot.commitments.map((x) => x.id)).toEqual(['due']);
  expect(snapshot.commitments[0].due).toEqual({ kind: 'date', date: '2026-10-04', time_zone: 'Australia/Sydney' });
  expect(snapshot.attention[0]).toMatchObject({
    id: 'due',
    reason: 'due_within_window',
    reference: { kind: 'work', work_id: 'due', version: 1 },
  });
  expect(snapshot.attention[1].reference).toEqual({ kind: 'record', record_id: 'active', version: 3 });
  expect(snapshot.window.time_max).toBe('2026-10-04T23:00:00Z');
});
it('S04 renders explicit empty/stale coverage and never claims an empty calendar means a free day', () => {
  const empty = renderBrief(buildBriefSnapshot(base));
  expect(empty).toContain('No confirmed commitments');
  expect(empty).toContain('Calendar: not connected');
  expect(empty).toContain('does not establish that nothing is scheduled');
  const stale = renderBrief(
    buildBriefSnapshot({
      ...base,
      coverage: { ...base.coverage, calendar: 'stale', refresh: 'failed', truncated: true, withheld: 2 },
    }),
  );
  expect(stale).toContain('Calendar: stale');
  expect(stale).toContain('Refresh: failed');
  expect(stale).toContain('Some eligible items are not shown');
  expect(stale).toContain('2 items withheld');
});
it('S04 carries exact event evidence and bounds every output section', () => {
  const event = {
    summary: 'Meeting',
    time_zone: 'UTC',
    start: { kind: 'instant' as const, instant: '2026-10-04T00:00:00Z', timeZone: 'UTC' },
    end: { kind: 'instant' as const, instant: '2026-10-04T01:00:00Z', timeZone: 'UTC' },
    evidence: { kind: 'source' as const, evidence_id: 'evidence-1' },
    source_version: 3,
    revision_id: 'revision-1',
    binding_id: 'binding',
    calendar_id: 'calendar',
    snapshot_id: 'snapshot',
  };
  const snapshot = buildBriefSnapshot({
    ...base,
    work: Array.from({ length: 20 }, (_, i) => work(String(i).padStart(2, '0'))),
    calendars: [
      { ...event, summary: 'Cancelled', status: 'cancelled' },
      ...Array.from({ length: 8 }, (_, i) => ({
        ...event,
        status: 'confirmed',
        evidence: { ...event.evidence, evidence_id: 'evidence-' + i },
      })),
    ],
  });
  expect(snapshot.commitments).toHaveLength(5);
  expect(snapshot.events).toHaveLength(5);
  expect(snapshot.events[0]).toMatchObject({ source_version: 3, revision_id: 'revision-1', snapshot_id: 'snapshot' });
  expect(snapshot.coverage.truncated).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain('Cancelled');
});
it('S04 computes the next local-day window across DST and escapes source text in the host rendering', () => {
  const snapshot = buildBriefSnapshot({
    ...base,
    generatedAt: '2026-10-03T14:00:00Z',
    work: [work('unsafe', { title: '@all [Click](https://invalid.example) **urgent**\nnext' })],
  });
  expect(snapshot.window.time_max).toBe('2026-10-04T13:00:00Z');
  const text = renderBrief(snapshot);
  expect(text).not.toContain('@all');
  expect(text).not.toContain('[Click](');
  expect(text).toContain('CoS brief');
});

it('S04 interprets an all-day event in its calendar timezone, not the brief display timezone', () => {
  const snapshot = buildBriefSnapshot({
    ...base,
    calendars: [
      {
        summary: 'All-day in LA',
        time_zone: 'America/Los_Angeles',
        start: { kind: 'date', date: '2026-10-03' },
        end: { kind: 'date', date: '2026-10-04' },
        status: 'confirmed',
        evidence: { kind: 'source', evidence_id: 'all-day' },
        source_version: 1,
        revision_id: 'revision',
        binding_id: 'binding',
        calendar_id: 'calendar',
        snapshot_id: 'snapshot',
      },
    ],
  });
  expect(snapshot.events).toHaveLength(1);
});
