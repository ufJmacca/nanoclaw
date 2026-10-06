import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import { cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { cosMissionIdentities, missionBoundary } from '../../../cos-mission-boundary.js';
import { stopCosMissionAttempt, stopCosMissionFamily } from '../../../cos-mission-stop.js';
import { interruptScheduledOrigin } from '../automation/scheduled-origin.js';
import { interruptReviewOrigin } from '../missions/review-origin.js';
import type { VerifiedIngress } from '../bridge/identity.js';
import { digest, type Context, type Result } from '../domain/contracts.js';
import { hasTable } from '../../../db/connection.js';

export type OwnerControl =
  | { kind: 'pause_admission' | 'pause_automation' | 'stop_scope' }
  | { kind: 'cancel_mission'; target: string };
export function parseOwnerControl(text: string): OwnerControl | null {
  if (text === 'cos pause admission') return { kind: 'pause_admission' };
  if (text === 'cos pause automation') return { kind: 'pause_automation' };
  if (text === 'cos stop') return { kind: 'stop_scope' };
  const match = /^cos cancel mission ([a-zA-Z0-9_-]{1,100})$/.exec(text);
  return match && match[0] === text ? { kind: 'cancel_mission', target: match[1] } : null;
}
type DenialRow = { ingress_id: string; binding_digest: string; kind: string; target: string | null; state: string };
/** Host-only deny journal. Native fences work offline; a local receipt never grants remote execution authority. */
export class HostOwnerControls {
  private readonly reconciling = new Set<string>();
  constructor(
    readonly dependencies: { db: Database.Database; session(id: string): Session | undefined; stop(id: string): void },
  ) {}
  private current(binding: CosBinding): boolean {
    const session = this.dependencies.session(binding.sessionId);
    if (!session) return false;
    const boundary = cosBoundary(session, this.dependencies.db);
    return boundary.restricted && !!boundary.binding && digest(boundary.binding) === digest(binding);
  }
  /** Caller supplies freshly verified private-channel ingress; verify its owner and exact command again here. */
  record(binding: CosBinding, ingress: VerifiedIngress, control: OwnerControl): Result {
    const parsed = parseOwnerControl(ingress.text);
    if (
      !this.current(binding) ||
      ingress.ownerId !== binding.ownerId ||
      !ingress.id ||
      ingress.id.length > 200 ||
      !parsed ||
      digest(parsed) !== digest(control)
    )
      return { status: 'denied' };
    const { db } = this.dependencies;
    db.exec(`CREATE TABLE IF NOT EXISTS cos_operator_denials (
      scope_id TEXT NOT NULL,ingress_id TEXT NOT NULL,binding_digest TEXT NOT NULL,payload_digest TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('pause_admission','pause_automation','stop_scope','cancel_mission')),
      target TEXT,state TEXT NOT NULL CHECK(state IN ('recorded','reconciled','denied')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(scope_id,ingress_id));`);
    const children = cosMissionIdentities(db).filter(
      (i) => i.scopeId === binding.scopeId && (control.kind !== 'cancel_mission' || i.missionId === control.target),
    );
    const payload = digest(ingress),
      bindingDigest = digest(binding);
    const recorded = db.transaction(() => {
      const existing = db
        .prepare('SELECT binding_digest,payload_digest FROM cos_operator_denials WHERE scope_id=? AND ingress_id=?')
        .get(binding.scopeId, ingress.id) as { binding_digest: string; payload_digest: string } | undefined;
      if (existing && (existing.binding_digest !== bindingDigest || existing.payload_digest !== payload)) return false;
      if (!this.current(binding)) return false;
      db.prepare(
        `INSERT OR IGNORE INTO cos_operator_denials(scope_id,ingress_id,binding_digest,payload_digest,kind,target,state) VALUES(?,?,?,?,?,?,'recorded')`,
      ).run(
        binding.scopeId,
        ingress.id,
        bindingDigest,
        payload,
        control.kind,
        control.kind === 'cancel_mission' ? control.target : null,
      );
      if (control.kind === 'cancel_mission') stopCosMissionFamily(binding.scopeId, control.target, 'owner_cancel', db);
      else {
        db.prepare('UPDATE cos_identity_boundaries SET paused=1 WHERE scope_id=?').run(binding.scopeId);
        interruptScheduledOrigin(db, binding);
        interruptReviewOrigin(db, binding);
      }
      for (const identity of children)
        stopCosMissionAttempt(identity, control.kind === 'cancel_mission' ? 'cancelled' : 'authority_lost', db);
      return true;
    })();
    if (!recorded) return { status: 'denied' };
    let uncertain = false;
    for (const identity of children) {
      const session = this.dependencies.session(identity.sessionId);
      // A conflicting native topology is never a reason to stop an ordinary session.
      if (session) {
        const boundary = missionBoundary(session, db);
        if (!boundary.restricted || !boundary.identity || digest(boundary.identity) !== digest(identity)) {
          uncertain = true;
          continue;
        }
      }
      try {
        this.dependencies.stop(identity.sessionId);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Keep the permanent denial and continue other stops when native acknowledgement is uncertain.
      } catch {
        uncertain = true;
      }
    }
    if (control.kind !== 'cancel_mission') {
      try {
        this.dependencies.stop(binding.sessionId);
        // eslint-disable-next-line no-catch-all/no-catch-all -- The committed pause remains closed when the native stop is uncertain.
      } catch {
        uncertain = true;
      }
    }
    return {
      status: uncertain ? 'pending' : 'ok',
      state: control.kind === 'cancel_mission' ? 'cancellation_recorded' : 'admission_paused',
      ledger: control.kind === 'cancel_mission' ? 'pending' : 'host_deny_recorded',
      effects: 'requires_reconciliation',
      native: 'stop_requested',
    };
  }
  /** Denials can reconcile while paused. Permanent local fences are never removed, even after remote acknowledgement. */
  async reconcile(
    binding: CosBinding,
    cancel: (context: Context, missionId: string) => Promise<Result>,
  ): Promise<void> {
    const { db } = this.dependencies;
    if (this.reconciling.has(binding.scopeId) || !this.current(binding) || !hasTable(db, 'cos_operator_denials'))
      return;
    this.reconciling.add(binding.scopeId);
    try {
      const rows = db
        .prepare(
          "SELECT ingress_id,binding_digest,kind,target,state FROM cos_operator_denials WHERE scope_id=? AND kind='cancel_mission' AND state='recorded' ORDER BY created_at,ingress_id LIMIT 20",
        )
        .all(binding.scopeId) as DenialRow[];
      for (const row of rows) {
        if (
          !this.current(binding) ||
          row.binding_digest !== digest(binding) ||
          !row.target ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(row.target)
        )
          continue;
        let result: Result;
        try {
          result = await cancel(
            {
              scopeId: binding.scopeId,
              ownerId: binding.ownerId,
              agentGroupId: binding.agentGroupId,
              sessionId: binding.sessionId,
              ingressId: row.ingress_id,
            },
            row.target,
          );
          // eslint-disable-next-line no-catch-all/no-catch-all -- Ambiguous database commits retain the pending denial without disclosing private diagnostics.
        } catch {
          continue;
        }
        if (!this.current(binding) || !['ok', 'denied'].includes(result.status)) continue;
        db.prepare(
          "UPDATE cos_operator_denials SET state=? WHERE scope_id=? AND ingress_id=? AND binding_digest=? AND state='recorded'",
        ).run(result.status === 'ok' ? 'reconciled' : 'denied', binding.scopeId, row.ingress_id, row.binding_digest);
      }
    } finally {
      this.reconciling.delete(binding.scopeId);
    }
  }
}
