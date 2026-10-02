import { expect, it } from 'vitest';
import { COS_PROTOCOL, COS_MAX_BYTES, validResponse } from '../contracts/protocol.js';
import { teamReviewPayload } from './team-review-payload.js';
import type { TeamReviewSnapshot } from './team-snapshot.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const fixture = () =>
  ({
    root: { id: 'team-fixture', state: 'awaiting_review', version: 1 },
    anchor: { id: requestId },
    resultDigest: 'a'.repeat(64),
    brief: { content: '' },
    order: { body: { request: { acceptance_criteria: [{ id: 'criterion', description: 'Admitted criterion' }] } } },
  }) as unknown as TeamReviewSnapshot;
const response = (result: unknown) => ({ protocol: COS_PROTOCOL, request_id: requestId, status: 'ok', result });

it('S06 bounds the complete coordinator envelope including duplicated criteria and review metadata', () => {
  const snapshot = fixture(),
    original = teamReviewPayload(snapshot)!;
  const overhead = Buffer.byteLength(JSON.stringify(response(original)));
  (snapshot.brief as unknown as { content: string }).content = 'x'.repeat(COS_MAX_BYTES - overhead);
  const exact = teamReviewPayload(snapshot)!;
  expect(exact).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(response(exact)))).toBe(COS_MAX_BYTES);
  expect(validResponse(response(exact), requestId)).toBe(true);
  (snapshot.brief as unknown as { content: string }).content += 'x';
  expect(Buffer.byteLength(JSON.stringify(snapshot.brief))).toBeLessThan(COS_MAX_BYTES);
  const retained = structuredClone(snapshot);
  expect(teamReviewPayload(snapshot)).toBeNull();
  expect(snapshot).toEqual(retained);
});
it('S06 counts UTF-8 bytes and the recorded review without truncating evidence', () => {
  const snapshot = fixture();
  (snapshot.brief as unknown as { content: string }).content = 'é'.repeat(32000);
  expect(teamReviewPayload(snapshot)).not.toBeNull();
  expect(teamReviewPayload(snapshot, { id: requestId, checks: 'x'.repeat(2000), decision: 'partial' })).toBeNull();
  expect((snapshot.brief as unknown as { content: string }).content.length).toBe(32000);
});
