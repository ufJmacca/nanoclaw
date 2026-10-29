import { digest, type Context, type Result } from '../domain/contracts.js';
import type { MailConnection, MailStore } from './store.js';
import type { MailCredentialOwner } from './credentials.js';
import type { CalendarAccessFences } from '../calendar/access-fences.js';
import { CalendarReadError } from '../calendar/reader.js';
import { MailReadError, type MailReader } from './reader.js';
import { googleMailReader } from './google-reader.js';
import { GOOGLE_MAIL_READ_SCOPE } from './oauth.js';
import { collectMail, type MailCapture } from './capture.js';
import { validMailCapture } from './store.js';
import type { MailWindow } from './normalization.js';
import type { FreshMailReviewSource, MailReviewSourceReader } from './review-source.js';
type Closed = Exclude<MailConnection['auth'], 'ready'>;
type MailContext = Context & { provider: string };
/** Private host recovery material. Never serialize this to a model, chat or operational log. */
export type PreparedMailRefresh = { bindingId: string; bindingDigest: string; captureId: string; capture: MailCapture };
type Refresh = { result: Result; prepared?: PreparedMailRefresh };
export type MailConnectorOptions = {
  store: Pick<MailStore, 'connection' | 'captureWindow' | 'start' | 'filterCapture' | 'publish' | 'fail' | 'setAuth'>;
  credentials?: Pick<MailCredentialOwner, 'inspect' | 'token'>;
  /** A dedicated mail-profile journal in the guarded vault, separate from Calendar. */
  fences: Pick<CalendarAccessFences, 'assertOpen' | 'deny' | 'runCheck'>;
  admitted(context: Context & { provider: string }): boolean;
  verifyStorage(): void;
  fixtureReader?(binding: MailConnection): MailReader & Partial<MailReviewSourceReader>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};
const uuid = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
const readScope = (scopes: string[]) => scopes.length === 1 && scopes[0] === GOOGLE_MAIL_READ_SCOPE;
const failure = (error: unknown) =>
  error instanceof MailReadError
    ? error.code
    : error instanceof CalendarReadError
      ? error.code.replace(/^calendar_/, 'mail_')
      : 'mail_refresh_failed';
const lost: Record<string, Closed> = {
  mail_auth_revoked: 'revoked',
  mail_auth_expired: 'expired',
  mail_auth_disconnected: 'disconnected',
  mail_scope_denied: 'revoked',
  mail_access_changed: 'revoked',
  mail_wrong_account: 'revoked',
};
const settledReviewFailures = new Set(['mail_rate_limited', 'mail_message_missing']);
const cancelledReviewFailures = new Set(['mail_cancelled', 'mail_review_not_current', 'mail_disabled']);
type ReviewReadOutcome = { source: FreshMailReviewSource } | { failure: string };
/** Five-minute polling calls this host adapter without an inference capability.
 * Google calls occur between short database operations and under the durable access-check journal. */
export class MailConnector {
  private readonly denied = new Map<string, Closed>();
  private readonly pending = new Map<string, { request: string; work: Promise<Refresh> }>();
  private readonly shutdown = new AbortController();
  private readonly reviewReads = new Set<Promise<FreshMailReviewSource>>();
  private closing?: Promise<void>;
  constructor(private readonly options: MailConnectorOptions) {}
  assertOpen(scope: string, binding: string): void {
    if (this.shutdown.signal.aborted) throw new MailReadError('mail_disabled');
    this.options.verifyStorage();
    const denied = this.denied.get(digest({ scope, binding }));
    if (denied) throw new MailReadError('mail_auth_' + denied);
    this.options.fences.assertOpen(scope, binding);
  }
  private active(signal: AbortSignal, context: MailContext) {
    if (signal.aborted) throw new MailReadError('mail_cancelled');
    if (!this.options.admitted(context)) throw new MailReadError('mail_disabled');
  }
  private observedLoss(error: unknown, context: MailContext, binding: string): Closed | null {
    const code = failure(error);
    if (Object.hasOwn(lost, code)) return lost[code];
    try {
      this.assertOpen(context.scopeId, binding);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Credential refresh may already have persisted a known denial before a different sanitized exchange error reached this adapter.
    } catch (fenceError) {
      const denied = failure(fenceError);
      if (Object.hasOwn(lost, denied)) return lost[denied];
    }
    return null;
  }
  private async connection(context: MailContext, id: string, signal: AbortSignal): Promise<MailConnection> {
    this.active(signal, context);
    this.assertOpen(context.scopeId, id);
    const result = await this.options.store.connection(context, id);
    this.active(signal, context);
    this.assertOpen(context.scopeId, id);
    if (result.status !== 'ok')
      throw new MailReadError(result.status === 'denied' ? 'mail_binding_denied' : 'mail_unavailable');
    const binding = result.binding as MailConnection;
    if (binding.auth !== 'ready') throw new MailReadError('mail_auth_' + binding.auth);
    if (!readScope(binding.scopes)) throw new MailReadError('mail_scope_denied');
    if (binding.id !== id || !binding.processingProviders.includes(context.provider))
      throw new MailReadError('mail_binding_denied');
    return binding;
  }
  private async current(context: MailContext, binding: MailConnection, signal: AbortSignal): Promise<MailConnection> {
    const fresh = await this.connection(context, binding.id, signal);
    if (digest(fresh) !== digest(binding)) throw new MailReadError('mail_access_changed');
    return fresh;
  }
  private reader(
    context: MailContext,
    binding: MailConnection,
    signal: AbortSignal,
    reviewCurrent?: () => Promise<void>,
    reviewReadCompleted?: () => void,
  ): MailReader & Partial<MailReviewSourceReader> {
    const d = this.options,
      current = async () => {
        await reviewCurrent?.();
        const value = await this.current(context, binding, signal);
        await reviewCurrent?.();
        return value;
      };
    if (binding.provider === 'google') {
      const reader = googleMailReader({
        fetch: d.fetch,
        signal,
        access: async () => {
          const fresh = await current();
          if (!d.credentials || !fresh.credentialRef) throw new MailReadError('mail_credentials_unavailable');
          const credentials = await d.credentials.inspect(context.scopeId, binding.id, fresh.credentialRef);
          await current();
          if (credentials.auth !== 'ready' || !readScope(credentials.scopes))
            throw new MailReadError('mail_scope_denied');
          return {
            generation: binding.id + ':' + binding.version,
            mailboxEmail: binding.mailboxEmail,
            scopes: [...binding.scopes],
            auth: binding.auth,
          };
        },
        token: async () => {
          const fresh = await current();
          if (!d.credentials || !fresh.credentialRef) throw new MailReadError('mail_credentials_unavailable');
          const token = await d.credentials.token(context.scopeId, binding.id, fresh.credentialRef, signal);
          await current();
          return token;
        },
      });
      return {
        ...reader,
        reviewSource: async (...args) => {
          const result = await reader.reviewSource(...args);
          reviewReadCompleted?.();
          return result;
        },
      };
    }
    if (binding.provider !== 'fixture' || !d.fixtureReader) throw new MailReadError('mail_provider_unavailable');
    const reader = d.fixtureReader(structuredClone(binding));
    const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
      await current();
      const result = await operation();
      await current();
      return result;
    };
    return {
      profile: () => guard(() => reader.profile()),
      list: (...args) => guard(() => reader.list(...args)),
      message: (...args) => guard(() => reader.message(...args)),
      history: (...args) => guard(() => reader.history(...args)),
      thread: (...args) => guard(() => reader.thread(...args)),
      ...(reader.reviewSource
        ? {
            reviewSource: (...args: Parameters<MailReviewSourceReader['reviewSource']>) =>
              guard(async () => {
                const result = await reader.reviewSource!(...args);
                reviewReadCompleted?.();
                return result;
              }),
          }
        : {}),
    };
  }
  /** Trusted owner-side preparation only. No body, new capture, model call or draft operation is produced. */
  async reviewSource(
    context: MailContext,
    bindingId: string,
    messageId: string,
    window: MailWindow,
    current: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<FreshMailReviewSource> {
    if (context.origin || !uuid(bindingId) || !/^[a-f0-9]{1,128}$/.test(messageId))
      throw new MailReadError('mail_review_not_current');
    const ctx = structuredClone(context),
      combined = AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]);
    const check = async () => {
      this.active(combined, ctx);
      if (!(await current())) throw new MailReadError('mail_review_not_current');
      this.active(combined, ctx);
    };
    const run = async (): Promise<ReviewReadOutcome> => {
      try {
        await check();
        const binding = await this.connection(ctx, bindingId, combined);
        await check();
        return await this.options.fences.runCheck(ctx.scopeId, bindingId, async () => {
          let readStarted = false,
            readCompleted = false;
          try {
            await check();
            const reader = this.reader(ctx, binding, combined, check, () => {
              readCompleted = true;
            });
            if (!reader.reviewSource) throw new MailReadError('mail_review_metadata_unavailable');
            readStarted = true;
            const result = await reader.reviewSource(messageId, window);
            await check();
            await this.current(ctx, binding, combined);
            await check();
            return { source: result };
            // A completed read can lose review authority after its response.
            // Record access loss here; unknown or interrupted checks stay closed.
          } catch (error) {
            const auth = this.observedLoss(error, ctx, bindingId);
            if (auth) await this.deny(ctx, bindingId, auth);
            if (
              auth ||
              (error instanceof MailReadError &&
                (settledReviewFailures.has(error.code) ||
                  (cancelledReviewFailures.has(error.code) && (!readStarted || readCompleted))))
            )
              return { failure: failure(error) };
            throw error;
          }
        });
      } catch (error) {
        const auth = this.observedLoss(error, ctx, bindingId);
        if (auth) await this.deny(ctx, bindingId, auth);
        throw new MailReadError(failure(error));
      }
    };
    const work = run().then((outcome) => {
      if ('failure' in outcome) throw new MailReadError(outcome.failure);
      return outcome.source;
    });
    this.reviewReads.add(work);
    try {
      return await work;
    } finally {
      this.reviewReads.delete(work);
    }
  }
  async refresh(
    context: MailContext,
    bindingId: string,
    captureId: string,
    retry?: PreparedMailRefresh,
    signal?: AbortSignal,
  ): Promise<Refresh> {
    if (this.shutdown.signal.aborted) return { result: { status: 'denied' } };
    if (context.origin || !uuid(bindingId) || !uuid(captureId)) return { result: { status: 'denied' } };
    if (signal?.aborted) return { result: { status: 'unavailable', code: 'mail_refresh_timed_out' } };
    const ctx = Object.freeze({ ...context }),
      prepared = retry ? structuredClone(retry) : undefined;
    if (
      prepared &&
      (prepared.bindingId !== bindingId ||
        prepared.captureId !== captureId ||
        !validMailCapture(prepared.capture) ||
        prepared.capture.mode === 'retention')
    )
      return { result: { status: 'denied' } };
    const key = digest({ scope: ctx.scopeId, binding: bindingId }),
      request = digest({ context: ctx, captureId, retry: prepared?.capture.digest ?? null });
    const pending = this.pending.get(key);
    if (pending)
      return pending.request === request
        ? this.awaitRefresh(pending.work, signal)
        : { result: { status: 'pending', code: 'mail_refresh_busy' } };
    if (this.pending.size >= 8) return { result: { status: 'pending', code: 'mail_refresh_busy' } };
    const bounded = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(240000), ...(signal ? [signal] : [])]);
    const work = this.run(ctx, bindingId, captureId, prepared, bounded);
    this.pending.set(key, { request, work });
    try {
      return await work;
    } finally {
      if (this.pending.get(key)?.work === work) this.pending.delete(key);
    }
  }
  /** Retiring credentials must wait for real operations, including an ambiguous
   * publication. Aborting an observer is not proof that its work has settled. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.shutdown.abort();
    this.closing = Promise.all([
      Promise.allSettled([...this.pending.values()].map((entry) => entry.work)),
      Promise.allSettled([...this.reviewReads]),
    ]).then(([results]) => {
      if (results.some((result) => result.status === 'rejected')) throw Error('mail_refresh_retirement_unavailable');
    });
    return this.closing;
  }
  private async awaitRefresh(work: Promise<Refresh>, signal?: AbortSignal): Promise<Refresh> {
    if (!signal) return work;
    const cancelled: Refresh = { result: { status: 'unavailable', code: 'mail_refresh_timed_out' } };
    if (signal.aborted) return cancelled;
    let abort!: () => void;
    const cancellation = new Promise<Refresh>((resolve) => {
      abort = () => resolve(cancelled);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([work, cancellation]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  private async deny(context: MailContext, binding: string, auth: Closed): Promise<Refresh> {
    this.denied.set(digest({ scope: context.scopeId, binding }), auth);
    try {
      this.options.fences.deny(context.scopeId, binding, auth);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Keep the in-memory denial latched when durable storage cannot confirm it; disclose no private diagnostics.
    } catch {
      return { result: { status: 'unavailable', access_loss: auth, code: 'mail_access_fence_failed' } };
    }
    try {
      const result = await this.options.store.setAuth(context, binding, auth);
      return { result: { status: result.status === 'ok' ? 'denied' : result.status, access_loss: auth } };
      // eslint-disable-next-line no-catch-all/no-catch-all -- PostgreSQL cannot reopen the independently latched denial or expose private diagnostics on a failed write.
    } catch {
      return { result: { status: 'unavailable', access_loss: auth, code: 'mail_access_state_unavailable' } };
    }
  }
  private async run(
    context: MailContext,
    bindingId: string,
    captureId: string,
    retry: PreparedMailRefresh | undefined,
    signal: AbortSignal,
  ): Promise<Refresh> {
    try {
      this.active(signal, context);
      const binding = await this.connection(context, bindingId, signal);
      if (retry && (retry.bindingDigest !== digest(binding) || retry.capture.mailboxEmail !== binding.mailboxEmail))
        return { result: { status: 'denied' } };
      return await this.options.fences.runCheck(context.scopeId, bindingId, async (): Promise<Refresh> => {
        let prepared: PreparedMailRefresh | undefined,
          publishing = false,
          started = false;
        try {
          await this.current(context, binding, signal);
          const clock = retry
            ? { status: 'ok' as const, window: retry.capture.window }
            : await this.options.store.captureWindow(context);
          if (clock.status !== 'ok') return { result: { status: clock.status } };
          this.active(signal, context);
          const start = await this.options.store.start(context, bindingId, captureId, clock.window as MailWindow);
          if (start.status !== 'ok') return { result: start };
          started = true;
          await this.current(context, binding, signal);
          if (start.already_complete) {
            const result = start.result as Result | undefined;
            return result?.status === 'ok' && result.capture_id === captureId
              ? { result }
              : { result: { status: 'denied' } };
          }
          const capture =
            retry?.capture ??
            (await collectMail({
              reader: this.reader(context, binding, signal),
              mailboxEmail: binding.mailboxEmail,
              capturedAt: (clock.window as MailWindow).capturedAt,
              ...(start.previous ? { previous: start.previous as MailCapture } : {}),
            }));
          await this.current(context, binding, signal);
          const filtered = await this.options.store.filterCapture(context, bindingId, capture);
          if (filtered.status !== 'ok') return { result: filtered };
          prepared = { bindingId, captureId, bindingDigest: digest(binding), capture: filtered.capture as MailCapture };
          await this.current(context, binding, signal);
          publishing = true;
          const result = await this.options.store.publish(context, bindingId, captureId, prepared.capture);
          await this.current(context, binding, signal);
          return ['pending', 'unavailable'].includes(result.status) ? { result, prepared } : { result };
          // eslint-disable-next-line no-catch-all/no-catch-all -- Failures close refresh or retain an uncertain publication receipt without exposing provider, credential or filesystem diagnostics.
        } catch (error) {
          const code = failure(error);
          const auth = this.observedLoss(error, context, bindingId);
          if (auth) return this.deny(context, bindingId, auth);
          if (publishing && prepared) return { result: { status: 'pending', capture_id: captureId }, prepared };
          if (started) await this.options.store.fail(context, bindingId, captureId, 'mail_refresh_failed');
          return {
            result: {
              status: ['mail_disabled', 'mail_binding_denied'].includes(code) ? 'denied' : 'unavailable',
              code: signal.aborted ? 'mail_refresh_timed_out' : 'mail_refresh_failed',
            },
          };
        }
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- The host boundary returns fixed failure states and persists any independently observed access denial.
    } catch (error) {
      const code = failure(error);
      const auth = this.observedLoss(error, context, bindingId);
      if (auth) return this.deny(context, bindingId, auth);
      return {
        result: {
          status: ['mail_disabled', 'mail_binding_denied'].includes(code) ? 'denied' : 'unavailable',
          code: signal.aborted ? 'mail_refresh_timed_out' : 'mail_refresh_failed',
        },
      };
    }
  }
}
