import { expect, test } from 'bun:test';
import { coordinatorRequestIdError, coordinatorRequestIdSchema } from './coordinator-request-id.js';
import { validRequest } from './generated/cos-protocol.js';
import { cosTools } from './chief-of-staff.js';

test('G05 request-ID guidance agrees with the compiled wire contract, including UUID version and variant', () => {
  const pattern = new RegExp(coordinatorRequestIdSchema.pattern);
  for (const request_id of [
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAA-AAAA-8AAA-BAAA-AAAAAAAAAAAA',
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-9111-8111-111111111111',
    '11111111-1111-4111-7111-111111111111',
    'a-descriptive-label',
  ]) {
    const valid = validRequest({
      protocol: 'cos-rpc/v1',
      request_id,
      method: 'cos_answer_prepare',
      params: { draft: { kind: 'answer', coverage: 'insufficient', claims: [] } },
    });
    expect(pattern.test(request_id)).toBe(valid);
    expect(coordinatorRequestIdError('cos_answer_prepare', { request_id }) === null).toBe(valid);
    expect(coordinatorRequestIdError('cos_mail_draft_create', { request_id }) === null).toBe(valid);
  }
  for (const name of ['cos_answer_prepare', 'cos_mail_draft_create']) {
    expect(
      (cosTools.find(({ tool }) => tool.name === name)!.tool.inputSchema.properties as Record<string, unknown>)
        .request_id,
    ).toEqual(coordinatorRequestIdSchema);
  }
});

test('G05 invalid-ID errors contain no supplied input and preserve the optional answer ID contract', () => {
  const privateInput = 'untrusted@example.test';
  const message = coordinatorRequestIdError('cos_mail_draft_create', { request_id: privateInput });
  expect(message).toContain('No operation was submitted');
  expect(message).not.toContain(privateInput);
  expect(coordinatorRequestIdError('cos_mail_draft_create', {})).toEqual(message);
  expect(coordinatorRequestIdError('cos_answer_prepare', {})).toBeNull();
  expect(coordinatorRequestIdError('cos_mail_draft_status', { request_id: privateInput })).toBeNull();
});
