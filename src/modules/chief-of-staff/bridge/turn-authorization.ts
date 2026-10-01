import { digest, type Context } from '../domain/contracts.js';

/** Only continuous egress polling may reuse a remote result; admissions are fresh. */
export type TurnAuthorization = ((mode?: 'poll') => Promise<string | null>) & {
  reserve?(attemptId: string): Promise<boolean>;
};
const REMOTE_CHECK_INTERVAL_MS = 15_000;

export function createTurnAuthorization(options: {
  local(): Context | null;
  verify(): Promise<Context | null>;
  reserve?(context: Context, attemptId: string): Promise<boolean>;
}): TurnAuthorization {
  type Result = { key: string; checkedAt: number; context: Context | null };
  let cached: Result | undefined;
  let pending: { key: string; result: Promise<Result> } | undefined;
  const authorize: TurnAuthorization = async (mode) => {
    const local = options.local();
    if (!local) {
      cached = undefined;
      return null;
    }
    const key = digest(local);
    const fresh = (result: Result) => performance.now() - result.checkedAt < REMOTE_CHECK_INTERVAL_MS;
    let result = cached;
    if (mode !== 'poll' || !result || result.key !== key || !fresh(result)) {
      if (!pending || pending.key !== key) {
        const checkedAt = performance.now();
        const entry = {
          key,
          result: options
            .verify()
            .then((context) => ({ key, checkedAt, context }))
            // Failed remote verification is a denial; never reuse a stale success.
            .catch(() => ({ key, checkedAt, context: null }))
            .then((value) => {
              if (pending === entry) {
                cached = value;
                pending = undefined;
              }
              return value;
            }),
        };
        pending = entry;
      }
      result = await pending.result;
    }
    const current = options.local();
    return current && result.context && fresh(result) && digest(current) === key && digest(result.context) === key
      ? current.ingressId
      : null;
  };
  authorize.reserve = async (attemptId) => {
    const context = options.local();
    if (!context) return false;
    if (!context.origin) return true;
    try {
      if (!options.reserve || !(await authorize())) return false;
      const current = options.local();
      if (!current || digest(current) !== digest(context)) return false;
      if (!(await options.reserve(context, attemptId))) return false;
      const after = options.local();
      return !!after && digest(after) === digest(context);
    } catch {
      // An uncertain reservation stays spent; it never authorizes a provider call.
      return false;
    }
  };
  return authorize;
}
