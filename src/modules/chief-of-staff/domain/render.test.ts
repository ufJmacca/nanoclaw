import { describe, it, expect } from 'vitest';
import { renderPriorities } from './render.js';
describe('S01 grounded priority presentation', () => {
  it('links every approved priority to its source and labels attention advice', () => {
    const text = renderPriorities({
      status: 'ok',
      records: [
        {
          id: 'record-one',
          kind: 'goal',
          title: 'Launch a pilot',
          description: 'Reliability first',
          version: 1,
          provenance: { proposal_id: 'proposal-one' },
        },
      ],
    });
    expect(text).toContain('Launch a pilot');
    expect(text).toContain('record-one');
    expect(text).toContain('proposal-one');
    expect(text).toContain('advice');
    expect(text).toContain('Deterministic');
  });
  it('gives an explicit empty state without inventing priorities', () =>
    expect(renderPriorities({ status: 'ok', records: [] })).toContain('No approved priorities'));
  it('does not disclose cached records on dependency failure', () => {
    const text = renderPriorities({ status: 'unavailable', records: [{ title: 'private stale content' }] });
    expect(text).toContain('unavailable');
    expect(text).not.toContain('private stale');
  });
});
