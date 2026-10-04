import { expect, test } from 'bun:test';
import { mandateCoordinatorRequest, mandateCoordinatorTools } from './mandate-coordinator-tools.js';
test('S08 coordinator transports expose proposals and private activity; no execution, approval or trigger writer', () => {
  expect(mandateCoordinatorTools(async (request) => ({ ...request, status: 'ok' })).map((d) => d.tool.name)).toEqual([
    'cos_mandate_propose',
    'cos_mandate_activity',
  ]);
  const id = 'mandate-' + 'a'.repeat(64);
  expect(mandateCoordinatorRequest('cos_mandate_activity', { mandate_id: id, offset: 0 })?.params).toEqual({
    mandate_id: id,
    offset: 0,
  });
  for (const name of ['cos_mandate_trigger', 'cos_mandate_approve', 'cos_mandate_execute'])
    expect(mandateCoordinatorRequest(name, {})).toBeNull();
  for (const patch of [{ scope_id: 'forged' }, { owner_id: 'forged' }, { grant: true }, { offset: 10001 }])
    expect(mandateCoordinatorRequest('cos_mandate_activity', { mandate_id: id, ...patch })).toBeNull();
});
