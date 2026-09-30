import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  modelActivation,
  reserveModelRequest,
  ensureModelBudget,
  subscriptionActivation,
  reserveSubscriptionAttempt,
} from './model-policy.js';
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
  it('binds subscription consent to the account and context, charging each attempt once without refunds', () => {
    const native = {
      version: 2,
      runtime: 'codex-subscription/v1',
      activationId: 'b'.repeat(32),
      consentRef: 'fixture',
      scopeId: 'fixture',
      provider: 'codex',
      model: 'fixture-model',
      maxAttempts: 2,
      accountFingerprint: 'a'.repeat(64),
      contextGeneration: '11111111-1111-4111-8111-111111111111',
      expiresAt: '2030-01-01T00:00:00Z',
    };
    expect(subscriptionActivation(native, 'fixture', 'a'.repeat(64))).toEqual(native);
    expect(subscriptionActivation(native, 'fixture', 'b'.repeat(64))).toBeNull();
    expect(subscriptionActivation(policy, 'fixture', 'a'.repeat(64))).toBeNull();
    expect(subscriptionActivation({ ...native, maxRequests: 100 }, 'fixture', 'a'.repeat(64))).toBeNull();
    const db = new Database(':memory:');
    try {
      ensureModelBudget(db);
      const admitted = subscriptionActivation(native, 'fixture', 'a'.repeat(64))!;
      expect(reserveSubscriptionAttempt(db, admitted, 'ingress', '11111111-1111-4111-8111-111111111111')).toBe(true);
      expect(reserveSubscriptionAttempt(db, admitted, 'ingress', '11111111-1111-4111-8111-111111111111')).toBe(false);
      ensureModelBudget(db);
      expect(reserveSubscriptionAttempt(db, admitted, 'ingress', '22222222-2222-4222-8222-222222222222')).toBe(true);
      expect(reserveSubscriptionAttempt(db, admitted, 'new-ingress', '33333333-3333-4333-8333-333333333333')).toBe(
        false,
      );
    } finally {
      db.close();
    }
  });
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
