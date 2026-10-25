/** Public argument guidance only. Never infer host authority or echo private input. */
export const coordinatorRequestIdSchema = {
  type: 'string',
  format: 'uuid',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  description:
    'A fresh valid UUID for a new operation, with version 1–8 and variant 8, 9, a or b. Reuse it unchanged only for the identical request. A descriptive label or the all-zero UUID is invalid.',
} as const;

const uuid = new RegExp(coordinatorRequestIdSchema.pattern);
const invalid =
  'Invalid request_id: supply a valid hyphenated UUID with version 1–8 and variant 8, 9, a or b. Use a fresh ID for a new operation and reuse it unchanged only for the identical request. No operation was submitted.';

export function coordinatorRequestIdError(tool: unknown, args: unknown): string | null {
  if (
    (tool !== 'cos_mail_draft_create' && tool !== 'cos_answer_prepare') ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  )
    return null;
  const requestId = (args as Record<string, unknown>).request_id;
  if (requestId === undefined && tool === 'cos_answer_prepare') return null;
  return typeof requestId === 'string' && uuid.test(requestId) ? null : invalid;
}
