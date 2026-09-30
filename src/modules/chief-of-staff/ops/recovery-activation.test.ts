import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../../db/schema.js';
import { createConversationState } from '../bridge/conversation-state.js';
import { ensureModelBudget, reserveSubscriptionAttempt, type SubscriptionActivation } from '../bridge/model-policy.js';
import { digest } from '../domain/contracts.js';
import { issueActivation, rebindRecoveredActivation, resumeContext } from './model-activation.js';
import { recoverConversation } from './conversation-recovery.js';
import { readPrivate, writeAtomic } from './target-state.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) close();
});
async function fixture(issued = true, attempts = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-recovery-activation-'));
  const db = new Database(':memory:'),
    inbound = new Database(':memory:'),
    outbound = new Database(':memory:');
  cleanup.push(() => {
    db.close();
    inbound.close();
    outbound.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  inbound.exec(INBOUND_SCHEMA);
  outbound.exec(OUTBOUND_SCHEMA);
  ensureModelBudget(db);
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'instance',
    channelId: 'channel',
    agentGroupId: 'group',
    messagingGroupId: 'messages',
    sessionId: 'session',
    provider: 'codex',
  };
  installCosBoundary(binding, db);
  const accountFingerprint = 'a'.repeat(64),
    state = createConversationState(root, db),
    old = state.prepare(binding, accountFingerprint);
  const options = { root, db, inbound, outbound, binding, accountFingerprint, assertAuthority: vi.fn() };
  const policy: SubscriptionActivation = {
    version: 2,
    runtime: 'codex-subscription/v1',
    activationId: 'b'.repeat(32),
    consentRef: 'fixture only',
    scopeId: binding.scopeId,
    provider: 'codex',
    model: 'fixture-model',
    maxAttempts: 2,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    accountFingerprint,
    contextGeneration: old.generation,
  };
  if (issued) {
    issueActivation(options, policy);
    for (let n = 0; n < attempts; n++)
      expect(reserveSubscriptionAttempt(db, policy, 'fixture-ingress', randomUUID())).toBe(true);
  }
  const request = { expectedGeneration: old.generation, recoveryId: randomUUID() };
  const recovered = await recoverConversation({ ...options, ...request, backup: async () => {} });
  return { ...options, options, old, policy, request, recovered };
}
it('carries only the unused original consent into the recovered generation, keeping all bounds and pause', async () => {
  const f = await fixture();
  const ingressBefore = f.db.prepare('SELECT * FROM cos_model_ingress_budgets').all();
  const attemptsBefore = f.db.prepare('SELECT * FROM cos_model_attempts').all();
  expect(rebindRecoveredActivation(f.options, f.request)).toMatchObject({
    status: 'rebound_paused',
    remainingAttempts: 1,
    expiresAt: f.policy.expiresAt,
  });
  const next = readPrivate<SubscriptionActivation>(path.join(f.root, 'model-activation.json'));
  expect(next).toEqual({ ...f.policy, contextGeneration: f.recovered.generation });
  expect(f.db.prepare('SELECT used,policy_digest FROM cos_model_budgets').get()).toEqual({
    used: 1,
    policy_digest: digest(next),
  });
  expect(f.db.prepare('SELECT * FROM cos_model_ingress_budgets').all()).toEqual(ingressBefore);
  expect(f.db.prepare('SELECT * FROM cos_model_attempts').all()).toEqual(attemptsBefore);
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  expect(reserveSubscriptionAttempt(f.db, f.policy, 'old', randomUUID())).toBe(false);
  expect(resumeContext(f.options, next.activationId, randomUUID())).toMatchObject({ status: 'resumed' });
  expect(reserveSubscriptionAttempt(f.db, next, 'fresh', randomUUID())).toBe(true);
  expect(reserveSubscriptionAttempt(f.db, next, 'extra', randomUUID())).toBe(false);
  f.db.exec('UPDATE cos_identity_boundaries SET paused=1');
  expect(rebindRecoveredActivation(f.options, f.request)).toMatchObject({
    remainingAttempts: 0,
    activation: 'exhausted',
  });
  expect(f.db.prepare('SELECT used FROM cos_model_budgets').get()).toEqual({ used: 2 });
});
it.each(['expired', 'exhausted', 'missing'])(
  'does not transfer %s consent or create a fresh allowance',
  async (reason) => {
    const f = await fixture(reason !== 'missing', reason === 'exhausted' ? 2 : 1);
    const policyFile = path.join(f.root, 'model-activation.json');
    const before = fs.existsSync(policyFile) ? fs.readFileSync(policyFile, 'utf8') : null;
    const budgets = f.db.prepare('SELECT * FROM cos_model_budgets').all();
    if (reason === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.policy.expiresAt) + 1);
    expect(rebindRecoveredActivation(f.options, f.request)).toMatchObject({ status: 'not_transferred', reason });
    expect(fs.existsSync(policyFile) ? fs.readFileSync(policyFile, 'utf8') : null).toBe(before);
    expect(f.db.prepare('SELECT * FROM cos_model_budgets').all()).toEqual(budgets);
    expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  },
);
it.each(['budget', 'issuance', 'policy', 'receipt'])(
  'reconciles interruption at %s without refilling usage or unpausing',
  async (stage) => {
    const f = await fixture();
    const rename = fs.renameSync;
    if (stage === 'budget')
      f.db.exec(
        "CREATE TRIGGER fail_rebind BEFORE UPDATE OF policy_digest ON cos_model_budgets BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
      );
    else
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        const file = String(to);
        const fail =
          stage === 'issuance'
            ? file.endsWith('/model-activations/' + f.policy.activationId + '.json')
            : stage === 'policy'
              ? file === path.join(f.root, 'model-activation.json')
              : file.endsWith('/model-context-rebindings/' + f.request.recoveryId + '.json') &&
                JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'complete';
        if (fail) throw new Error('fixture interruption');
        rename(from, to);
      });
    expect(() => rebindRecoveredActivation(f.options, f.request)).toThrow('fixture interruption');
    expect(f.db.prepare('SELECT used FROM cos_model_budgets').get()).toEqual({ used: 1 });
    expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
    vi.restoreAllMocks();
    if (stage === 'budget') f.db.exec('DROP TRIGGER fail_rebind');
    expect(rebindRecoveredActivation(f.options, f.request)).toMatchObject({
      status: 'rebound_paused',
      remainingAttempts: 1,
    });
    expect(readPrivate<SubscriptionActivation>(path.join(f.root, 'model-activation.json'))).toEqual({
      ...f.policy,
      contextGeneration: f.recovered.generation,
    });
  },
);
it('requires the exact completed recovery, current binding and paused authority', async () => {
  const f = await fixture();
  expect(() => rebindRecoveredActivation(f.options, { ...f.request, recoveryId: randomUUID() })).toThrow();
  expect(() => rebindRecoveredActivation(f.options, { ...f.request, expectedGeneration: randomUUID() })).toThrow();
  f.db.exec('UPDATE cos_identity_boundaries SET paused=0');
  expect(() => rebindRecoveredActivation(f.options, f.request)).toThrow();
  expect(readPrivate<SubscriptionActivation>(path.join(f.root, 'model-activation.json'))).toEqual(f.policy);
  expect(f.db.prepare('SELECT used FROM cos_model_budgets').get()).toEqual({ used: 1 });
});
it('an interrupted transfer that expires remains expired when reconciled', async () => {
  const f = await fixture(),
    rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === path.join(f.root, 'model-activation.json')) throw new Error('fixture interruption');
    rename(from, to);
  });
  expect(() => rebindRecoveredActivation(f.options, f.request)).toThrow('fixture interruption');
  vi.restoreAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.policy.expiresAt) + 1);
  expect(rebindRecoveredActivation(f.options, f.request)).toMatchObject({
    status: 'rebound_paused',
    activation: 'expired',
    expiresAt: f.policy.expiresAt,
    remainingAttempts: 1,
  });
  const next = readPrivate<SubscriptionActivation>(path.join(f.root, 'model-activation.json'));
  expect(reserveSubscriptionAttempt(f.db, next, 'fresh', randomUUID())).toBe(false);
  expect(f.db.prepare('SELECT used FROM cos_model_budgets').get()).toEqual({ used: 1 });
});
it('rejects missing usage history instead of recreating an allowance', async () => {
  const f = await fixture();
  f.db.exec('DELETE FROM cos_model_budgets');
  expect(() => rebindRecoveredActivation(f.options, f.request)).toThrow('activation_conflict');
  expect(f.db.prepare('SELECT count(*) AS n FROM cos_model_budgets').get()).toEqual({ n: 0 });
  expect(readPrivate<SubscriptionActivation>(path.join(f.root, 'model-activation.json'))).toEqual(f.policy);
});
it('rejects transfer-journal limit changes without admitting an expanded allowance', async () => {
  const f = await fixture();
  f.db.exec(
    "CREATE TRIGGER fail_rebind BEFORE UPDATE OF policy_digest ON cos_model_budgets BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
  );
  expect(() => rebindRecoveredActivation(f.options, f.request)).toThrow('fixture interruption');
  f.db.exec('DROP TRIGGER fail_rebind');
  const directory = path.join(f.root, 'model-context-rebindings'),
    file = f.request.recoveryId + '.json';
  const record = readPrivate<{ next: SubscriptionActivation }>(path.join(directory, file));
  writeAtomic(directory, file, { ...record, next: { ...record.next, maxAttempts: 3 } });
  expect(() => rebindRecoveredActivation(f.options, f.request)).toThrow('activation_conflict');
  expect(readPrivate<SubscriptionActivation>(path.join(f.root, 'model-activation.json'))).toEqual(f.policy);
  expect(f.db.prepare('SELECT used FROM cos_model_budgets').get()).toEqual({ used: 1 });
});
