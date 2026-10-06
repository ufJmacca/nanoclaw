import { expect, it } from 'vitest';
import { renderOperatorStatus } from './operator-status-render.js';
const result = {
  status: 'ok',
  format: 'cos-operator-status/v1',
  scope_state: 'active',
  execution_authority: 'inspection_only',
  categories: [
    { category: 'missions', states: { queued: 1, running: 2, blocked: 1, awaiting_review: 1, cancelled: 1 } },
    { category: 'actions', states: { outcome_uncertain: 1 } },
  ],
  category: 'missions',
  items: [
    {
      id: 'mission-one',
      state: 'running',
      purpose_ref: { kind: 'priority', id: 'goal-one' },
      authority_ref: { kind: 'proposal', id: 'proposal-one' },
      evidence_ref: { kind: 'mission', id: 'mission-one' },
    },
  ],
  next_offset: 20,
  monetary_usage: 'unavailable',
  unknown_mandate_reservations: 1,
  expired_worker_leases: 2,
  structural_reservations: { attempt: 2, model: 3, tool: 1 },
};
it('S11-T01 status leads with admission and attention, keeps states distinct and points to checked references', () => {
  const text = renderOperatorStatus(result, 'paused');
  expect(text).toContain('CoS status — admission paused');
  expect(text).toContain('outcome_uncertain: 1');
  expect(text).toContain('awaiting_review: 1');
  expect(text).toContain('Purpose: priority `goal-one`');
  expect(text).toContain('Authority: proposal `proposal-one`');
  expect(text).toContain('cos status missions offset 20');
  expect(text).toContain('Monetary usage: unavailable');
  expect(text).toContain('2 expired worker leases');
});
it('S11-T08 unavailable and malformed results cannot expose cached source text or arbitrary diagnostics', () => {
  for (const value of [
    { status: 'unavailable', text: 'PRIVATE_TEXT', error: 'PRIVATE_ERROR' },
    { ...result, items: [{ ...result.items[0], id: 'SECRET\n<@all>' }] },
    { ...result, categories: [{ category: 'missions', states: { PRIVATE_ERROR: 1 } }] },
  ]) {
    const text = renderOperatorStatus(value, 'closed');
    expect(text).toContain('Status unavailable');
    expect(text).not.toMatch(/PRIVATE|SECRET|<@all>/);
  }
});
