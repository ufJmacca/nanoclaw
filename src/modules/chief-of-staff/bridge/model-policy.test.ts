import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { modelActivation, reserveModelRequest, ensureModelBudget } from './model-policy.js';
const policy = {
  version: 1,
  activationId: 'a'.repeat(32),
  consentRef: 'fixture-only',
  scopeId: 'fixture',
  provider: 'codex',
  model: 'fixture-model',
  maxRequests: 3,
  expiresAt: '2030-01-01T00:00:00Z',
};
describe('S01 host-owned model activation and durable budget', () => {
  it('requires an explicit bounded activation and refuses stale, foreign or incomplete profiles', () => {
    expect(modelActivation(policy, 'fixture')).toEqual(policy);
    for (const bad of [
      null,
      {},
      { ...policy, maxRequests: 0 },
      { ...policy, maxRequests: 1001 },
      { ...policy, consentRef: '' },
      { ...policy, expiresAt: '2000-01-01T00:00:00Z' },
      { ...policy, apiKey: 'must-be-separate' },
    ])
      expect(modelActivation(bad, 'fixture')).toBeNull();
    expect(modelActivation(policy, 'foreign')).toBeNull();
  });
  it('reserves before calling the model and never refunds uncertain or failed calls', () => {
    const db = new Database(':memory:');
    try {
      ensureModelBudget(db);
      const valid = modelActivation(policy, 'fixture')!;
      expect(reserveModelRequest(db, valid, 'ingress-1')).toBe(true);
      expect(reserveModelRequest(db, valid, 'ingress-1')).toBe(true);
      ensureModelBudget(db); // Reconstructing the service cannot reset the budget.
      expect(reserveModelRequest(db, valid, 'ingress-2')).toBe(true);
      expect(reserveModelRequest(db, valid, 'ingress-3')).toBe(false);
      expect(reserveModelRequest(db, { ...valid, model: 'changed-model' }, 'ingress-3')).toBe(false);
    } finally {
      db.close();
    }
  });
});
