import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureCosBoundarySchema, installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { createConversationState } from '../bridge/conversation-state.js';
import { ensureModelBudget, reserveSubscriptionAttempt, type SubscriptionActivation } from '../bridge/model-policy.js';
import { issueActivation, resumeContext } from './model-activation.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-model-activation-')),
    db = new Database(':memory:');
  cleanup.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  ensureCosBoundarySchema(db);
  ensureModelBudget(db);
  const binding: CosBinding = {
    scopeId: 'fixture',
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
    state = createConversationState(root, db);
  const context = state.prepare(binding, accountFingerprint);
  const policy: SubscriptionActivation = {
    version: 2,
    runtime: 'codex-subscription/v1',
    activationId: 'b'.repeat(32),
    consentRef: 'explicit fixture authority',
    scopeId: binding.scopeId,
    provider: 'codex',
    model: 'fixture-model',
    maxAttempts: 2,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    accountFingerprint,
    contextGeneration: context.generation,
  };
  const options = { root, db, binding, accountFingerprint, assertAuthority: vi.fn() };
  return { root, db, binding, state, context, policy, options };
}
it('issues exact bounded consent while paused, retains history and never refills charged usage on retry', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.context.directory, 'history'), 'retained context');
  expect(issueActivation(f.options, f.policy)).toMatchObject({
    status: 'activation_configured_paused',
    remainingAttempts: 2,
  });
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  expect(reserveSubscriptionAttempt(f.db, f.policy, 'input', randomUUID())).toBe(true);
  expect(issueActivation(f.options, f.policy)).toMatchObject({ remainingAttempts: 1 });
  expect(() => issueActivation(f.options, { ...f.policy, maxAttempts: 3 })).toThrow('activation_conflict');
  expect(fs.readFileSync(path.join(f.context.directory, 'history'), 'utf8')).toBe('retained context');
  expect(fs.statSync(path.join(f.root, 'model-activation.json')).mode & 0o777).toBe(0o600);
});
it.each(['account', 'generation', 'expiry', 'unbounded', 'extra', 'revoked', 'unpaused', 'authority'])(
  'refuses %s consent before writing activation',
  (kind) => {
    const f = fixture();
    let policy: unknown = f.policy;
    if (kind === 'account') policy = { ...f.policy, accountFingerprint: 'c'.repeat(64) };
    if (kind === 'generation') policy = { ...f.policy, contextGeneration: randomUUID() };
    if (kind === 'expiry') policy = { ...f.policy, expiresAt: '2000-01-01T00:00:00Z' };
    if (kind === 'unbounded') policy = { ...f.policy, maxAttempts: 1001 };
    if (kind === 'extra') policy = { ...f.policy, apiKey: 'must-not-be-read' };
    if (kind === 'revoked') f.state.invalidate(f.binding.scopeId, 'access_changed');
    if (kind === 'unpaused') f.db.exec('UPDATE cos_identity_boundaries SET paused=0');
    if (kind === 'authority')
      f.options.assertAuthority.mockImplementation(() => {
        throw new Error('lost authority');
      });
    expect(() => issueActivation(f.options, policy)).toThrow();
    expect(fs.existsSync(path.join(f.root, 'model-activation.json'))).toBe(false);
  },
);
it('preserves superseded consent and prevents an old issuance retry from replacing a newer policy', () => {
  const f = fixture();
  issueActivation(f.options, f.policy);
  const newer = { ...f.policy, activationId: 'c'.repeat(32), maxAttempts: 1 };
  issueActivation(f.options, newer);
  expect(() => issueActivation(f.options, f.policy)).toThrow('activation_superseded');
  expect(JSON.parse(fs.readFileSync(path.join(f.root, 'model-activation.json'), 'utf8'))).toEqual(newer);
  expect(fs.existsSync(path.join(f.root, 'model-activations', f.policy.activationId + '.json'))).toBe(true);
});
it('reconciles a failed active-file publication without minting another activation or losing charges', () => {
  const f = fixture(),
    rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === path.join(f.root, 'model-activation.json')) throw new Error('publication interrupted');
    return rename(from, to);
  });
  expect(() => issueActivation(f.options, f.policy)).toThrow('publication interrupted');
  vi.restoreAllMocks();
  expect(issueActivation(f.options, f.policy)).toMatchObject({ remainingAttempts: 2 });
  expect(f.db.prepare('SELECT count(*) AS n FROM cos_model_budgets').get()).toEqual({ n: 1 });
});
it('resumes only explicit matching consent and never undoes a later emergency pause on replay', () => {
  const f = fixture();
  issueActivation(f.options, f.policy);
  const resumeId = randomUUID();
  expect(resumeContext(f.options, f.policy.activationId, resumeId)).toMatchObject({ status: 'resumed', paused: false });
  expect(f.db.prepare('SELECT paused,ingress_id FROM cos_identity_boundaries').get()).toEqual({
    paused: 0,
    ingress_id: null,
  });
  f.db.exec('UPDATE cos_identity_boundaries SET paused=1');
  expect(resumeContext(f.options, f.policy.activationId, resumeId)).toMatchObject({
    status: 'resume_replayed',
    paused: true,
  });
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  expect(resumeContext(f.options, f.policy.activationId, randomUUID())).toMatchObject({
    status: 'resumed',
    paused: false,
  });
});
it('refuses exhausted, replaced or context-invalidated consent when resuming', () => {
  const f = fixture();
  issueActivation(f.options, f.policy);
  expect(() => resumeContext(f.options, 'd'.repeat(32), randomUUID())).toThrow();
  reserveSubscriptionAttempt(f.db, f.policy, 'input', randomUUID());
  reserveSubscriptionAttempt(f.db, f.policy, 'input', randomUUID());
  expect(() => resumeContext(f.options, f.policy.activationId, randomUUID())).toThrow('activation_exhausted');
  f.state.invalidate(f.binding.scopeId, 'access_changed');
  expect(() => resumeContext(f.options, f.policy.activationId, randomUUID())).toThrow();
});
it('reconciles activation publication after a lost receipt while preserving an intervening usage charge', () => {
  const f = fixture(),
    rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (
      String(to) === path.join(f.root, 'model-activations', f.policy.activationId + '.json') &&
      JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'installed'
    )
      throw new Error('lost issuance receipt');
    return rename(from, to);
  });
  expect(() => issueActivation(f.options, f.policy)).toThrow('lost issuance receipt');
  vi.restoreAllMocks();
  expect(reserveSubscriptionAttempt(f.db, f.policy, 'input', randomUUID())).toBe(true);
  expect(issueActivation(f.options, f.policy)).toMatchObject({ remainingAttempts: 1 });
});
it('does not replay an uncertain resume over an emergency pause; a new explicit resume identity is required', () => {
  const f = fixture();
  issueActivation(f.options, f.policy);
  const id = randomUUID(),
    rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (
      String(to) === path.join(f.root, 'context-resumptions', id + '.json') &&
      JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'complete'
    )
      throw new Error('lost resume receipt');
    return rename(from, to);
  });
  expect(() => resumeContext(f.options, f.policy.activationId, id)).toThrow('lost resume receipt');
  vi.restoreAllMocks();
  f.db.exec('UPDATE cos_identity_boundaries SET paused=1');
  expect(() => resumeContext(f.options, f.policy.activationId, id)).toThrow('resume_outcome_uncertain');
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  expect(resumeContext(f.options, f.policy.activationId, randomUUID())).toMatchObject({ status: 'resumed' });
});
