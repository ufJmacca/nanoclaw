/** Metadata for a failed synthetic draft replay; never serialize whole RPC or driver objects. */
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const known = (value: unknown, allowed: readonly string[]): string | null =>
  typeof value === 'string' && allowed.includes(value) ? value : null;
const count = (value: unknown, maximum = 1000000): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
const reasons = [
  'mail_draft_access_changed',
  'mail_draft_already_reserved',
  'mail_draft_binding_denied',
  'mail_draft_clock_invalid',
  'mail_draft_clock_regressed',
  'mail_draft_credentials_unavailable',
  'mail_draft_daily_limit',
  'mail_draft_effect_missing',
  'mail_draft_endpoint_denied',
  'mail_draft_invalid_response',
  'mail_draft_inventory_incomplete',
  'mail_draft_journal_inventory_limit',
  'mail_draft_not_admitted',
  'mail_draft_provider_unavailable',
  'mail_draft_reply_invalid',
  'mail_draft_request_invalid',
  'mail_draft_reservation_changed',
  'mail_draft_response_too_large',
  'mail_draft_separate_client_required',
  'mail_draft_source_denied',
  'mail_draft_thread_reserved',
  'mail_draft_unavailable',
  'mail_draft_wrong_account',
];

export function draftReplayFailureMetadata(response: unknown, diagnostics: unknown, providerWrites: unknown) {
  const rpc = record(response),
    result = record(rpc.result),
    observed = record(diagnostics),
    pool = record(observed.pool);
  return {
    contract: 'cos-g05-edited-replay-fixture-failure/v1',
    rpc: {
      status: known(rpc.status, ['ok', 'denied', 'unavailable', 'pending', 'conflict', 'invalid']) ?? 'unknown',
      draftStatus: known(result.draft_status, [
        'verified',
        'uncertain',
        'edited',
        'missing',
        'sent',
        'collision',
        'skipped',
      ]),
      reason: known(result.reason, reasons),
    },
    database: (Array.isArray(observed.database) ? observed.database.slice(-8) : []).map((value) => {
      const failure = record(value),
        code = failure.code,
        frame = failure.frame;
      return {
        code:
          known(code, [
            'unavailable',
            'pending',
            'busy',
            'operation',
            'ECONNRESET',
            'ECONNREFUSED',
            'ETIMEDOUT',
            'EPIPE',
          ]) ?? (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown'),
        frame: typeof frame === 'string' && /^[a-zA-Z0-9-]{1,64}:[0-9]{1,6}$/.test(frame) ? frame : 'unknown',
        elapsed: count(failure.elapsed, 1200000),
      };
    }),
    pool: {
      capacity: count(pool.capacity),
      admitted: count(pool.admitted),
      total: count(pool.total),
      idle: count(pool.idle),
      used: count(pool.used),
      waiting: count(pool.waiting),
      connection_state: known(pool.connection_state, ['cooldown', 'recent_success', 'unverified']) ?? 'unknown',
    },
    providerWrites: count(providerWrites, 20),
  };
}
