import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { createConversationState } from './conversation-state.js';
import { ensureModelBudget, reserveSubscriptionAttempt, type SubscriptionActivation } from './model-policy.js';
import { issueActivation, resumeContext, rebindRecoveredActivation } from '../ops/model-activation.js';
import { recoverConversation } from '../ops/conversation-recovery.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../../db/schema.js';
import { digest } from '../domain/contracts.js';
import { readPrivate } from '../ops/target-state.js';
import { renewBriefContext, resumeBriefContextRenewal, policyAllowsBriefContext } from './brief-context-renewal.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-brief-context-'));
  const db = new Database(':memory:');
  cleanup.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'instance',
    channelId: 'channel',
    agentGroupId: 'group',
    messagingGroupId: 'mg',
    sessionId: 'session',
    provider: 'codex',
  };
  installCosBoundary(binding, db);
  ensureModelBudget(db);
  const accountFingerprint = 'a'.repeat(64),
    state = createConversationState(root, db),
    old = state.prepare(binding, accountFingerprint);
  const policy: SubscriptionActivation = {
    version: 2,
    runtime: 'codex-subscription/v1',
    activationId: 'b'.repeat(32),
    consentRef: 'fixture',
    scopeId: binding.scopeId,
    provider: 'codex',
    model: 'fixture-model',
    maxAttempts: 3,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    accountFingerprint,
    contextGeneration: old.generation,
  };
  issueActivation({ root, db, binding, accountFingerprint, assertAuthority() {} }, policy);
  expect(reserveSubscriptionAttempt(db, policy, 'owner-ingress', randomUUID())).toBe(true);
  db.exec("UPDATE cos_identity_boundaries SET paused=0,ingress_id='owner-ingress'");
  fs.writeFileSync(path.join(old.directory, 'history'), 'old private history', { mode: 0o600 });
  const options = { root, db, binding, accountFingerprint, assertIdle: vi.fn() };
  const request = { runId: 'c'.repeat(64), runGeneration: 1, expectedGeneration: old.generation };
  return { ...options, options, old, state, policy, request };
}
it('S04 replaces only the native generation, retaining history, consent bytes and every usage ledger', () => {
  const f = fixture();
  const before = [
    'cos_model_budgets',
    'cos_model_ingress_budgets',
    'cos_model_attempts',
    'cos_identity_boundaries',
  ].map((table) => f.db.prepare('SELECT * FROM ' + table).all());
  const bytes = fs.readFileSync(path.join(f.root, 'model-activation.json'), 'utf8');
  const renewed = renewBriefContext(f.options, f.request);
  expect(renewed.generation).not.toBe(f.old.generation);
  expect(f.state.current(f.binding, f.accountFingerprint, renewed.generation)).toBe(true);
  expect(fs.readdirSync(path.join(f.root, 'conversations', renewed.generation))).toEqual([]);
  expect(fs.readFileSync(path.join(f.old.directory, 'history'), 'utf8')).toBe('old private history');
  expect(fs.readFileSync(path.join(f.root, 'model-activation.json'), 'utf8')).toBe(bytes);
  expect(
    ['cos_model_budgets', 'cos_model_ingress_budgets', 'cos_model_attempts', 'cos_identity_boundaries'].map((table) =>
      f.db.prepare('SELECT * FROM ' + table).all(),
    ),
  ).toEqual(before);
  expect(policyAllowsBriefContext(f.db, f.binding, f.policy, renewed.generation)).toBe(true);
  expect(policyAllowsBriefContext(f.db, f.binding, { ...f.policy, model: 'foreign' }, renewed.generation)).toBe(false);
  expect(policyAllowsBriefContext(f.db, f.binding, f.policy, randomUUID())).toBe(false);
  expect(renewBriefContext(f.options, f.request)).toEqual(renewed);
  expect(renewBriefContext(f.options, { ...f.request, expectedGeneration: renewed.generation })).toEqual(renewed);
  const next = renewBriefContext(f.options, {
    ...f.request,
    runId: 'd'.repeat(64),
    expectedGeneration: renewed.generation,
  });
  expect(policyAllowsBriefContext(f.db, f.binding, f.policy, next.generation)).toBe(true);
  expect(f.state.current(f.binding, f.accountFingerprint, renewed.generation)).toBe(false);
  expect(() => renewBriefContext(f.options, f.request)).toThrow('brief_context_renewal_superseded');
  expect(reserveSubscriptionAttempt(f.db, f.policy, 'brief-ingress', randomUUID())).toBe(true);
  expect(reserveSubscriptionAttempt(f.db, f.policy, 'next-ingress', randomUUID())).toBe(true);
  expect(reserveSubscriptionAttempt(f.db, f.policy, 'extra-ingress', randomUUID())).toBe(false);
});
it.each(['paused', 'invalidated', 'expired', 'exhausted', 'unissued', 'running', 'foreign-generation'])(
  'S04 refuses a new context transition when %s',
  (kind) => {
    const f = fixture();
    if (kind === 'paused') f.db.exec('UPDATE cos_identity_boundaries SET paused=1');
    if (kind === 'invalidated') f.state.invalidate(f.binding.scopeId, 'access_changed');
    if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.policy.expiresAt) + 1);
    if (kind === 'exhausted') f.db.exec('UPDATE cos_model_budgets SET used=3');
    if (kind === 'unissued') fs.unlinkSync(path.join(f.root, 'model-activations', f.policy.activationId + '.json'));
    if (kind === 'running')
      f.assertIdle.mockImplementation(() => {
        throw new Error('busy');
      });
    if (kind === 'foreign-generation') f.request.expectedGeneration = randomUUID();
    expect(() => renewBriefContext(f.options, f.request)).toThrow();
    expect(f.db.prepare('SELECT generation FROM cos_conversation_states').get()).toEqual({
      generation: f.old.generation,
    });
  },
);
it('S04 an interrupted switch finishes the recorded generation after restart without changing a later pause or refilling usage', () => {
  const f = fixture();
  f.db.exec(
    "CREATE TRIGGER interrupt_renewal BEFORE UPDATE OF generation ON cos_conversation_states BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
  );
  expect(() => renewBriefContext(f.options, f.request)).toThrow();
  const pending = f.db.prepare('SELECT * FROM cos_brief_context_renewals').get() as { generation: string };
  f.db.exec('DROP TRIGGER interrupt_renewal');
  f.db.exec('UPDATE cos_identity_boundaries SET paused=1');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.policy.expiresAt) + 1);
  resumeBriefContextRenewal(f.options);
  expect(f.state.current(f.binding, f.accountFingerprint, pending.generation)).toBe(true);
  expect(f.db.prepare('SELECT paused,ingress_id FROM cos_identity_boundaries').get()).toEqual({
    paused: 1,
    ingress_id: 'owner-ingress',
  });
  expect(f.db.prepare('SELECT used,policy_digest FROM cos_model_budgets').get()).toEqual({
    used: 1,
    policy_digest: digest(f.policy),
  });
  expect(readPrivate(path.join(f.root, 'model-activation.json'))).toEqual(f.policy);
  expect(reserveSubscriptionAttempt(f.db, f.policy, 'expired', randomUUID())).toBe(false);
});
it.each(['changed-policy', 'invalidated', 'nonempty-directory'])(
  'S04 interrupted renewal cannot override %s',
  (kind) => {
    const f = fixture();
    f.db.exec(
      "CREATE TRIGGER interrupt_renewal BEFORE UPDATE OF generation ON cos_conversation_states BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
    );
    expect(() => renewBriefContext(f.options, f.request)).toThrow();
    f.db.exec('DROP TRIGGER interrupt_renewal');
    const pending = f.db.prepare('SELECT * FROM cos_brief_context_renewals').get() as { generation: string };
    if (kind === 'changed-policy')
      fs.writeFileSync(path.join(f.root, 'model-activation.json'), JSON.stringify({ ...f.policy, maxAttempts: 4 }));
    if (kind === 'invalidated') f.state.invalidate(f.binding.scopeId, 'access_changed');
    if (kind === 'nonempty-directory')
      fs.writeFileSync(path.join(f.root, 'conversations', pending.generation, 'unexpected-history'), 'foreign');
    expect(() => resumeBriefContextRenewal(f.options)).toThrow();
    expect(f.db.prepare('SELECT generation FROM cos_conversation_states').get()).toEqual({
      generation: f.old.generation,
    });
  },
);

it.each(['resume', 'recover'])(
  'S04 operator %s preserves allowance after a scheduled context replacement',
  async (action) => {
    const f = fixture();
    const renewed = renewBriefContext(f.options, f.request);
    f.db.exec('UPDATE cos_identity_boundaries SET paused=1');
    const inbound = new Database(':memory:'),
      outbound = new Database(':memory:');
    inbound.exec(INBOUND_SCHEMA);
    outbound.exec(OUTBOUND_SCHEMA);
    cleanup.push(() => {
      inbound.close();
      outbound.close();
    });
    const options = { ...f.options, inbound, outbound, assertAuthority() {} };
    if (action === 'resume') {
      expect(resumeContext(options, f.policy.activationId, randomUUID())).toMatchObject({
        status: 'resumed',
        generation: renewed.generation,
      });
    } else {
      const request = { expectedGeneration: renewed.generation, recoveryId: randomUUID() };
      const recovered = await recoverConversation({ ...options, ...request, backup: async () => {} });
      expect(rebindRecoveredActivation(options, request)).toMatchObject({
        status: 'rebound_paused',
        remainingAttempts: 2,
        generation: recovered.generation,
      });
    }
    expect(f.db.prepare('SELECT used FROM cos_model_budgets').get()).toEqual({ used: 1 });
  },
);
it('S04 explicit operator recovery supersedes an interrupted scheduled transition', async () => {
  const f = fixture();
  f.db.exec(
    "CREATE TRIGGER interrupt_renewal BEFORE UPDATE OF generation ON cos_conversation_states BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
  );
  expect(() => renewBriefContext(f.options, f.request)).toThrow();
  f.db.exec('DROP TRIGGER interrupt_renewal');
  f.db.exec('UPDATE cos_identity_boundaries SET paused=1');
  const inbound = new Database(':memory:'),
    outbound = new Database(':memory:');
  inbound.exec(INBOUND_SCHEMA);
  outbound.exec(OUTBOUND_SCHEMA);
  cleanup.push(() => {
    inbound.close();
    outbound.close();
  });
  const recovered = await recoverConversation({
    ...f.options,
    inbound,
    outbound,
    expectedGeneration: f.old.generation,
    recoveryId: randomUUID(),
    assertAuthority() {},
    backup: async () => {},
  });
  expect(() => resumeBriefContextRenewal(f.options)).not.toThrow();
  expect(f.state.current(f.binding, f.accountFingerprint, recovered.generation)).toBe(true);
});
