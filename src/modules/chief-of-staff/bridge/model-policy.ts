import type Database from 'better-sqlite3';
import { digest } from '../domain/contracts.js';
export type ModelActivation = {
  version: 1;
  activationId: string;
  consentRef: string;
  scopeId: string;
  provider: 'codex';
  model: string;
  maxRequests: number;
  expiresAt: string;
};
export type SubscriptionActivation = Omit<ModelActivation, 'version' | 'maxRequests'> & {
  version: 2;
  runtime: 'codex-subscription/v1';
  maxAttempts: number;
  accountFingerprint: string;
  contextGeneration: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function subscriptionActivation(
  value: unknown,
  scopeId: string,
  account: string,
  now = Date.now(),
): SubscriptionActivation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as SubscriptionActivation;
  if (
    Object.keys(p).some(
      (key) =>
        ![
          'version',
          'runtime',
          'activationId',
          'consentRef',
          'scopeId',
          'provider',
          'model',
          'maxAttempts',
          'expiresAt',
          'accountFingerprint',
          'contextGeneration',
        ].includes(key),
    ) ||
    p.version !== 2 ||
    p.runtime !== 'codex-subscription/v1' ||
    !/^[a-f0-9]{64}$/.test(account) ||
    p.accountFingerprint !== account ||
    typeof p.contextGeneration !== 'string' ||
    !uuid.test(p.contextGeneration)
  )
    return null;
  const common = {
    version: 1,
    activationId: p.activationId,
    consentRef: p.consentRef,
    scopeId: p.scopeId,
    provider: p.provider,
    model: p.model,
    maxRequests: p.maxAttempts,
    expiresAt: p.expiresAt,
  };
  return modelActivation(common, scopeId, now) ? p : null;
}
export function modelActivation(value: unknown, scopeId: string, now = Date.now()): ModelActivation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as ModelActivation;
  if (
    Object.keys(p).some(
      (key) =>
        !['version', 'activationId', 'consentRef', 'scopeId', 'provider', 'model', 'maxRequests', 'expiresAt'].includes(
          key,
        ),
    ) ||
    p.version !== 1 ||
    typeof p.activationId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(p.activationId) ||
    typeof p.consentRef !== 'string' ||
    !p.consentRef.trim() ||
    p.consentRef.length > 200 ||
    p.scopeId !== scopeId ||
    p.provider !== 'codex' ||
    typeof p.model !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(p.model) ||
    !Number.isSafeInteger(p.maxRequests) ||
    p.maxRequests < 1 ||
    p.maxRequests > 1000 ||
    typeof p.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(p.expiresAt)) ||
    Date.parse(p.expiresAt) <= now
  )
    return null;
  return p;
}
export function ensureModelBudget(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cos_model_budgets (
    activation_id TEXT PRIMARY KEY, policy_digest TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS cos_model_ingress_budgets (
    activation_id TEXT NOT NULL, ingress_id TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(activation_id, ingress_id));
    CREATE TABLE IF NOT EXISTS cos_model_attempts (
    activation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, ingress_id TEXT NOT NULL,
    PRIMARY KEY(activation_id,attempt_id));`);
}
/** Durable reservation before any upstream request. Unknown outcomes consume their reservation. */
export function reserveModelRequest(db: Database.Database, policy: ModelActivation, ingressId: string): boolean {
  if (!modelActivation(policy, policy.scopeId) || !ingressId) return false;
  return reserveBudget(db, policy, policy.maxRequests, ingressId);
}
/** Counts a native turn attempt, not opaque requests inside its TLS connection. */
export function reserveSubscriptionAttempt(
  db: Database.Database,
  policy: SubscriptionActivation,
  ingressId: string,
  attemptId: string,
): boolean {
  if (!subscriptionActivation(policy, policy.scopeId, policy.accountFingerprint) || !ingressId || !uuid.test(attemptId))
    return false;
  return reserveBudget(db, policy, policy.maxAttempts, ingressId, attemptId);
}
function reserveBudget(
  db: Database.Database,
  policy: ModelActivation | SubscriptionActivation,
  max: number,
  ingressId: string,
  attemptId?: string,
): boolean {
  return db
    .transaction(() => {
      if (
        attemptId &&
        db
          .prepare('SELECT 1 FROM cos_model_attempts WHERE activation_id=? AND attempt_id=?')
          .get(policy.activationId, attemptId)
      )
        return false;
      db.prepare('INSERT OR IGNORE INTO cos_model_budgets(activation_id,policy_digest) VALUES(?,?)').run(
        policy.activationId,
        digest(policy),
      );
      const row = db
        .prepare('SELECT policy_digest,used FROM cos_model_budgets WHERE activation_id=?')
        .get(policy.activationId) as { policy_digest: string; used: number };
      if (row.policy_digest !== digest(policy) || row.used >= max) return false;
      db.prepare('INSERT OR IGNORE INTO cos_model_ingress_budgets(activation_id,ingress_id) VALUES(?,?)').run(
        policy.activationId,
        ingressId,
      );
      const ingress = db
        .prepare('SELECT used FROM cos_model_ingress_budgets WHERE activation_id=? AND ingress_id=?')
        .get(policy.activationId, ingressId) as { used: number };
      if (ingress.used >= 8) return false;
      if (attemptId)
        db.prepare('INSERT INTO cos_model_attempts(activation_id,attempt_id,ingress_id) VALUES(?,?,?)').run(
          policy.activationId,
          attemptId,
          ingressId,
        );
      db.prepare('UPDATE cos_model_budgets SET used=used+1 WHERE activation_id=?').run(policy.activationId);
      db.prepare('UPDATE cos_model_ingress_budgets SET used=used+1 WHERE activation_id=? AND ingress_id=?').run(
        policy.activationId,
        ingressId,
      );
      return true;
    })
    .immediate();
}
