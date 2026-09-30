import { describe, expect, it } from 'vitest';
import { validRequest } from './protocol.js';
import fs from 'node:fs';
const request = {
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_context_get',
  params: { view: 'today' },
};
describe('S01-T09 canonical bounded RPC contract', () => {
  it('packages the same canonical contract into the runner', () => {
    expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/cos-protocol.ts', 'utf8')).toBe(
      fs.readFileSync('src/modules/chief-of-staff/contracts/protocol.ts', 'utf8'),
    );
  });
  it('accepts the versioned on-demand context request', () => expect(validRequest(request)).toBe(true));
  it('rejects malformed change payloads at both wire endpoints', () => {
    expect(validRequest({ ...request, method: 'cos_change_propose', params: { change: { kind: 'goal' } } })).toBe(
      false,
    );
  });
  it.each([
    { ...request, protocol: 'cos-rpc/v2' },
    { ...request, method: 'sql' },
    { ...request, request_id: '../../foreign' },
    { ...request, userId: 'owner' },
    { ...request, scopeId: 'foreign' },
    { ...request, params: { view: 'today', ownerId: 'owner' } },
    { ...request, params: { view: 'all' } },
    { ...request, params: null },
    { ...request, params: [] },
  ])('rejects mismatched protocol, identity injection and unknown fields', (value) =>
    expect(validRequest(value)).toBe(false),
  );
  it('accepts an explicit operation status lookup', () =>
    expect(validRequest({ ...request, method: 'cos_request_status', params: { request_id: request.request_id } })).toBe(
      true,
    ));
  it('rejects a request that exceeds the byte limit', () =>
    expect(
      validRequest({
        ...request,
        method: 'cos_change_propose',
        params: { change: { description: 'x'.repeat(70000) } },
      }),
    ).toBe(false));
});
