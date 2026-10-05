import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { insertTask, pauseTask, cancelTask } from '../../scheduling/db.js';
import { digest } from '../domain/contracts.js';
import type { MandateWake } from './mandate-policy.js';
export type { MandateWake } from './mandate-policy.js';
type RetirementReason = 'ineligible' | 'evaluated' | 'superseded';
/** Native schedule metadata is a host-only clock signal, never a coordinator/model task. */
export class NativeMandateTasks {
  constructor(readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS cos_mandate_native_tasks (
      task_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,mandate_id TEXT NOT NULL,revision INTEGER NOT NULL,
      wake_at TEXT NOT NULL,binding_digest TEXT NOT NULL,payload_digest TEXT NOT NULL,last_source_digest TEXT
    );
    CREATE TABLE IF NOT EXISTS cos_mandate_native_retirements (
      task_id TEXT PRIMARY KEY,reason TEXT NOT NULL CHECK(reason IN ('ineligible','evaluated','superseded')),
      retirement_digest TEXT NOT NULL
    )`);
  }
  private definition(binding: CosBinding, wake: MandateWake) {
    if (
      !/^mandate-[a-f0-9]{64}$/.test(wake.mandateId) ||
      !Number.isSafeInteger(wake.revision) ||
      wake.revision < 1 ||
      !Number.isFinite(Date.parse(wake.wakeAt)) ||
      new Date(wake.wakeAt).toISOString() !== wake.wakeAt
    )
      return null;
    return {
      id: 'cos-mandate-' + digest({ scope: binding.scopeId, ...wake }),
      processAfter: wake.wakeAt,
      recurrence: null,
      platformId: `mattermost:${binding.instanceId}:${binding.channelId}`,
      channelType: 'mattermost',
      threadId: null,
      content: JSON.stringify({ cosMandate: { mandateId: wake.mandateId, revision: wake.revision }, hostOnly: true }),
    };
  }
  private owned(binding: CosBinding, wake: MandateWake, terminal = false) {
    const task = this.definition(binding, wake);
    if (!task) return null;
    const marker = this.db.prepare('SELECT * FROM cos_mandate_native_tasks WHERE task_id=?').get(task.id) as
      | {
          scope_id: string;
          mandate_id: string;
          revision: number;
          wake_at: string;
          binding_digest: string;
          payload_digest: string;
          last_source_digest: string | null;
        }
      | undefined;
    if (
      !marker ||
      marker.scope_id !== binding.scopeId ||
      marker.mandate_id !== wake.mandateId ||
      marker.revision !== wake.revision ||
      marker.wake_at !== wake.wakeAt ||
      marker.binding_digest !== digest(binding) ||
      marker.payload_digest !== digest(task)
    )
      return null;
    const rows = this.db.prepare('SELECT * FROM messages_in WHERE id=? OR series_id=?').all(task.id, task.id) as Array<{
      id: string;
      series_id: string;
      kind: string;
      content: string;
      process_after: string;
      recurrence: string | null;
      platform_id: string;
      channel_type: string;
      thread_id: string | null;
      trigger: number;
      status: string;
    }>;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row.id !== task.id ||
      row.series_id !== task.id ||
      row.kind !== 'task' ||
      row.content !== task.content ||
      row.process_after !== task.processAfter ||
      row.recurrence !== null ||
      row.platform_id !== task.platformId ||
      row.channel_type !== task.channelType ||
      row.thread_id !== null ||
      row.trigger !== 1 ||
      !['paused', ...(terminal ? ['completed'] : [])].includes(row.status)
    )
      return null;
    return { task, row, marker };
  }
  stage(binding: CosBinding, wake: MandateWake): string | null {
    const task = this.definition(binding, wake);
    if (!task) return null;
    return this.db.transaction(() => {
      const existing = this.owned(binding, wake, true);
      if (existing) {
        const retirement = this.db
          .prepare('SELECT reason,retirement_digest FROM cos_mandate_native_retirements WHERE task_id=?')
          .get(task.id) as { reason: RetirementReason; retirement_digest: string } | undefined;
        if (existing.row.status === 'completed') {
          // Only a verified transient retirement can recover; completed evaluations and legacy unknowns stay closed.
          if (
            retirement?.reason !== 'ineligible' ||
            retirement.retirement_digest !== digest({ task, binding, reason: 'ineligible' }) ||
            this.db.prepare("UPDATE messages_in SET status='paused' WHERE id=? AND status='completed'").run(task.id)
              .changes !== 1
          )
            return null;
          this.db.prepare('DELETE FROM cos_mandate_native_retirements WHERE task_id=?').run(task.id);
        } else if (retirement) return null;
        return task.id;
      }
      if (
        this.db.prepare('SELECT 1 FROM messages_in WHERE id=? OR series_id=?').get(task.id, task.id) ||
        this.db.prepare('SELECT 1 FROM cos_mandate_native_tasks WHERE task_id=?').get(task.id)
      )
        return null;
      insertTask(this.db, task);
      // The existing CoS host pump consumes this clock. It must never enter a provider prompt or count as a due model message.
      pauseTask(this.db, task.id);
      this.db
        .prepare(
          'INSERT INTO cos_mandate_native_tasks(task_id,scope_id,mandate_id,revision,wake_at,binding_digest,payload_digest) VALUES(?,?,?,?,?,?,?)',
        )
        .run(task.id, binding.scopeId, wake.mandateId, wake.revision, wake.wakeAt, digest(binding), digest(task));
      return task.id;
    })();
  }
  current(binding: CosBinding, wake: MandateWake): boolean {
    return !!this.owned(binding, wake);
  }
  due(binding: CosBinding, wake: MandateWake, now: string): boolean {
    return (
      !!this.owned(binding, wake) && Number.isFinite(Date.parse(now)) && Date.parse(wake.wakeAt) <= Date.parse(now)
    );
  }
  retire(binding: CosBinding, wake: MandateWake, reason: RetirementReason = 'superseded'): boolean {
    return this.db.transaction(() => {
      const owned = this.owned(binding, wake, true);
      if (!owned) return false;
      // Repeated eligibility loss must not downgrade a completed evaluation into a recoverable clock.
      if (owned.row.status === 'paused' || reason !== 'ineligible') {
        this.db
          .prepare(
            'INSERT INTO cos_mandate_native_retirements(task_id,reason,retirement_digest) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET reason=excluded.reason,retirement_digest=excluded.retirement_digest',
          )
          .run(owned.task.id, reason, digest({ task: owned.task, binding, reason }));
        if (owned.row.status === 'paused') cancelTask(this.db, owned.task.id);
      }
      return true;
    })();
  }
  lastSourceDigest(binding: CosBinding, wake: MandateWake): string | null {
    return this.owned(binding, wake)?.marker.last_source_digest ?? null;
  }
  recordEvaluation(binding: CosBinding, wake: MandateWake, sourceDigest: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(sourceDigest)) return false;
    const owned = this.owned(binding, wake);
    if (!owned) return false;
    this.db
      .prepare('UPDATE cos_mandate_native_tasks SET last_source_digest=? WHERE task_id=?')
      .run(sourceDigest, owned.task.id);
    return true;
  }
  retireAll(
    binding: CosBinding,
    mandateId: string,
    except?: MandateWake,
    reason: RetirementReason = 'superseded',
  ): void {
    const rows = this.db
      .prepare('SELECT revision,wake_at FROM cos_mandate_native_tasks WHERE scope_id=? AND mandate_id=?')
      .all(binding.scopeId, mandateId) as Array<{ revision: number; wake_at: string }>;
    for (const row of rows) {
      const wake = { mandateId, revision: row.revision, wakeAt: row.wake_at };
      if (!except || digest(wake) !== digest(except)) this.retire(binding, wake, reason);
    }
  }
}
