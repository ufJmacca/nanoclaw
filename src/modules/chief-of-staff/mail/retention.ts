import { digest } from '../domain/contracts.js';
import type { MailCapture, MailCaptureLimitation } from './capture.js';
import { MAIL_RETENTION_MS } from './normalization.js';
const bytes = (messages: MailCapture['messages']) =>
  messages.reduce(
    (n, m) =>
      n +
      Buffer.byteLength(m.text) +
      Buffer.byteLength(m.subject) +
      Buffer.byteLength(m.from) +
      Buffer.byteLength(m.to),
    0,
  );
const seal = (value: Omit<MailCapture, 'digest'>): MailCapture => ({ ...value, digest: digest(value) });
/** Moving the observation clock alone is not a new retention event. Provider
 * captures keep their original freshness until content or queued metadata expires. */
export function mailRetentionChanged(previous: MailCapture, retained: MailCapture): boolean {
  const content = (capture: MailCapture) => ({
    messages: capture.messages.map((message) => ({ id: message.id, digest: message.digest })),
    deferred: capture.deferred,
    unsupported: capture.unsupported,
    accessClosed: capture.limitations.includes('access_unavailable'),
  });
  return digest(content(previous)) !== digest(content(retained));
}
/** A new capture with an explicit omission; never redact an already published
 * capture in place or keep a denied raw body merely for cursor continuity. */
export function suppressMailCapture(input: MailCapture, deniedIds: string[]): MailCapture {
  const denied = new Set(deniedIds),
    { digest: _digest, ...capture } = structuredClone(input),
    messages = capture.messages.filter((m) => !denied.has(m.id));
  const deniedMetadata = capture.messages
    .filter((m) => denied.has(m.id))
    .map((m) => ({ id: m.id, reason: 'owner_denied', seenAt: capture.window.capturedAt }));
  const unsupported = [
      ...new Map(
        [
          ...capture.unsupported.map((u) => (denied.has(u.id) ? { ...u, reason: 'owner_denied' } : u)),
          ...deniedMetadata,
        ].map((u) => [u.id, u]),
      ).values(),
    ].sort((a, b) => Number(b.reason === 'owner_denied') - Number(a.reason === 'owner_denied') || b.seenAt - a.seenAt),
    limitations = new Set<MailCaptureLimitation>(capture.limitations);
  if (unsupported.some((u) => u.reason === 'owner_denied')) limitations.add('owner_denied');
  if (unsupported.length) limitations.add('unsupported_messages');
  if (unsupported.length > 1000) limitations.add('message_limit');
  return seal({
    ...capture,
    messages,
    textBytes: bytes(messages),
    unsupported: unsupported.slice(0, 1000).sort((a, b) => a.id.localeCompare(b.id)),
    deferred: capture.deferred.filter((d) => !denied.has(d.id)),
    limitations: [...limitations].sort(),
    complete: limitations.size === 0,
  });
}
/** Trusted no-network maintenance preserves the last provider cursor/full sync.
 * Due deferred IDs remain queued for the next real provider read. */
export function retainedMailCapture(
  previous: MailCapture,
  at: number,
  deniedIds: string[],
  accessClosed: boolean,
): MailCapture {
  if (!Number.isSafeInteger(at) || at < previous.window.capturedAt) throw Error('mail_retention_clock');
  const { digest: _digest, ...old } = structuredClone(previous),
    window = { capturedAt: at, since: at - MAIL_RETENTION_MS };
  const messages = accessClosed
      ? []
      : old.messages.filter((m) => m.internalDate >= window.since && m.internalDate <= at),
    present = new Set(messages.map((m) => m.id));
  const limitations = new Set<MailCaptureLimitation>([...old.limitations, 'retention_only']);
  if (accessClosed) limitations.add('access_unavailable');
  const result = suppressMailCapture(
    seal({
      ...old,
      mode: 'retention',
      window,
      messages,
      textBytes: bytes(messages),
      removedIds: old.messages
        .filter((m) => !present.has(m.id))
        .map((m) => m.id)
        .sort(),
      deferred: old.deferred.filter((d) => d.seenAt >= window.since),
      unsupported: old.unsupported.filter((u) => u.seenAt >= window.since),
      limitations: [...limitations].sort(),
      complete: false,
    }),
    deniedIds,
  );
  return result;
}
