import { expect, it } from 'vitest';
import { draftReplayFailureMetadata } from './draft-fixture-diagnostics.js';

it('retains the bounded unavailable response and cooldown evidence without provider content', () => {
  const result = draftReplayFailureMetadata(
    { status: 'unavailable', result: {} },
    {
      database: [{ code: 'unavailable', frame: 'client:114', elapsed: 613 }],
      pool: { capacity: 25, admitted: 0, total: 0, idle: 0, used: 0, waiting: 0, connection_state: 'cooldown' },
    },
    5,
  );
  expect(result.rpc).toEqual({ status: 'unavailable', draftStatus: null, reason: null });
  expect(result.database).toEqual([{ code: 'unavailable', frame: 'client:114', elapsed: 613 }]);
  expect(result.pool.connection_state).toBe('cooldown');
  expect(result.providerWrites).toBe(5);
});

it('never emits arbitrary response, database, pool, body or credential strings', () => {
  const secret = 'DO_NOT_LOG_TEST_PASSWORD';
  const result = draftReplayFailureMetadata(
    { status: secret, token: secret, result: { draft_status: secret, reason: secret, reply_text: secret } },
    {
      database: [{ code: secret, frame: '/private/' + secret, elapsed: secret, message: secret, stack: secret }],
      pool: Object.fromEntries(
        ['capacity', 'admitted', 'total', 'idle', 'used', 'waiting', 'connection_state', 'password'].map((key) => [
          key,
          secret,
        ]),
      ),
    },
    secret,
  );
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.rpc).toEqual({ status: 'unknown', draftStatus: null, reason: null });
  expect(result.database).toEqual([{ code: 'unknown', frame: 'unknown', elapsed: null }]);
  expect(result.providerWrites).toBeNull();
});

it('bounds failure history and rejects nonfinite or out-of-range measurements', () => {
  const result = draftReplayFailureMetadata(
    { status: 'denied', result: { reason: 'mail_draft_daily_limit' } },
    {
      database: Array.from({ length: 100 }, () => ({ code: '23505', frame: 'store:123', elapsed: Infinity })),
      pool: { capacity: -1, admitted: Infinity, total: '5', idle: 2 ** 60, used: 0, waiting: 0 },
    },
    -1,
  );
  expect(result.database).toHaveLength(8);
  expect(result.database.every((row) => row.code === '23505' && row.elapsed === null)).toBe(true);
  expect(result.pool).toMatchObject({ capacity: null, admitted: null, total: null, idle: null, used: 0, waiting: 0 });
  expect(result.rpc.reason).toBe('mail_draft_daily_limit');
  expect(result.providerWrites).toBeNull();
});

it('accepts missing or malformed diagnostic resources without masking the original assertion', () => {
  const result = draftReplayFailureMetadata(null, ['unexpected'], undefined);
  expect(result.rpc.status).toBe('unknown');
  expect(result.database).toEqual([]);
  expect(result.pool.connection_state).toBe('unknown');
  expect(result.providerWrites).toBeNull();
});
