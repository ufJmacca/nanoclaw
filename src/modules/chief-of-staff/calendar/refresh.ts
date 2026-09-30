import type { Context, Result } from '../domain/contracts.js';
import { CalendarReadError, type CalendarReader, type CalendarAccess } from './reader.js';
import type { CalendarWindow } from './normalization.js';
import type { CalendarStore } from './store.js';
import { collectCalendarSnapshot, type CalendarSnapshot } from './snapshot.js';

/** Private host recovery material; never a model RPC response or operational log. */
export type PreparedCalendarRefresh = { bindingId: string; snapshotId: string; snapshot: CalendarSnapshot };
export type CalendarRefreshOptions = {
  store: Pick<CalendarStore, 'start' | 'publish' | 'fail' | 'setAuth'>;
  context: Context;
  reader: CalendarReader;
  bindingId: string;
  calendarId: string;
  snapshotId: string;
  window: CalendarWindow;
  /** The host must durably deny this binding before returning, independently of PostgreSQL availability.
   * If persistence fails, its admission gate must remain closed. No default/no-op production implementation. */
  accessLoss(auth: CalendarAccess['auth']): Promise<void>;
};
const lostAccess: Record<string, CalendarAccess['auth']> = {
  calendar_auth_expired: 'expired',
  calendar_auth_revoked: 'revoked',
  calendar_auth_disconnected: 'disconnected',
  calendar_access_revoked: 'revoked',
  calendar_scope_denied: 'revoked',
  calendar_not_selected: 'revoked',
  calendar_access_changed: 'revoked',
};
const safeFailures = new Set([
  'calendar_unavailable',
  'calendar_rate_limited',
  'calendar_pagination_limit',
  'calendar_invalid_response',
  'calendar_snapshot_changed',
  'calendar_snapshot_too_large',
]);

/** Trusted host refresh. Provider calls run strictly between short store transactions. */
export async function refreshCalendar(
  options: CalendarRefreshOptions,
): Promise<{ result: Result; prepared?: PreparedCalendarRefresh }> {
  const { store, reader, bindingId, calendarId, snapshotId, accessLoss } = options;
  const context = Object.freeze({ ...options.context }),
    window = Object.freeze({ ...options.window });
  const started = await store.start(context, bindingId, calendarId, snapshotId, window);
  if (started.status !== 'ok') return { result: started };
  if (started.snapshot_status === 'complete') {
    return {
      result:
        started.result && typeof started.result === 'object'
          ? (started.result as Result)
          : { status: 'pending', snapshot_id: snapshotId },
    };
  }
  let snapshot: CalendarSnapshot;
  try {
    snapshot = await collectCalendarSnapshot(reader, calendarId, window);
  } catch (error) {
    const code = error instanceof CalendarReadError ? error.code : 'calendar_refresh_failed';
    const auth = Object.hasOwn(lostAccess, code) ? lostAccess[code] : undefined;
    if (auth) {
      try {
        await accessLoss(auth);
      } catch {
        return { result: { status: 'unavailable', code: 'calendar_access_fence_failed', access_loss: auth } };
      }
      const denied = await store.setAuth(context, bindingId, auth);
      if (denied.status !== 'ok') return { result: { status: denied.status, access_loss: auth } };
      const failed = await store.fail(context, bindingId, snapshotId, 'calendar_refresh_failed');
      return { result: { status: failed.status === 'ok' ? 'denied' : failed.status, access_loss: auth } };
    }
    const failed = await store.fail(
      context,
      bindingId,
      snapshotId,
      safeFailures.has(code) ? code : 'calendar_refresh_failed',
    );
    return {
      result: { status: failed.status === 'ok' ? 'unavailable' : failed.status, code: 'calendar_refresh_failed' },
    };
  }
  const prepared = { bindingId, snapshotId, snapshot };
  try {
    const result = await store.publish(context, bindingId, snapshotId, snapshot);
    return ['pending', 'unavailable'].includes(result.status) ? { result, prepared } : { result };
  } catch {
    // An unexpected transport failure cannot prove that a remote commit did not happen.
    return { result: { status: 'pending', snapshot_id: snapshotId }, prepared };
  }
}
