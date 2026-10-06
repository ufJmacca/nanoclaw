import { expect, it } from 'vitest';
import { validRequest } from './protocol.js';
import { STATUS_CATEGORIES, validStatusInput } from './operations-protocol.js';
const request = {
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_status',
  params: {},
};
it('S11 uncertain action inspection selects one safe ID and cannot select authority or other records', () => {
  expect(validRequest({ ...request, params: { category: 'actions', id: 'action-' + 'a'.repeat(64) } })).toBe(true);
  for (const params of [
    { id: 'action-one' },
    { category: 'sources', id: 'source-one' },
    { category: 'actions', id: '../../private' },
    { category: 'actions', id: 'action-one', execute: true },
  ])
    expect(validRequest({ ...request, params })).toBe(false);
});
it('S11 status is a bounded read with no model-supplied scope, credentials or execution authority', () => {
  expect(validRequest(request)).toBe(true);
  for (const category of STATUS_CATEGORIES) {
    expect(validStatusInput({ category, limit: 20, offset: 10000 })).toBe(true);
    expect(validRequest({ ...request, params: { category, limit: 20, offset: 10000 } })).toBe(true);
  }
  for (const params of [
    { scope_id: 'foreign' },
    { owner_id: 'owner' },
    { category: 'secrets' },
    { limit: 21 },
    { offset: -1 },
    { offset: 10001 },
    { limit: 1.5 },
    { resume: true },
  ])
    expect(validRequest({ ...request, params })).toBe(false);
});
