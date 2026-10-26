import { expect, it } from 'vitest';
import { parseMailReviewAdminArguments, isMailReviewAdminCommand } from './mail-review-admin-arguments.js';
const args = [
  'mail-review-configure',
  '--scope',
  'chief-of-staff',
  '--request-id',
  '11111111-1111-4111-8111-111111111111',
  '--manifest',
  '/private/review-policy.json',
];
it('accepts only an explicit initial owner configuration with a stable request and private manifest reference', () => {
  expect(parseMailReviewAdminArguments(args)).toEqual({
    command: 'mail-review-configure',
    scopeId: 'chief-of-staff',
    requestId: args[4],
    manifestFile: args[6],
  });
  expect(isMailReviewAdminCommand({ command: 'mail-review-configure' })).toBe(true);
});
it.each(
  [
    ['mail-review-resume', ...args.slice(1)],
    ['mail-review-disable', ...args.slice(1)],
    [...args, '--reset', 'true'],
    args.slice(0, -2),
    [...args.slice(0, -1), 'relative.json'],
    [...args.slice(0, -1), '/private/../review-policy.json'],
    [...args.slice(0, -1), '/private/policy\n.json'],
    [...args.slice(0, 3), '--scope', args[4], ...args.slice(5)],
    [args[0], args[1], args[2], args[3], 'not-a-request', ...args.slice(5)],
  ].map((input) => ({ input })),
)('rejects unsupported, ambiguous or noncanonical configuration input: $input', ({ input }) => {
  expect(() => parseMailReviewAdminArguments(input)).toThrow('invalid_admin_arguments');
});
