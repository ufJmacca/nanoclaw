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
  it('S02 packages the same answer contract into the runner', () => {
    expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/answer-protocol.ts', 'utf8')).toBe(
      fs.readFileSync('src/modules/chief-of-staff/contracts/answer-protocol.ts', 'utf8'),
    );
  });
  it('S02 accepts bounded answer preparation and artifact redisplay', () => {
    expect(
      validRequest({
        ...request,
        method: 'cos_answer_prepare',
        params: {
          draft: {
            kind: 'answer',
            coverage: 'not_applicable',
            claims: [],
            questions: ['Which project should we focus on?'],
            notice: 'approval_required',
          },
        },
      }),
    ).toBe(true);
    expect(
      validRequest({
        ...request,
        method: 'cos_answer_prepare',
        params: {
          draft: {
            kind: 'answer',
            coverage: 'limited',
            claims: [
              { kind: 'quote', text: 'Pilot Alpha', citations: [{ kind: 'source', evidence_id: request.request_id }] },
            ],
          },
        },
      }),
    ).toBe(true);
    expect(
      validRequest({
        ...request,
        method: 'cos_answer_get',
        params: { artifact_id: 'a'.repeat(64) + '-' + 'b'.repeat(64) },
      }),
    ).toBe(true);
  });
  it.each([
    {
      method: 'cos_answer_prepare',
      params: {
        draft: {
          kind: 'answer',
          coverage: 'limited',
          claims: [{ kind: 'inference', text: 'Uncited claim', citations: [] }],
        },
      },
    },
    {
      method: 'cos_answer_prepare',
      params: { draft: { kind: 'answer', coverage: 'insufficient', claims: [] }, scope_id: 'foreign' },
    },
    {
      method: 'cos_answer_prepare',
      params: { draft: { kind: 'answer', coverage: 'insufficient', claims: [], approved: true } },
    },
    { method: 'cos_answer_get', params: { artifact_id: '../private' } },
    { method: 'cos_answer_get', params: { artifact_id: 'a'.repeat(64) + '-' + 'b'.repeat(64), generation: 'forged' } },
  ])('S02 rejects uncited answers, host paths and answer authority overrides', (value) => {
    expect(validRequest({ ...request, ...value })).toBe(false);
  });
  it('packages the same canonical contract into the runner', () => {
    expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/cos-protocol.ts', 'utf8')).toBe(
      fs.readFileSync('src/modules/chief-of-staff/contracts/protocol.ts', 'utf8'),
    );
  });
  it('accepts the versioned on-demand context request', () => expect(validRequest(request)).toBe(true));
  it('S02 accepts bounded source retrieval and an exact owner-controlled revocation proposal', () => {
    expect(
      validRequest({
        ...request,
        method: 'cos_knowledge_search',
        params: { query: 'Pilot Alpha', limit: 5, offset: 0 },
      }),
    ).toBe(true);
    expect(
      validRequest({
        ...request,
        method: 'cos_source_get',
        params: { source_id: 'source-a', revision_id: request.request_id, ordinal: 0 },
      }),
    ).toBe(true);
    expect(
      validRequest({
        ...request,
        method: 'cos_source_change_propose',
        params: {
          change: {
            kind: 'source_revoke',
            source_id: 'source-a',
            expected_version: 1,
            reason: 'Owner withdrew access',
          },
        },
      }),
    ).toBe(true);
  });
  it.each([
    { method: 'cos_knowledge_search', params: { query: 'Pilot', scope_id: 'foreign' } },
    { method: 'cos_knowledge_search', params: { query: 'Pilot', provider: 'claude' } },
    { method: 'cos_knowledge_search', params: { query: 'Pilot', limit: 6 } },
    { method: 'cos_source_get', params: { source_id: '../private', revision_id: request.request_id, ordinal: 0 } },
    {
      method: 'cos_source_get',
      params: { source_id: 'source-a', revision_id: request.request_id, ordinal: 0, generation: 'forged' },
    },
    {
      method: 'cos_source_change_propose',
      params: { change: { kind: 'source_delete', source_id: 'source-a', expected_version: 0, reason: 'bad version' } },
    },
    {
      method: 'cos_source_change_propose',
      params: {
        change: {
          kind: 'source_delete',
          source_id: 'source-a',
          expected_version: 1,
          reason: 'bad authority',
          approved: true,
        },
      },
    },
  ])('S02 rejects retrieval authority overrides and malformed source operations', (value) =>
    expect(validRequest({ ...request, ...value })).toBe(false),
  );
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
