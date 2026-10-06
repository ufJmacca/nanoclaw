/** Inspection accepts only a bounded category/page. Authority always comes from the host. */
export const STATUS_CATEGORIES = [
  'priorities',
  'work',
  'proposals',
  'missions',
  'attempts',
  'teams',
  'mandates',
  'actions',
  'action_receipts',
  'operations',
  'sources',
  'schedules',
  'reviews',
  'outbox',
] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];
export type StatusInput = { category?: StatusCategory; offset?: number; limit?: number };
export function validStatusInput(value: unknown): value is StatusInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((key) => ['category', 'offset', 'limit'].includes(key)) &&
    (v.category === undefined || STATUS_CATEGORIES.includes(v.category as StatusCategory)) &&
    (v.offset === undefined ||
      (Number.isSafeInteger(v.offset) && Number(v.offset) >= 0 && Number(v.offset) <= 10000)) &&
    (v.limit === undefined || (Number.isSafeInteger(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 20))
  );
}
