import type Database from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { CosBinding } from '../../../cos-boundary.js';
import { hasTable } from '../../../db/connection.js';
import { digest } from '../domain/contracts.js';
type Row = { ingress_id: string; binding_digest: string; kind: string; target: string; state: string };
export function hasOwnerAccessDenials(db: Database.Database, binding: CosBinding): boolean {
  return (
    hasTable(db, 'cos_operator_denials') &&
    !!db
      .prepare(
        "SELECT 1 FROM cos_operator_denials WHERE scope_id=? AND kind IN ('revoke_source','disable_connector') LIMIT 1",
      )
      .get(binding.scopeId)
  );
}
function snapshot(db: Database.Database, binding: CosBinding): Row[] {
  const native = db.prepare('SELECT binding FROM cos_identity_boundaries WHERE scope_id=?').get(binding.scopeId) as
    | { binding: string }
    | undefined;
  if (!native || digest(JSON.parse(native.binding)) !== digest(binding)) throw Error('operator_denial_binding_changed');
  if (!hasOwnerAccessDenials(db, binding)) return [];
  const rows = db
    .prepare(
      "SELECT ingress_id,binding_digest,kind,target,state FROM cos_operator_denials WHERE scope_id=? AND kind IN ('revoke_source','disable_connector') ORDER BY ingress_id LIMIT 1001",
    )
    .all(binding.scopeId) as Row[];
  if (
    rows.length > 1000 ||
    rows.some(
      (r) =>
        r.binding_digest !== digest(binding) ||
        !['recorded', 'reconciled', 'denied'].includes(r.state) ||
        typeof r.target !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(r.target),
    )
  )
    throw Error('operator_denial_invalid');
  return rows;
}
export function ownerDenialCheckpoint(db: Database.Database, binding: CosBinding): string {
  try {
    return digest(snapshot(db, binding));
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Native parser errors can contain private binding data; expose only the fixed resume fence.
    throw Error('operator_denial_requires_reconciliation');
  }
}
/** Trusted resume requires the exact native snapshot checked against PostgreSQL, and cannot replay through a newer denial. */
export function assertOwnerDenialResumeCheckpoint(db: Database.Database, binding: CosBinding, verified?: string): void {
  try {
    const current = snapshot(db, binding);
    if (current.length && (current.some((r) => r.state === 'recorded') || verified !== digest(current)))
      throw Error('operator_denial_requires_reconciliation');
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Native parser errors must not be attached to a public operator result or nested cause.
    throw Error('operator_denial_requires_reconciliation');
  }
}
/** The native denial journal is preserved independently of a PostgreSQL restore. This check never clears it or resumes anything. */
export async function ownerDenialsPermitResume(
  db: Database.Database,
  binding: CosBinding,
  client: Pick<PoolClient, 'query'>,
): Promise<boolean> {
  try {
    const before = snapshot(db, binding);
    if (before.some((r) => r.state === 'recorded')) return false;
    if (!before.length) return true;
    if (
      (
        await client.query(
          "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status IN ('active','paused')",
          [binding.scopeId, binding.ownerId, binding.agentGroupId],
        )
      ).rowCount !== 1
    )
      return false;
    const sources = [...new Set(before.filter((r) => r.kind === 'revoke_source').map((r) => r.target))],
      connectors = [...new Set(before.filter((r) => r.kind === 'disable_connector').map((r) => r.target))];
    const source = (
      await client.query(
        "SELECT count(*)::int AS n FROM cos.sources s WHERE s.scope_id=$1 AND s.id=ANY($2::text[]) AND (s.status<>'revoked' OR NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id))",
        [binding.scopeId, sources],
      )
    ).rows[0];
    const connector = (
      await client.query(
        "SELECT count(*)::int AS n FROM cos.calendar_bindings WHERE scope_id=$1 AND id::text=ANY($2::text[]) AND auth NOT IN ('disconnected','revoked','expired')",
        [binding.scopeId, connectors],
      )
    ).rows[0];
    return source?.n === 0 && connector?.n === 0 && digest(snapshot(db, binding)) === digest(before);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Resume fails closed on private database/native inspection errors without exposing diagnostics.
  } catch {
    return false;
  }
}
