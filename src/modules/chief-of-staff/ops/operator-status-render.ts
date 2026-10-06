import { STATUS_CATEGORIES } from '../contracts/operations-protocol.js';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_:-]{1,200}$/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const ref = (v: unknown) => object(v) && id(v.id) && typeof v.kind === 'string' && /^[a-z_]{1,32}$/.test(v.kind);
const unavailable = (admission: string) =>
  `CoS status — admission ${admission}\n\nStatus unavailable. Current database authority could not be verified; private records are withheld. Inspection does not resume work.`;
/** Plain host-rendered metadata. No raw error, prose, provider response or approval secret is interpolated. */
export function renderOperatorStatus(value: unknown, admission: 'paused' | 'closed' | 'open'): string {
  if (
    !object(value) ||
    value.status !== 'ok' ||
    value.format !== 'cos-operator-status/v1' ||
    value.execution_authority !== 'inspection_only' ||
    !Array.isArray(value.categories) ||
    value.categories.length > STATUS_CATEGORIES.length ||
    value.categories.some(
      (c) =>
        !object(c) ||
        !STATUS_CATEGORIES.includes(c.category as (typeof STATUS_CATEGORIES)[number]) ||
        !object(c.states) ||
        Object.entries(c.states).some(([state, n]) => !/^[a-z_]{1,40}$/.test(state) || !count(n)),
    ) ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    value.items.some(
      (item) =>
        !object(item) ||
        !id(item.id) ||
        typeof item.state !== 'string' ||
        !/^[a-z_]{1,40}$/.test(item.state) ||
        !ref(item.purpose_ref) ||
        !ref(item.authority_ref) ||
        !ref(item.evidence_ref),
    )
  )
    return unavailable(admission);
  const lines = [`CoS status — admission ${admission}`, '', 'Progress and pending decisions'];
  for (const c of value.categories as Array<{ category: string; states: Record<string, number> }>) {
    const entries = Object.entries(c.states);
    lines.push(
      `${c.category}: ${entries.length ? entries.map(([state, n]) => `${state}: ${n}`).join(', ') : 'none recorded'}`,
    );
  }
  if (count(value.unknown_mandate_reservations) && count(value.expired_worker_leases)) {
    lines.push(
      '',
      `Needs reconciliation: ${value.unknown_mandate_reservations} unknown mandate reservations; ${value.expired_worker_leases} expired worker leases.`,
    );
  }
  if (object(value.structural_reservations)) {
    const entries = Object.entries(value.structural_reservations).filter(
      ([kind, n]) => ['attempt', 'model', 'tool'].includes(kind) && count(n),
    );
    lines.push(
      `Reserved structural usage: ${entries.length ? entries.map(([kind, n]) => `${kind}: ${n}`).join(', ') : 'none recorded'}.`,
    );
  }
  lines.push('Monetary usage: unavailable.', '');
  for (const item of value.items as Array<{
    id: string;
    state: string;
    purpose_ref: { kind: string; id: string };
    authority_ref: { kind: string; id: string };
    evidence_ref: { kind: string; id: string };
  }>) {
    lines.push(
      `${item.id}: ${item.state}`,
      `Purpose: ${item.purpose_ref.kind} \`${item.purpose_ref.id}\`. Authority: ${item.authority_ref.kind} \`${item.authority_ref.id}\`. Evidence: ${item.evidence_ref.kind} \`${item.evidence_ref.id}\`.`,
    );
  }
  if (
    STATUS_CATEGORIES.includes(value.category as (typeof STATUS_CATEGORIES)[number]) &&
    count(value.next_offset) &&
    value.next_offset <= 10000
  )
    lines.push(`Next page: \`cos status ${value.category} offset ${value.next_offset}\`.`);
  else if (value.pagination_exhausted === true)
    lines.push('Coverage limited: further records exceed this inspection window. This view is incomplete.');
  else if (value.category == null)
    lines.push('Inspect details with `cos status missions`, `cos status actions` or another listed category.');
  lines.push(
    'Source content is withheld here. Inspect uncertain actions through current reconciliation; this view grants no execution authority.',
  );
  return lines.join('\n');
}
