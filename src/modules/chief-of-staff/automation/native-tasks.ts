import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { insertTask, pauseTask, resumeTask, cancelTask } from '../../scheduling/db.js';
import { digest } from '../domain/contracts.js';
export type NativeBriefRun = {
  id: string;
  schedule_id: string;
  schedule_version: number;
  intended_at: string;
  created_at?: string;
  provenance?: { time_zone?: string };
};
/** A native task is only a wake signal. The host must separately hold current run authority. */
export class NativeBriefTasks {
  constructor(readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS cos_brief_native_tasks (
   task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, run_id TEXT NOT NULL,
   schedule_id TEXT NOT NULL, schedule_version INTEGER NOT NULL,
   binding_digest TEXT NOT NULL, payload_digest TEXT NOT NULL,
   UNIQUE(scope_id,run_id)
  )`);
  }
  private definition(binding: CosBinding, run: NativeBriefRun) {
    const timeZone = run.provenance?.time_zone;
    if (timeZone !== undefined) {
      try {
        if (typeof timeZone !== 'string' || timeZone.length > 100) return null;
        new Intl.DateTimeFormat('en', { timeZone }).format();
      } catch {
        return null;
      }
    }
    if (
      !/^[a-f0-9]{64}$/.test(run.id) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(run.schedule_id) ||
      !Number.isSafeInteger(run.schedule_version) ||
      run.schedule_version < 1 ||
      !Number.isFinite(Date.parse(run.intended_at)) ||
      (run.created_at !== undefined && !Number.isFinite(Date.parse(run.created_at)))
    )
      return null;
    return {
      id: `cos-brief-${run.id}`,
      // The scheduler has already decided this occurrence is due. Use its stable
      // reservation time for native readiness; intended_at remains occurrence identity.
      processAfter: new Date(run.created_at ?? run.intended_at).toISOString(),
      recurrence: null,
      platformId: `mattermost:${binding.instanceId}:${binding.channelId}`,
      channelType: 'mattermost',
      threadId: null,
      content: JSON.stringify({
        prompt: timeZone
          ? `Prepare the approved scheduled brief by calling cos_brief_request with time_zone ${JSON.stringify(timeZone)}. The host delivers its checked result; do not send a separate chat reply or prepare another answer. Follow-ups remain proposals.`
          : 'Prepare the approved scheduled brief using cos_brief_request. Treat follow-ups as proposals; the host controls notification delivery.',
        cosBrief: {
          runId: run.id,
          scheduleId: run.schedule_id,
          scheduleVersion: run.schedule_version,
          ...(timeZone ? { timeZone } : {}),
        },
      }),
    };
  }
  private owned(binding: CosBinding, run: NativeBriefRun) {
    const task = this.definition(binding, run);
    if (!task) return null;
    const owned = this.db.prepare('SELECT * FROM cos_brief_native_tasks WHERE task_id=?').get(task.id) as
      | {
          scope_id: string;
          run_id: string;
          schedule_id: string;
          schedule_version: number;
          binding_digest: string;
          payload_digest: string;
        }
      | undefined;
    if (
      !owned ||
      owned.scope_id !== binding.scopeId ||
      owned.run_id !== run.id ||
      owned.schedule_id !== run.schedule_id ||
      owned.schedule_version !== run.schedule_version ||
      owned.binding_digest !== digest(binding) ||
      owned.payload_digest !== digest(task)
    )
      return null;
    const rows = this.db.prepare('SELECT * FROM messages_in WHERE id=? OR series_id=?').all(task.id, task.id) as Array<{
      id: string;
      series_id: string;
      kind: string;
      content: string;
      process_after: string;
      recurrence: string | null;
      platform_id: string | null;
      channel_type: string | null;
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
      row.trigger !== 1
    )
      return null;
    return row;
  }
  /** Staging is atomic and paused: trigger=0 alone would still be visible to the worker. */
  stage(binding: CosBinding, run: NativeBriefRun): string | null {
    const task = this.definition(binding, run);
    if (!task) return null;
    return this.db.transaction(() => {
      if (this.owned(binding, run)) return task.id;
      if (
        this.db.prepare('SELECT 1 FROM messages_in WHERE id=? OR series_id=?').get(task.id, task.id) ||
        this.db
          .prepare('SELECT 1 FROM cos_brief_native_tasks WHERE task_id=? OR (scope_id=? AND run_id=?)')
          .get(task.id, binding.scopeId, run.id)
      )
        return null;
      insertTask(this.db, task);
      pauseTask(this.db, task.id);
      this.db
        .prepare(
          'INSERT INTO cos_brief_native_tasks(task_id,scope_id,run_id,schedule_id,schedule_version,binding_digest,payload_digest) VALUES(?,?,?,?,?,?,?)',
        )
        .run(task.id, binding.scopeId, run.id, run.schedule_id, run.schedule_version, digest(binding), digest(task));
      return task.id;
    })();
  }
  /** Fresh remote admission followed by synchronous local fencing; never resurrect terminal tasks. */
  async activate(
    binding: CosBinding,
    run: NativeBriefRun,
    authorize: () => Promise<boolean>,
    current: () => boolean,
  ): Promise<boolean> {
    if (!this.owned(binding, run)) return false;
    try {
      if (!(await authorize())) return false;
    } catch {
      return false;
    }
    return this.db.transaction(() => {
      const row = this.owned(binding, run);
      if (!current() || !row || !['paused', 'pending'].includes(row.status)) return false;
      resumeTask(this.db, row.id);
      return true;
    })();
  }
  cancel(binding: CosBinding, run: NativeBriefRun): boolean {
    return this.db.transaction(() => {
      const row = this.owned(binding, run);
      if (!row) return false;
      cancelTask(this.db, row.id);
      return true;
    })();
  }
  /** An origin may have been committed just before a crash prevented native staging. */
  retire(binding: CosBinding, run: NativeBriefRun): boolean {
    const task = this.definition(binding, run);
    if (!task) return false;
    return this.db.transaction(() => {
      if (this.owned(binding, run)) return this.cancel(binding, run);
      return (
        !this.db.prepare('SELECT 1 FROM messages_in WHERE id=? OR series_id=?').get(task.id, task.id) &&
        !this.db
          .prepare('SELECT 1 FROM cos_brief_native_tasks WHERE task_id=? OR (scope_id=? AND run_id=?)')
          .get(task.id, binding.scopeId, run.id)
      );
    })();
  }
  pause(binding: CosBinding, run: NativeBriefRun): boolean {
    return this.db.transaction(() => {
      const row = this.owned(binding, run);
      if (!row) return false;
      pauseTask(this.db, row.id);
      return true;
    })();
  }
  state(binding: CosBinding, run: NativeBriefRun): string | null {
    return this.owned(binding, run)?.status ?? null;
  }
}
