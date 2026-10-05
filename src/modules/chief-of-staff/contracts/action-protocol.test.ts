import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { validRequest } from './protocol.js';

const id = '11111111-1111-4111-8111-111111111111';
const request = {
  kind: 'calendar_block',
  binding_id: id,
  calendar_id: 'selected@example.test',
  start: '2026-10-05T22:00:00Z',
  end: '2026-10-05T23:00:00Z',
  time_zone: 'Australia/Sydney',
  title: 'Focus work',
  description: '',
  project_id: null,
  mission_id: null,
  attendees: [],
};
const rpc = { protocol: 'cos-rpc/v1', request_id: id, method: 'cos_action_propose', params: { request } };

describe('S09 exact calendar action wire boundary', () => {
  it('packages the identical narrow action contract into the runner', () => {
    expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/action-protocol.ts', 'utf8')).toBe(
      fs.readFileSync('src/modules/chief-of-staff/contracts/action-protocol.ts', 'utf8'),
    );
  });
  it('admits one precise private block proposal without approval or provider authority', () => {
    expect(validRequest(rpc)).toBe(true);
  });
  it('admits scoped action inspection and cancellation with stable identity', () => {
    for (const method of ['cos_action_get', 'cos_action_cancel'])
      expect(validRequest({ ...rpc, method, params: { action_id: 'action-' + 'a'.repeat(64) } })).toBe(true);
  });
  it('S09-T03 rejects guest, attachment, recurrence and generic API expansion', () => {
    for (const patch of [
      { attendees: ['guest@example.test'] },
      { attendees: [{ email: 'guest@example.test' }] },
      { attachments: [] },
      { conferenceData: {} },
      { recurrence: ['RRULE:FREQ=DAILY'] },
      { visibility: 'public' },
      { eventType: 'focusTime' },
      { location: 'A sensitive location' },
      { url: 'https://evil.example/insert' },
      { method: 'POST' },
      { provider_event_id: 'caller-chosen' },
      { calendar_id: 'primary' },
    ])
      expect(validRequest({ ...rpc, params: { request: { ...request, ...patch } } })).toBe(false);
  });
  it('rejects caller-supplied scope, approval, credentials and resource observations', () => {
    for (const patch of [
      { scope_id: 'other' },
      { owner_id: 'other' },
      { approved: true },
      { expires_at: '2099-01-01T00:00:00Z' },
      { observations: [] },
      { payload_hash: 'a'.repeat(64) },
      { access_token: 'not-a-real-token' },
    ]) {
      expect(validRequest({ ...rpc, params: { request: { ...request, ...patch } } })).toBe(false);
      expect(validRequest({ ...rpc, params: { request, ...patch } })).toBe(false);
    }
  });
  it('rejects missing, invalid, implicit local or unbounded times', () => {
    for (const patch of [
      { start: 'tomorrow' },
      { start: '2026-04-05T02:30:00' },
      { start: '2026-10-04T02:30:00' },
      { start: '2026-02-30T22:00:00Z' },
      { start: '2026-10-05T22:00:00-00:00' },
      { end: request.start },
      { end: '2026-10-05T21:00:00Z' },
      { end: '2026-10-07T23:00:00Z' },
      { time_zone: 'Invalid/Zone' },
      { time_zone: '+11:00' },
      { title: '' },
      { title: 'x'.repeat(121) },
      { title: 'Focus\u0000work' },
      { description: 'x'.repeat(501) },
      { project_id: '../foreign' },
      { mission_id: 'arbitrary-mission' },
    ])
      expect(validRequest({ ...rpc, params: { request: { ...request, ...patch } } })).toBe(false);
    const { attendees: _attendees, ...missing } = request;
    expect(validRequest({ ...rpc, params: { request: missing } })).toBe(false);
  });
  it('does not expose an approve, execute, delete or fresh-ID retry method to models', () => {
    for (const method of ['cos_action_approve', 'cos_action_execute', 'cos_action_delete', 'cos_action_retry'])
      expect(validRequest({ ...rpc, method })).toBe(false);
    for (const method of ['cos_action_get', 'cos_action_cancel'])
      for (const extra of [{ scope_id: 'other' }, { provider_event_id: 'new-id' }, { action_id: '../other' }])
        expect(validRequest({ ...rpc, method, params: { action_id: 'action-' + 'a'.repeat(64), ...extra } })).toBe(
          false,
        );
  });
});
