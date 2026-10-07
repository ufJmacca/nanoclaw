import type { Context, Result } from '../domain/contracts.js';
import type { CalendarStore, CalendarConnection } from './store.js';
import type { CalendarCredentialOwner } from './credentials.js';
import type { CalendarAccessFences } from './access-fences.js';
import type { CalendarReader } from './reader.js';
import type { CalendarWindow } from './normalization.js';
import type { PreparedCalendarRefresh } from './refresh.js';
import { refreshCalendar } from './refresh.js';
import { CalendarReadError, hasCalendarReadScope } from './reader.js';
import { googleCalendarReader } from './google-reader.js';
import { snapshotWindow, validateCalendarWindow } from './normalization.js';
import { digest } from '../domain/contracts.js';
import { assertCalendarActive } from './cancellation.js';
export type CalendarConnectorOptions = {
  store: Pick<CalendarStore, 'connection' | 'start' | 'publish' | 'fail' | 'setAuth'>;
  credentials?: Pick<CalendarCredentialOwner, 'inspect' | 'token'>;
  fences: Pick<CalendarAccessFences, 'assertOpen' | 'deny' | 'runCheck'>;
  admitted(): boolean;
  verifyStorage?(): void;
  fixtureReader?(binding: CalendarConnection): CalendarReader;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};
export class CalendarConnector {
  private readonly denied = new Map<string, 'expired' | 'revoked' | 'disconnected'>();
  constructor(private readonly options: CalendarConnectorOptions) {}
  /** Shared by cached-knowledge disclosure as well as connector requests. */
  assertOpen(scopeId: string, bindingId: string): void {
    this.options.verifyStorage?.();
    const auth = this.denied.get(digest({ scopeId, bindingId }));
    if (auth) throw new CalendarReadError('calendar_auth_' + auth);
    this.options.fences.assertOpen(scopeId, bindingId);
  }
  private deny(scopeId: string, bindingId: string, auth: 'expired' | 'revoked' | 'disconnected'): void {
    // Close the running host gate even when disk persistence fails. Never clear this latch in place.
    this.denied.set(digest({ scopeId, bindingId }), auth);
    this.options.fences.deny(scopeId, bindingId, auth);
  }
  private async connection(
    context: Context,
    bindingId: string,
    refresh = true,
    signal?: AbortSignal,
  ): Promise<CalendarConnection> {
    assertCalendarActive(signal);
    if (refresh && !this.options.admitted()) throw new CalendarReadError('calendar_disabled');
    const result = signal
      ? await this.options.store.connection(context, bindingId, signal)
      : await this.options.store.connection(context, bindingId);
    assertCalendarActive(signal);
    if (result.status !== 'ok')
      throw new CalendarReadError(result.status === 'denied' ? 'calendar_binding_denied' : 'calendar_unavailable');
    if (refresh && !this.options.admitted()) throw new CalendarReadError('calendar_disabled');
    return result.binding as CalendarConnection;
  }
  private admit(context: Context & { provider: string }, binding: CalendarConnection, calendar: string): void {
    this.assertOpen(context.scopeId, binding.id);
    if (binding.auth !== 'ready') throw new CalendarReadError('calendar_auth_' + binding.auth);
    if (!binding.calendarIds.includes(calendar) || !binding.processingProviders.includes(context.provider))
      throw new CalendarReadError('calendar_binding_denied');
    if (!hasCalendarReadScope(binding.scopes)) throw new CalendarReadError('calendar_scope_denied');
  }
  private reader(
    context: Context & { provider: string },
    binding: CalendarConnection,
    calendar: string,
    signal?: AbortSignal,
  ): CalendarReader {
    const d = this.options;
    const current = async () => {
      const fresh = await this.connection(context, binding.id, true, signal);
      this.admit(context, fresh, calendar);
      if (digest(fresh) !== digest(binding)) throw new CalendarReadError('calendar_access_changed');
      return fresh;
    };
    const access = async () => {
      const fresh = await current();
      if (!d.credentials || !fresh.credentialRef) throw new CalendarReadError('calendar_credentials_unavailable');
      const credentials = await d.credentials.inspect(context.scopeId, fresh.id, fresh.credentialRef);
      if (credentials.auth !== 'ready' || !hasCalendarReadScope(credentials.scopes))
        throw new CalendarReadError('calendar_scope_denied');
      await current();
      return {
        generation: fresh.id + ':' + fresh.version,
        calendarIds: [...fresh.calendarIds],
        scopes: [...fresh.scopes],
        auth: fresh.auth,
      };
    };
    if (binding.provider === 'google')
      return googleCalendarReader({
        access,
        fetch: d.fetch,
        signal,
        token: async () => {
          const fresh = await current();
          if (!d.credentials || !fresh.credentialRef) throw new CalendarReadError('calendar_credentials_unavailable');
          const token = signal
            ? await d.credentials.token(context.scopeId, fresh.id, fresh.credentialRef, signal)
            : await d.credentials.token(context.scopeId, fresh.id, fresh.credentialRef);
          // Token refresh is asynchronous: recheck admission before a request can leave the host.
          await current();
          return token;
        },
      });
    if (binding.provider !== 'fixture' || !d.fixtureReader)
      throw new CalendarReadError('calendar_provider_unavailable');
    const fixture = d.fixtureReader(structuredClone(binding));
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
      await current();
      const result = await operation();
      await current();
      return result;
    };
    return {
      access: () => guarded(() => fixture.access()),
      list: (...args) => guarded(() => fixture.list(...args)),
      get: (...args) => guarded(() => fixture.get(...args)),
    };
  }
  async refresh(
    context: Context & { provider: string },
    bindingId: string,
    calendarId: string,
    snapshotId: string,
    window?: CalendarWindow,
    signal?: AbortSignal,
  ): Promise<{ result: Result; prepared?: PreparedCalendarRefresh }> {
    const captured = Object.freeze({ ...context });
    try {
      const requested = window ? structuredClone(window) : undefined;
      const binding = await this.connection(captured, bindingId, true, signal);
      this.admit(captured, binding, calendarId);
      let selected: CalendarWindow;
      try {
        selected = requested
          ? requested
          : snapshotWindow(new Date((this.options.now ?? Date.now)()).toISOString(), binding.timeZone);
        validateCalendarWindow(selected);
        if (selected.timeZone !== binding.timeZone) return { result: { status: 'denied' } };
      } catch {
        return { result: { status: 'denied' } };
      }
      return await this.options.fences.runCheck(captured.scopeId, bindingId, () =>
        refreshCalendar({
          store: this.options.store,
          context: captured,
          bindingId,
          calendarId,
          snapshotId,
          window: selected,
          reader: this.reader(captured, binding, calendarId, signal),
          signal,
          accessLoss: async (auth) => {
            if (auth === 'ready') throw new CalendarReadError('calendar_invalid_denial');
            this.deny(captured.scopeId, bindingId, auth);
          },
        }),
      );
    } catch (error) {
      if (signal?.aborted) return { result: { status: 'unavailable', code: 'calendar_refresh_timed_out' } };
      const denied =
        error instanceof CalendarReadError &&
        [
          'calendar_disabled',
          'calendar_binding_denied',
          'calendar_scope_denied',
          'calendar_auth_revoked',
          'calendar_auth_expired',
          'calendar_auth_disconnected',
        ].includes(error.code);
      return { result: { status: denied ? 'denied' : 'unavailable' } };
    }
  }
  async disconnect(context: Context, bindingId: string): Promise<Result> {
    const captured = Object.freeze({ ...context });
    try {
      await this.connection(captured, bindingId, false);
      this.deny(captured.scopeId, bindingId, 'disconnected');
      return await this.options.store.setAuth(captured, bindingId, 'disconnected');
    } catch (error) {
      return {
        status:
          error instanceof CalendarReadError && error.code === 'calendar_binding_denied' ? 'denied' : 'unavailable',
      };
    }
  }
}
