import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CosOutbox } from './outbox.js';
import type { CosBinding } from '../../../cos-boundary.js';
const binding = { scopeId: 'scope', sessionId: 'session' } as CosBinding;
const now = Date.parse('2026-10-06T21:00:00Z');
const change = {
  kind: 'goal',
  title: 'Launch pilot',
  description: 'Reliability first',
  reason: 'Owner direction',
  lifecycle: 'active',
  expected_version: 0,
};
const item = {
  id: 'preview-id',
  kind: 'approval_preview',
  session_id: 'session',
  expires_at: new Date(now + 60000).toISOString(),
  payload: {
    proposal_id: '11111111-1111-4111-8111-111111111111',
    confirmation_token: 'abcdefghijklmnopqrstuvwxyz123456',
    change,
  },
};
function fixture() {
  const store = {
    pendingOutbox: vi.fn().mockResolvedValue({ status: 'ok', items: [item] }),
    acknowledgePreview: vi.fn().mockResolvedValue({ status: 'ok' }),
    apply: vi.fn().mockResolvedValue({ status: 'ok' }),
  };
  const admitted = vi.fn().mockResolvedValue(true),
    preview = vi.fn().mockResolvedValue(true);
  return { store, admitted, preview, outbox: new CosOutbox({ store, admitted, preview }) };
}
describe('S01 native approval outbox reconciliation', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('S10 direction preview identifies the exact choice and preserves commitments, missions and calendar events', async () => {
    const f = fixture();
    const direction = {
      kind: 'strategy_direction',
      request: {
        review_id: 'review-' + 'a'.repeat(64),
        revision: 1,
        option_id: 'pause',
        expected_record_version: 7,
        expected_direction_version: 2,
        reason: 'Measure before expansion',
      },
      option: {
        id: 'pause',
        initiative_id: 'project-one',
        direction: 'pause',
        title: 'Pause expansion',
        trade_off: 'Smaller experiment',
        opportunity_cost: 'Less capacity for exploration',
        next_action: 'Ask separately about existing obligations',
      },
      charter_version: 1,
      snapshot_digest: 'a'.repeat(64),
      draft_digest: 'b'.repeat(64),
      result_artifact_id: 'c'.repeat(64) + '-' + 'd'.repeat(64),
      result_artifact_digest: 'd'.repeat(64),
    };
    const review_dependencies = { records: [{ id: 'project-one', version: 7 }], sources: [] };
    f.store.pendingOutbox.mockResolvedValue({
      status: 'ok',
      items: [{ ...item, payload: { ...item.payload, change: direction, review_dependencies } }],
    });
    await f.outbox.drain(binding);
    const text = f.preview.mock.calls[0][1].text as string;
    expect(text).toContain('Proposed strategic direction');
    expect(text).toContain('Existing commitments, missions and calendar events keep their approved states');
    expect(text).toContain('review_dependencies');
    expect(text).toContain('"expected_direction_version": 2');
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it('S10 previews selected versions and explains that an approved observation starts no work', async () => {
    const f = fixture(),
      observation = {
        kind: 'strategy_observation',
        charter_version: 1,
        initiative_id: 'project-one',
        target: { kind: 'outcome', id: 'result' },
        basis: 'unknown',
        signal: 'unknown',
        statement: 'Outcome not observed',
        observed_at: '2026-10-06T00:00:00Z',
        evidence: [],
        reason: 'Preserve uncertainty',
      },
      review_dependencies = { records: [{ id: 'project-one', version: 7 }], sources: [] };
    f.store.pendingOutbox.mockResolvedValue({
      status: 'ok',
      items: [{ ...item, payload: { ...item.payload, change: observation, review_dependencies } }],
    });
    await f.outbox.drain(binding);
    const text = f.preview.mock.calls[0][1].text as string;
    expect(text).toContain('Proposed strategic observation');
    expect(text).toContain('No tasks, missions, calendar events or recurring reviews are started');
    expect(text).toContain('review_dependencies');
    expect(text).toContain('"version": 7');
    expect(text).toContain('"basis": "unknown"');
    expect(text).toContain('cos approve ' + item.payload.proposal_id);
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it('S09 identifies the exact external calendar effect and explicitly states its narrow notification scope', async () => {
    const f = fixture();
    const action = {
      kind: 'calendar_action',
      action_id: 'action-' + 'a'.repeat(64),
      intent_digest: 'b'.repeat(64),
      event_id: 'c'.repeat(64),
      expires_at: item.expires_at.slice(0, 19) + 'Z',
      request: {
        kind: 'calendar_block',
        binding_id: item.payload.proposal_id,
        calendar_id: 'selected@example.test',
        start: '2026-10-06T22:00:00Z',
        end: '2026-10-06T23:00:00Z',
        time_zone: 'Australia/Sydney',
        title: 'Focus work',
        description: '',
        project_id: null,
        mission_id: null,
        attendees: [],
      },
    };
    f.store.pendingOutbox.mockResolvedValue({
      status: 'ok',
      items: [{ ...item, payload: { ...item.payload, change: action } }],
    });
    await f.outbox.drain(binding);
    const text = f.preview.mock.calls[0][1].text as string;
    expect(text).toContain('Proposed calendar block');
    expect(text).toContain('No guests, invitations or event reminders');
    for (const value of [
      action.request.calendar_id,
      action.request.start,
      action.request.end,
      action.request.time_zone,
      action.intent_digest,
    ])
      expect(text).toContain(value);
    expect(text).toContain('cos approve ' + item.payload.proposal_id + ' ' + item.payload.confirmation_token);
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it('renders all exact proposal fields and controls before acknowledging delivery', async () => {
    const f = fixture();
    await f.outbox.drain(binding);
    expect(f.preview).toHaveBeenCalledWith(
      binding,
      expect.objectContaining({
        id: 'cos-' + item.payload.proposal_id,
        change,
        sessionId: 'session',
        token: item.payload.confirmation_token,
      }),
    );
    const text = f.preview.mock.calls[0][1].text as string;
    for (const field of Object.keys(change)) expect(text).toContain(field);
    expect(text).toContain('cos approve ' + item.payload.proposal_id + ' ' + item.payload.confirmation_token);
    expect(f.store.acknowledgePreview).toHaveBeenCalledWith('scope', 'preview-id');
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it('retains failed preview delivery for reconciliation', async () => {
    const f = fixture();
    f.preview.mockResolvedValue(false);
    await f.outbox.drain(binding);
    expect(f.preview).toHaveBeenCalledOnce();
    expect(f.store.acknowledgePreview).not.toHaveBeenCalled();
  });
  it('withholds expired previews without acknowledging or applying them', async () => {
    const f = fixture();
    vi.mocked(Date.now).mockReturnValue(now + 60000);
    await f.outbox.drain(binding);
    expect(f.preview).not.toHaveBeenCalled();
    expect(f.store.acknowledgePreview).not.toHaveBeenCalled();
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it('applies only approved outbox work in a separate operation', async () => {
    const f = fixture();
    f.store.pendingOutbox.mockResolvedValue({ status: 'ok', items: [{ ...item, kind: 'proposal_apply' }] });
    await f.outbox.drain(binding);
    expect(f.store.apply).toHaveBeenCalledWith('scope', item.payload.proposal_id);
    expect(f.preview).not.toHaveBeenCalled();
  });
  it('does not disclose content after current authority changes', async () => {
    const f = fixture();
    f.admitted.mockResolvedValueOnce(true).mockResolvedValue(false);
    await f.outbox.drain(binding);
    expect(f.preview).not.toHaveBeenCalled();
    expect(f.store.apply).not.toHaveBeenCalled();
  });
});
