import { CalendarReadError } from './reader.js';

/** Host-owned refresh budget. Never serialize an AbortSignal into provider or worker data. */
export function assertCalendarActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CalendarReadError('calendar_refresh_timed_out');
}
export function calendarRequestSignal(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Join another caller's already-bounded credential operation, never a snapshot-publishing pipeline. */
export function awaitCalendarCredential<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  assertCalendarActive(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new CalendarReadError('calendar_refresh_timed_out'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}
