import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import type { Context } from '../domain/contracts.js';
import type { BoundedDatabase } from '../store/client.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { MailHost } from './host.js';
import type { MailAuthorities } from './authority.js';
type MailContext = Context & { provider: string };
export type MailMaintenanceResources = {
  mail: MailHost;
  knowledge: Pick<KnowledgeStore, 'purgeDue'>;
  database: Pick<BoundedDatabase, 'pool'>;
};
/** Current native registration metadata only; no sign-in, budget or conversation
 * reads. Every result still needs fresh MailAuthorities.retention verification. */
export function mailMaintenanceContexts(db: Database.Database): () => MailContext[] {
  let after = '';
  return () => {
    const rows = db
      .prepare('SELECT scope_id,binding FROM cos_identity_boundaries WHERE scope_id>? ORDER BY scope_id LIMIT 10')
      .all(after) as Array<{ scope_id: string; binding: string }>;
    after = rows.length === 10 ? rows[9].scope_id : '';
    const contexts: MailContext[] = [];
    for (const row of rows) {
      try {
        if (row.binding.length > 65536) continue;
        const binding = JSON.parse(row.binding) as Partial<CosBinding>;
        if (
          !binding ||
          binding.scopeId !== row.scope_id ||
          binding.provider !== 'codex' ||
          [binding.scopeId, binding.ownerId, binding.agentGroupId, binding.sessionId].some(
            (x) => typeof x !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(x),
          )
        )
          continue;
        contexts.push({
          scopeId: binding.scopeId,
          ownerId: binding.ownerId!,
          agentGroupId: binding.agentGroupId!,
          sessionId: binding.sessionId!,
          ingressId: 'mail-maintenance',
          provider: 'codex',
        });
        // eslint-disable-next-line no-catch-all/no-catch-all -- Invalid native metadata cannot establish cleanup authority or disclose private parser diagnostics.
      } catch {
        /* Advance past malformed rows; current authority remains mandatory. */
      }
    }
    return contexts;
  };
}
/** Separate global-off owner. It cannot enable the ordinary runtime, RPC, source
 * polling, model credentials, specialists or message delivery. */
export class MailMaintenance {
  private resources?: MailMaintenanceResources;
  private retiring?: MailMaintenanceResources;
  private inFlight?: Promise<void>;
  private closing?: Promise<void>;
  private stopped = false;
  private closed = false;
  private state: 'idle' | 'retaining' | 'unavailable' | 'stopped' = 'idle';
  private purge: 'not_checked' | 'ok' | 'pending' | 'unavailable' = 'not_checked';
  private readonly authority: MailAuthorities;
  constructor(
    private readonly options: {
      connect(): Promise<MailMaintenanceResources>;
      admitted(): boolean;
      contexts(): MailContext[];
      authority: MailAuthorities;
    },
  ) {
    this.authority = {
      poll: () => false,
      retention: (context) => !this.stopped && options.admitted() && options.authority.retention(context),
    };
  }
  status() {
    return { state: this.state, purge: this.purge };
  }
  private async retire(): Promise<void> {
    const old = this.retiring ?? this.resources;
    if (!old) return;
    this.retiring = old;
    await old.mail.close();
    await old.database.pool.end();
    if (this.resources === old) this.resources = undefined;
    if (this.retiring === old) this.retiring = undefined;
  }
  async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    const run = async () => {
      try {
        if (this.retiring) await this.retire();
        if (!this.options.admitted()) {
          await this.retire();
          this.state = 'idle';
          return;
        }
        const contexts = this.options
          .contexts()
          .slice(0, 10)
          .filter((context) => this.authority.retention(context));
        if (!contexts.length) return;
        this.resources ??= await this.options.connect();
        if (this.stopped || !this.options.admitted()) {
          await this.retire();
          return;
        }
        let purge: typeof this.purge = 'ok';
        for (const context of contexts) {
          if (!this.authority.retention(context)) continue;
          this.resources.mail.poke(context, this.authority);
          const result = await this.resources.knowledge.purgeDue(context.scopeId);
          if (!this.authority.retention(context)) {
            this.state = 'idle';
            return;
          }
          if (result.status === 'pending' && purge !== 'unavailable') purge = 'pending';
          else if (result.status !== 'ok') purge = 'unavailable';
        }
        this.purge = purge;
        this.state = 'retaining';
        // eslint-disable-next-line no-catch-all/no-catch-all -- Global-off maintenance reports fixed states only and retains uncertain cleanup for reconciliation.
      } catch {
        this.state = 'unavailable';
      }
    };
    const work = run();
    this.inFlight = work;
    try {
      await work;
    } finally {
      if (this.inFlight === work) this.inFlight = undefined;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.stopped = true;
    const work = (async () => {
      await this.inFlight;
      await this.retire();
      this.closed = true;
      this.state = 'stopped';
    })();
    this.closing = work;
    try {
      await work;
    } finally {
      if (this.closing === work) this.closing = undefined;
    }
  }
}
