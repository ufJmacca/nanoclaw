import { describe, it, expect } from 'vitest';
import { preflightFailure } from './preflight.js';
describe('S01 dependency diagnostics', () => {
  it.each([
    ['28P01', 'authentication_denied'],
    ['28000', 'authentication_denied'],
    ['CERT_HAS_EXPIRED', 'tls_rejected'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_rejected'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_rejected'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_rejected'],
    ['42501', 'schema_privilege_denied'],
    ['42P01', 'schema_incompatible'],
    ['ECONNREFUSED', 'unreachable'],
    ['ETIMEDOUT', 'unreachable'],
  ])('maps %s to a safe diagnostic', (code, expected) => {
    const error = preflightFailure(Object.assign(new Error('password-canary'), { code }));
    expect(error.code).toBe(expected);
    expect(JSON.stringify(error)).not.toContain('password-canary');
    expect(error.message).not.toContain('password-canary');
  });
});
