import fs from 'node:fs';
import { expect, it } from 'vitest';
import {
  MISSION_WORKER_PROTOCOL,
  validMissionWorkerRequest,
  validMissionWorkerResponse,
  validMissionRpcEnvelope,
} from './mission-worker-protocol.js';
import { validRequest, validResponse } from './protocol.js';

const request = {
  protocol: 'cos-mission-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_mission_context_get',
  params: {},
};
it('accepts only the exact unrouted specialist delivery envelope', () => {
  const envelope = { action: 'cos_mission_rpc', request, delivery_id: request.request_id };
  expect(validMissionRpcEnvelope(envelope)).toBe(true);
  for (const patch of [
    { action: 'cos_rpc' },
    { delivery_id: '------------------------------------' },
    { session_id: 'sibling' },
    { request: { ...request, params: { source_id: 'sibling' } } },
  ])
    expect(validMissionRpcEnvelope({ ...envelope, ...patch })).toBe(false);
});
it('S05-T03 specialist wire accepts only its assigned context and result submission', () => {
  expect(MISSION_WORKER_PROTOCOL).toBe(request.protocol);
  expect(validMissionWorkerRequest(request)).toBe(true);
  const result = {
    format: 'cos-research-result/v1',
    outcome: 'blocked',
    claims: [],
    criteria: [{ id: 'tradeoffs', claim_ids: [] }],
    limitations: ['Insufficient admitted evidence.'],
  };
  expect(validMissionWorkerRequest({ ...request, method: 'cos_result_submit', params: { result } })).toBe(true);
  for (const patch of [
    { protocol: 'cos-rpc/v1' },
    { method: 'cos_context_get' },
    { method: 'cos_change_propose' },
    { method: 'send_message' },
    { request_id: 'bad' },
    { owner_id: 'forged' },
    { params: { source_id: 'sibling' } },
    { params: { mission_id: 'sibling' } },
    { params: { generation: 1 } },
    { params: { path: '/private' } },
  ])
    expect(validMissionWorkerRequest({ ...request, ...patch })).toBe(false);
  expect(validRequest(request)).toBe(false);
});
it('S05-T03 specialist responses reject coordinator, foreign delivery and oversized content', () => {
  const response = { protocol: MISSION_WORKER_PROTOCOL, request_id: request.request_id, status: 'ok', result: {} };
  expect(validMissionWorkerResponse(response, request.request_id)).toBe(true);
  expect(validResponse(response, request.request_id)).toBe(false);
  for (const patch of [
    { protocol: 'cos-rpc/v1' },
    { request_id: 'different' },
    { status: 'completed' },
    { result: 'x'.repeat(98304) },
    { approved: true },
  ])
    expect(validMissionWorkerResponse({ ...response, ...patch }, request.request_id)).toBe(false);
});
it('keeps host and specialist validators identical', () => {
  expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/mission-worker-protocol.ts', 'utf8')).toBe(
    fs.readFileSync('src/modules/chief-of-staff/contracts/mission-worker-protocol.ts', 'utf8'),
  );
});
