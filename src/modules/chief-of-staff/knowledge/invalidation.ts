import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import { cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { hasTable } from '../../../db/connection.js';
import { digest } from '../domain/contracts.js';
import type { KnowledgeStore } from './store.js';

type Retained = { generation: string; binding_digest: string; status: string };
/** S02 has one retained coordinator context per scope. This consumer never activates or resets it. */
export class KnowledgeInvalidation {
  private readonly draining = new Set<string>();
  constructor(
    readonly dependencies: {
      db: Database.Database;
      store: Pick<KnowledgeStore, 'pendingInvalidations' | 'contextReady' | 'acknowledgeInvalidation'>;
      session(id: string): Session | undefined;
      stop(sessionId: string): void;
    },
  ) {}
  async drain(binding: CosBinding): Promise<void> {
    if (this.draining.has(binding.scopeId)) return;
    this.draining.add(binding.scopeId);
    try {
      const { db, store } = this.dependencies;
      const boundary = () => {
        const session = this.dependencies.session(binding.sessionId);
        if (!session) return null;
        const current = cosBoundary(session, db);
        return current.restricted && current.binding && digest(current.binding) === digest(binding) ? current : null;
      };
      if (!boundary() || !hasTable(db, 'cos_conversation_states')) return;
      const pending = await store.pendingInvalidations(binding.scopeId);
      if (pending.status !== 'ok' || !Array.isArray(pending.items) || !pending.items.length) return;
      const read = () =>
        db
          .prepare('SELECT generation,binding_digest,status FROM cos_conversation_states WHERE scope_id=?')
          .get(binding.scopeId) as Retained | undefined;
      const retained = read(),
        local = boundary();
      if (
        !local ||
        !retained ||
        retained.binding_digest !== digest(binding) ||
        !['active', 'invalidated'].includes(retained.status)
      )
        return;
      if (retained.status === 'active') {
        const access = await store.contextReady({
          scopeId: binding.scopeId,
          ownerId: binding.ownerId,
          agentGroupId: binding.agentGroupId,
          sessionId: binding.sessionId,
          ingressId: local.ingressId ?? 'knowledge-reconciliation',
          provider: binding.provider,
          generation: retained.generation,
        });
        const current = read();
        if (
          !['ok', 'denied'].includes(access.status) ||
          !boundary() ||
          !current ||
          digest(current) !== digest(retained)
        )
          return;
        if (access.status === 'denied') {
          db.transaction(() => {
            db.prepare(
              "UPDATE cos_conversation_states SET status='invalidated',reason='access_changed',updated_at=? WHERE scope_id=? AND generation=?",
            ).run(new Date().toISOString(), binding.scopeId, retained.generation);
            db.prepare('UPDATE cos_identity_boundaries SET paused=1 WHERE scope_id=?').run(binding.scopeId);
          })();
        }
      }
      // The durable denial precedes termination. Failure leaves the job pending for a restart/retry.
      // A clean replacement generation passes current policy and is not terminated by an old job.
      if (read()?.status === 'invalidated') this.dependencies.stop(binding.sessionId);
      for (const item of pending.items) {
        if (typeof item.id !== 'string') continue;
        if ((await store.acknowledgeInvalidation(binding.scopeId, item.id)).status !== 'ok') return;
      }
    } finally {
      this.draining.delete(binding.scopeId);
    }
  }
}
