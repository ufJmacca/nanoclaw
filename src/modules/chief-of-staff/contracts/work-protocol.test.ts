import { describe, expect, it } from 'vitest';
import { validProposalChange, validRequest } from './protocol.js';

const change = {
  kind: 'commitment',
  title: 'Prepare the pilot review',
  description: 'Bring the agreed evidence to the review.',
  reason: 'Proposed follow-up from the owner conversation',
  state: 'confirmed',
  project_id: null,
  due: { kind: 'date', date: '2026-10-05', time_zone: 'Australia/Sydney' },
  defer_until: null,
  evidence: [],
  expected_version: 0,
};
const request = {
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_work_change_propose',
  params: { change },
};
describe('S04-T03/T04 exact work proposals', () => {
  it('admits an explicit proposed commitment without treating its label as owner approval', () => {
    expect(validProposalChange(change)).toBe(true);
    expect(validRequest(request)).toBe(true);
    expect(validRequest({ ...request, params: { change, approved: true } })).toBe(false);
  });
  it('distinguishes date-only deadlines from absolute instants in an explicit timezone', () => {
    expect(validProposalChange({ ...change, due: null })).toBe(true);
    expect(
      validProposalChange({
        ...change,
        due: { kind: 'instant', at: '2026-10-05T22:00:00Z', time_zone: 'Australia/Sydney' },
      }),
    ).toBe(true);
    expect(validProposalChange({ ...change, due: { kind: 'date', date: '2028-02-29', time_zone: 'UTC' } })).toBe(true);
  });
  it('requires exact record/version identity for owner dispositions and edits', () => {
    for (const state of ['confirmed', 'completed', 'dismissed'])
      expect(validProposalChange({ ...change, record_id: 'work-1', expected_version: 2, state })).toBe(true);
    expect(
      validProposalChange({
        ...change,
        record_id: 'work-1',
        expected_version: 2,
        state: 'deferred',
        defer_until: '2026-10-06T00:00:00Z',
      }),
    ).toBe(true);
    expect(validProposalChange({ ...change, state: 'completed' })).toBe(false);
    expect(validProposalChange({ ...change, state: 'deferred', defer_until: '2026-10-06T00:00:00Z' })).toBe(false);
  });
  it('supports open decision proposals and exact decisions without conflating their states with commitments', () => {
    expect(validProposalChange({ ...change, kind: 'decision', state: 'needed' })).toBe(true);
    expect(
      validProposalChange({
        ...change,
        kind: 'decision',
        state: 'decided',
        record_id: 'decision-1',
        expected_version: 1,
      }),
    ).toBe(true);
    expect(validProposalChange({ ...change, kind: 'decision', state: 'confirmed' })).toBe(false);
    expect(validProposalChange({ ...change, state: 'needed' })).toBe(false);
  });
  it('accepts bounded versioned evidence and an explicit project relationship', () => {
    expect(
      validProposalChange({
        ...change,
        project_id: 'pilot',
        evidence: [{ kind: 'record', record_id: 'pilot', version: 1 }],
      }),
    ).toBe(true);
    expect(validProposalChange({ ...change, evidence: [{ kind: 'source', evidence_id: request.request_id }] })).toBe(
      true,
    );
  });
  it('accepts bounded work views and exact historical revisions, without caller authority', () => {
    const read = (params: unknown) => validRequest({ ...request, method: 'cos_work_read', params });
    expect(read({ view: 'open' })).toBe(true);
    expect(read({ view: 'all', offset: 10 })).toBe(true);
    expect(read({ record_id: 'work-1' })).toBe(true);
    expect(read({ record_id: 'work-1', version: 2 })).toBe(true);
    for (const params of [
      {},
      { view: 'urgent' },
      { view: 'open', offset: -1 },
      { view: 'all', offset: 10001 },
      { record_id: 'work-1', version: 0 },
      { record_id: 'work-1', view: 'all' },
      { view: 'open', owner_id: 'forged' },
    ])
      expect(read(params)).toBe(false);
  });
  it.each([
    { owner_id: 'forged' },
    { scope_id: 'foreign' },
    { approved: true },
    { priority: 'urgent' },
    { expected_version: 1 },
    { record_id: 'work-1' },
    { record_id: '../private', expected_version: 1 },
    { record_id: 'work-1', expected_version: 1.5 },
    { state: 'deferred' },
    { defer_until: '2026-10-06T00:00:00Z' },
    { due: { kind: 'date', date: '2026-02-29', time_zone: 'UTC' } },
    { due: { kind: 'date', date: '2026-04-31', time_zone: 'UTC' } },
    { due: { kind: 'date', date: '2026-10-05', time_zone: '+11:00' } },
    { due: { kind: 'date', date: '2026-10-05', time_zone: 'unknown/place' } },
    { due: { kind: 'instant', at: '2026-10-04T02:30:00', time_zone: 'Australia/Sydney' } },
    { due: { kind: 'instant', at: '2026-02-30T00:00:00Z', time_zone: 'UTC' } },
    { due: { kind: 'date', date: 'tomorrow', time_zone: 'UTC' } },
    { due: { kind: 'date', date: '2026-10-05', time_zone: 'UTC', url: 'https://example.test' } },
    { title: ' ' },
    { title: 'NUL\u0000' },
    { description: '\ud800' },
    { description: 'x'.repeat(8001) },
    { evidence: Array(11).fill({ kind: 'record', record_id: 'pilot', version: 1 }) },
    { evidence: [{ kind: 'record', record_id: 'pilot', version: 0 }] },
    { evidence: [{ kind: 'source', evidence_id: request.request_id, scope_id: 'foreign' }] },
  ])('rejects malformed work or model-supplied authority: %j', (patch) => {
    expect(validProposalChange({ ...change, ...patch })).toBe(false);
    expect(validRequest({ ...request, params: { change: { ...change, ...patch } } })).toBe(false);
  });
});
