import { expect, it, vi } from 'vitest';
import { databaseReadiness } from './database-readiness.js';
import { DatabaseConfigurationError, verifyExternalHost } from '../store/config.js';
import { DatabasePreflightError, preflightFailure } from '../store/preflight.js';
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));
it('S11-PG01 preflight distinguishes DNS/TCP/TLS/AUTH/SCHEMA and excludes raw diagnostics', async () => {
  const cases: [unknown, string][] = [
    [new DatabaseConfigurationError('COS_PGPASSWORD'), 'CONFIG'],
    [preflightFailure(Object.assign(new Error('PRIVATE_SECRET'), { code: 'ENOTFOUND' })), 'DNS'],
    [preflightFailure(Object.assign(new Error('PRIVATE_SECRET'), { code: 'ECONNREFUSED' })), 'TCP'],
    [preflightFailure(Object.assign(new Error('PRIVATE_SECRET'), { code: 'CERT_HAS_EXPIRED' })), 'TLS'],
    [preflightFailure(Object.assign(new Error('PRIVATE_SECRET'), { code: '28P01' })), 'AUTH'],
    [new DatabasePreflightError('schema_incompatible'), 'SCHEMA'],
    [new Error('PRIVATE_SECRET'), 'UNAVAILABLE'],
  ];
  for (const [error, state] of cases) {
    const result = databaseReadiness(error);
    expect(result.state).toBe(state);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  }
  dns.lookup.mockRejectedValue(Object.assign(new Error('PRIVATE_DNS_PATH'), { code: 'ENOTFOUND' }));
  let failure: unknown;
  try {
    await verifyExternalHost('fixture-db.invalid');
  } catch (error) {
    if (!(error instanceof DatabaseConfigurationError)) throw error;
    failure = error;
  }
  expect(databaseReadiness(failure)).toMatchObject({ state: 'DNS' });
  expect(JSON.stringify(failure)).not.toContain('PRIVATE_DNS_PATH');
});
it('S11-PG01 successful checks and reconciliation are distinct from full live readiness', () => {
  expect(databaseReadiness(null)).toEqual({
    state: 'READY',
    currentAuthority: 'checked',
    privateContent: 'requires_scope_check',
  });
  expect(databaseReadiness('reconciling')).toEqual({
    state: 'RECONCILING',
    currentAuthority: 'unavailable',
    privateContent: 'withheld',
  });
});
