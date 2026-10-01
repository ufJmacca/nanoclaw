import { expect, it } from 'vitest';
import { validRequest } from './protocol.js';
const request = {
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_brief_request',
};
it('S04 brief requests select a timezone or immutable artifact without granting authority', () => {
  expect(validRequest({ ...request, params: { time_zone: 'Australia/Sydney' } })).toBe(true);
  expect(validRequest({ ...request, params: { artifact_id: 'a'.repeat(64) + '-' + 'b'.repeat(64) } })).toBe(true);
  for (const params of [
    {},
    { time_zone: 'invalid/timezone' },
    { time_zone: '+10:00' },
    { time_zone: 'UTC', owner_id: 'forged' },
    { time_zone: 'UTC', run_id: 'forged' },
    { time_zone: 'UTC', artifact_id: 'a'.repeat(64) + '-' + 'b'.repeat(64) },
    { artifact_id: '../../secret' },
  ])
    expect(validRequest({ ...request, params })).toBe(false);
});
