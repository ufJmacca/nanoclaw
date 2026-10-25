import { CalendarCredentialCore } from '../calendar/credential-core.js';
import { digest } from '../domain/contracts.js';
import { assertCalendarActive, awaitCalendarCredential } from '../calendar/cancellation.js';
/** Each mail profile owns its queue. Tokens and journal locks never cross profile roots. */
export class SerializedMailCredentials extends CalendarCredentialCore {
  private readonly operations = new Map<string, Promise<void>>();
  private serial<T>(scope: string, binding: string, reference: string, operation: () => Promise<T>): Promise<T> {
    const key = digest({ scope, binding, reference });
    const work = (this.operations.get(key) ?? Promise.resolve()).then(operation);
    const settled = work.then(
      () => {},
      () => {},
    );
    this.operations.set(key, settled);
    void settled.then(() => {
      if (this.operations.get(key) === settled) this.operations.delete(key);
    });
    return work;
  }
  override inspect(scope: string, binding: string, reference: string) {
    return this.serial(scope, binding, reference, () => super.inspect(scope, binding, reference));
  }
  override async token(scope: string, binding: string, reference: string, signal?: AbortSignal): Promise<string> {
    assertCalendarActive(signal);
    const work = this.serial(scope, binding, reference, () => super.token(scope, binding, reference, signal));
    return signal ? awaitCalendarCredential(work, signal) : work;
  }
}
