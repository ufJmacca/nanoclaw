import { describe, it, expect, vi } from 'vitest';
import { CosOutbox } from './outbox.js';
import type { CosBinding } from '../../../cos-boundary.js';
const binding = { scopeId: 'scope', sessionId: 'session' } as CosBinding;
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
  expires_at: new Date(Date.now() + 60000).toISOString(),
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
