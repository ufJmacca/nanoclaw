import { randomUUID } from 'node:crypto';
import { digest, type Context } from '../domain/contracts.js';
import { CalendarReadError } from '../calendar/reader.js';
import type { CalendarAccessFences } from '../calendar/access-fences.js';
import { MailReadError } from './reader.js';
import type { MailAuthorities } from './authority.js';
import type { MailConnector } from './connector.js';
import type { MailMaintenanceBinding, MailStore } from './store.js';
type MailContext = Context & { provider: string };
const cadence = 300000;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
/** Background host maintenance has no model, worker, message-delivery or write API.
 * Pokes return immediately; the host retains every real operation until retirement. */
export class MailPump {
  private readonly shutdown = new AbortController();
  private readonly scans = new Map<string, Promise<void>>();
  private readonly refreshes = new Set<Promise<void>>();
  private claiming = false;
  private readonly cursors = new Map<string, string | undefined>();
  private readonly retention = new Map<string, number>();
  private readonly now: () => number;
  constructor(
    private readonly options: {
      store: Pick<MailStore, 'maintenanceBindings' | 'claimPoll' | 'maintain' | 'setAuth'>;
      connector?: Pick<MailConnector, 'refresh'>;
      fences?: Pick<CalendarAccessFences, 'assertOpen'>;
      authority: MailAuthorities;
      now?(): number;
    },
  ) {
    this.now = options.now ?? (() => performance.now());
  }
  private allowed(context: MailContext, kind: keyof MailAuthorities): boolean {
    return !this.shutdown.signal.aborted && !context.origin && this.options.authority[kind](context);
  }
  poke(context: MailContext): boolean {
    if (!this.allowed(context, 'retention')) return false;
    const key = digest({
      scope: context.scopeId,
      owner: context.ownerId,
      group: context.agentGroupId,
      session: context.sessionId,
    });
    if (this.scans.has(key) || this.scans.size >= 8) return false;
    const work = this.scan(Object.freeze({ ...context }), key)
      // Private failures cannot leak payloads or fail unrelated messaging. The next poke uses fresh authority.
      .catch(() => {})
      .finally(() => {
        if (this.scans.get(key) === work) this.scans.delete(key);
      });
    this.scans.set(key, work);
    return true;
  }
  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    // Eviction can cause an extra check, never an extended retention period or a grant.
    map.delete(key);
    map.set(key, value);
    if (map.size > 256) map.delete(map.keys().next().value!);
  }
  private async scan(context: MailContext, key: string): Promise<void> {
    const d = this.options;
    const page = await d.store.maintenanceBindings(context, this.cursors.get(key));
    if (!this.allowed(context, 'retention') || page.status !== 'ok' || !Array.isArray(page.items)) return;
    if (page.items.length > 10 || (page.next_after !== null && !uuid(page.next_after))) return;
    for (const item of page.items as MailMaintenanceBinding[]) {
      if (!this.allowed(context, 'retention') || !uuid(item.binding_id)) return;
      let open = !!d.fences;
      let closed: Exclude<MailMaintenanceBinding['auth'], 'ready'> | undefined;
      try {
        d.fences?.assertOpen(context.scopeId, item.binding_id);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Only typed monotonic access-loss codes authorize a database denial. Unknown vault failures close polling and still allow age-based deletion.
      } catch (error) {
        open = false;
        if (error instanceof CalendarReadError || error instanceof MailReadError) {
          const code = error.code.replace(/^calendar_/, 'mail_');
          if (code === 'mail_auth_revoked') closed = 'revoked';
          if (code === 'mail_auth_expired') closed = 'expired';
          if (code === 'mail_auth_disconnected') closed = 'disconnected';
        }
      }
      if (!this.allowed(context, 'retention')) return;
      if (closed && item.auth === 'ready') {
        const denial = await d.store.setAuth(context, item.binding_id, closed);
        if (!this.allowed(context, 'retention') || denial.status !== 'ok') continue;
      }
      const retained = digest({ scope: context.scopeId, binding: item.binding_id });
      if (
        !this.retention.has(retained) ||
        this.now() >= this.retention.get(retained)! ||
        (closed && item.auth === 'ready')
      ) {
        const result = await d.store.maintain(context, item.binding_id, randomUUID());
        if (!this.allowed(context, 'retention')) return;
        if (result.status === 'ok') this.remember(this.retention, retained, this.now() + cadence);
      }
      if (
        !open ||
        !d.connector ||
        !item.provider_allowed ||
        item.auth !== 'ready' ||
        !item.poll_due ||
        this.refreshes.size ||
        this.claiming ||
        !this.allowed(context, 'poll')
      )
        continue;
      this.claiming = true;
      let claim;
      try {
        claim = await d.store.claimPoll(context, item.binding_id);
      } finally {
        this.claiming = false;
      }
      if (!this.allowed(context, 'poll') || claim.status !== 'ok' || claim.claimed !== true || this.refreshes.size)
        continue;
      // One actual Gmail refresh bounds memory independently of the collector's
      // per-message concurrency. Other bindings' retention continues meanwhile.
      const refresh = d.connector
        .refresh(context, item.binding_id, randomUUID(), undefined, this.shutdown.signal)
        .then(() => {})
        // Captures stay private; actual work is still awaited during retirement.
        .catch(() => {})
        .finally(() => {
          this.refreshes.delete(refresh);
        });
      this.refreshes.add(refresh);
    }
    this.remember(this.cursors, key, page.next_after === null ? undefined : String(page.next_after));
  }
  fence(): void {
    this.shutdown.abort();
  }
  async close(): Promise<void> {
    this.fence();
    // A scan checks the fence after every await and cannot start new work after
    // this snapshot. An in-flight refresh already has its owned abort signal.
    await Promise.allSettled([...this.scans.values(), ...this.refreshes]);
  }
}
