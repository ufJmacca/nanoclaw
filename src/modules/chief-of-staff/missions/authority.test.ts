import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  root: '/tmp/cos-mission-authority-' + process.pid,
  release: vi.fn(() => true),
  owner: vi.fn(),
}));
vi.mock('../../../config.js', async () => ({
  ...(await vi.importActual('../../../config.js')),
  DATA_DIR: f.root + '/data',
  GROUPS_DIR: f.root + '/groups',
}));
vi.mock('../../../release-runtime.js', () => ({ releaseMode: f.release, currentRelease: () => ({}) }));
vi.mock('../../../providers/codex-subscription-coordinator.js', () => ({ subscriptionCoordinator: f.owner }));
import { initTestDb, getDb, closeDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import {
  subscribeMattermostChannelStrict,
  validateMattermostSessionForExecution,
} from '../../../channels/mattermost-subscription.js';
import { resolveSession } from '../../../session-manager.js';
import { installCosBoundary, cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { getSession, updateSession } from '../../../db/sessions.js';
import { createConversationState } from '../bridge/conversation-state.js';
import { issueActivation } from '../ops/model-activation.js';
import { renewBriefContext } from '../bridge/brief-context-renewal.js';
import { ensureModelBudget, reserveSubscriptionAttempt, type SubscriptionActivation } from '../bridge/model-policy.js';
import { configureDelegation } from './delegation.js';
import { RESEARCH_TEMPLATE } from './work-order.js';
import { digest } from '../domain/contracts.js';
import { writeAtomic } from '../ops/target-state.js';
import { createMissionAuthorityResolver } from './authority.js';
import { createTeamAuthorityResolver } from './team-authority.js';
import { configureTeamAdmission, TEAM_ADMISSION_POLICY } from './team-admission.js';
import { TEAM_TEMPLATES } from '../contracts/team-templates.js';
beforeEach(() => {
  fs.mkdirSync(f.root, { mode: 0o700 });
  runMigrations(initTestDb());
  f.release.mockReturnValue(true);
});
afterEach(() => {
  closeDb();
  fs.rmSync(f.root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture() {
  const db = getDb(),
    root = path.join(f.root, 'target');
  fs.mkdirSync(root, { mode: 0o700 });
  const group = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: 'private' });
  const session = resolveSession(group.agentGroup.id, group.messagingGroup.id, null, 'shared').session;
  updateSession(session.id, { agent_provider: 'codex' });
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'fixture',
    channelId: 'private',
    agentGroupId: group.agentGroup.id,
    messagingGroupId: group.messagingGroup.id,
    sessionId: session.id,
    provider: 'codex',
  };
  installCosBoundary(binding, db);
  ensureModelBudget(db);
  const accountFingerprint = createHash('sha256').update('fixture-account').digest('hex');
  const retained = createConversationState(root, db).prepare(binding, accountFingerprint);
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
    contextGeneration: retained.generation,
  };
  issueActivation({ root, db, binding, accountFingerprint, assertAuthority() {} }, policy);
  const change = {
    expectedRevision: 0,
    enabled: true,
    templateDigest: digest(RESEARCH_TEMPLATE),
    reviewRef: 'fixture-review',
  };
  const delegation = configureDelegation(root, binding, randomUUID(), change);
  db.exec('UPDATE cos_identity_boundaries SET paused=0');
  expect(validateMattermostSessionForExecution(getSession(session.id)!)).toMatchObject({ strict: true, valid: true });
  expect(cosBoundary(getSession(session.id)!, db)).toMatchObject({ restricted: true, paused: false, binding });
  const owner = {
    cached: vi.fn(() => ({ authJson: JSON.stringify({ tokens: { account_id: 'fixture-account' } }) })),
    prepare: vi.fn(),
  };
  f.owner.mockReturnValue(owner);
  const context = {
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    agentGroupId: binding.agentGroupId,
    sessionId: binding.sessionId,
    ingressId: 'original-owner-event',
  };
  const admitted = vi.fn(() => true),
    assertHostAuthority = vi.fn();
  const resolver = createMissionAuthorityResolver({ targetRoot: root, db, admitted, assertHostAuthority });
  const teamResolver = createTeamAuthorityResolver({ targetRoot: root, db, missionAuthority: resolver });
  const teamChange = {
    expectedRevision: 0,
    enabled: true,
    templateBundleDigest: digest(TEAM_TEMPLATES),
    policyDigest: digest(TEAM_ADMISSION_POLICY),
    reviewRef: 'fixture-reviewed-team',
  };
  return {
    db,
    root,
    binding,
    accountFingerprint,
    retained,
    policy,
    change,
    delegation,
    context,
    owner,
    admitted,
    assertHostAuthority,
    resolver,
    teamResolver,
    teamChange,
  };
}
it('S05-T03 derives only current host-owned mission pins without preparing context or reserving model use', () => {
  const t = fixture();
  const before = t.db.serialize(),
    files = fs.readdirSync(t.root, { recursive: true });
  expect(t.resolver(t.context)).toEqual({
    bindingDigest: digest(t.binding),
    delegationDigest: digest(t.delegation),
    contextGeneration: t.retained.generation,
    provider: { profile: RESEARCH_TEMPLATE.providerProfile, model: t.policy.model, policyDigest: digest(t.policy) },
  });
  expect(t.resolver(t.context)).not.toBeNull();
  expect(t.db.serialize()).toEqual(before);
  expect(fs.readdirSync(t.root, { recursive: true })).toEqual(files);
  expect(t.owner.prepare).not.toHaveBeenCalled();
});
it.each([
  'paused',
  'maintenance',
  'host-lease',
  'subscription',
  'native-session',
  'wrong-owner',
  'wrong-scope',
  'wrong-group',
  'wrong-session',
  'no-delegation',
  'disabled',
  'expired-policy',
  'foreign-account',
  'invalidated-context',
  'missing-context',
  'missing-directory',
  'foreign-owner-receipt',
  'unreleased',
])('S05-T03 denies %s without repairing state', (kind) => {
  const t = fixture();
  configureTeamAdmission(t.root, t.binding, randomUUID(), t.teamChange);
  if (kind === 'paused') t.db.exec('UPDATE cos_identity_boundaries SET paused=1');
  if (kind === 'maintenance') t.admitted.mockReturnValue(false);
  if (kind === 'host-lease')
    t.assertHostAuthority.mockImplementation(() => {
      throw Error('lost');
    });
  if (kind === 'subscription') {
    t.db.prepare("UPDATE sessions SET status='closed' WHERE id=?").run(t.binding.sessionId);
    t.db.exec("UPDATE mattermost_subscriptions SET status='unsubscribed'");
  }
  if (kind === 'native-session')
    t.db.prepare("UPDATE sessions SET status='archived' WHERE id=?").run(t.binding.sessionId);
  if (kind === 'wrong-owner') t.context.ownerId = 'foreign';
  if (kind === 'wrong-scope') t.context.scopeId = 'foreign';
  if (kind === 'wrong-group') t.context.agentGroupId = 'foreign';
  if (kind === 'wrong-session') t.context.sessionId = 'foreign';
  if (kind === 'no-delegation')
    fs.unlinkSync(path.join(t.root, 'mission-delegation-' + digest(t.binding.scopeId) + '.json'));
  if (kind === 'disabled')
    configureDelegation(t.root, t.binding, randomUUID(), { ...t.change, expectedRevision: 1, enabled: false });
  if (kind === 'expired-policy')
    writeAtomic(t.root, 'model-activation.json', { ...t.policy, expiresAt: '2000-01-01T00:00:00Z' });
  if (kind === 'foreign-account')
    t.owner.cached.mockReturnValue({ authJson: JSON.stringify({ tokens: { account_id: 'foreign' } }) });
  if (kind === 'invalidated-context') t.db.exec("UPDATE cos_conversation_states SET status='invalidated'");
  if (kind === 'missing-context') t.db.exec('DELETE FROM cos_conversation_states');
  if (kind === 'missing-directory') fs.rmSync(t.retained.directory, { recursive: true });
  if (kind === 'foreign-owner-receipt')
    writeAtomic(path.join(t.root, 'conversation-owners'), t.retained.generation + '.json', {
      version: 1,
      generation: t.retained.generation,
      bindingDigest: digest(t.binding),
      accountFingerprint: 'f'.repeat(64),
      state: 'retained',
    });
  if (kind === 'unreleased') f.release.mockReturnValue(false);
  const before = t.db.serialize(),
    files = fs.readdirSync(t.root, { recursive: true });
  expect(t.resolver(t.context)).toBeNull();
  expect(t.teamResolver(t.context)).toBeNull();
  expect(t.db.serialize()).toEqual(before);
  expect(fs.readdirSync(t.root, { recursive: true })).toEqual(files);
});
it('S06-T01/T05 single-worker delegation cannot implicitly enable team work or create another context', () => {
  const t = fixture();
  expect(t.resolver(t.context)).not.toBeNull();
  expect(t.teamResolver(t.context)).toBeNull();
  const record = configureTeamAdmission(t.root, t.binding, randomUUID(), t.teamChange);
  const before = t.db.serialize(),
    files = fs.readdirSync(t.root, { recursive: true });
  expect(t.teamResolver(t.context)).toEqual({
    ...t.resolver(t.context),
    templateBundleDigest: digest(TEAM_TEMPLATES),
    teamPolicyDigest: digest(record),
  });
  expect(t.teamResolver(t.context)?.contextGeneration).toBe(t.retained.generation);
  expect(t.db.serialize()).toEqual(before);
  expect(fs.readdirSync(t.root, { recursive: true })).toEqual(files);
  expect(t.owner.prepare).not.toHaveBeenCalled();
});
it('S06-T03/T05 reviewed team revision fences old graph authority without resetting parent permissions', () => {
  const t = fixture();
  configureTeamAdmission(t.root, t.binding, randomUUID(), t.teamChange);
  const original = t.teamResolver(t.context)!;
  configureTeamAdmission(t.root, t.binding, randomUUID(), { ...t.teamChange, expectedRevision: 1, enabled: false });
  expect(t.teamResolver(t.context)).toBeNull();
  expect(t.resolver(t.context)).not.toBeNull();
  configureTeamAdmission(t.root, t.binding, randomUUID(), { ...t.teamChange, expectedRevision: 2 });
  const next = t.teamResolver(t.context)!;
  expect(next.teamPolicyDigest).not.toBe(original.teamPolicyDigest);
  expect(next.delegationDigest).toBe(original.delegationDigest);
  expect(next.provider).toEqual(original.provider);
  expect(next.contextGeneration).toBe(original.contextGeneration);
});
it('S06-T05 tampered team policy or owner record cannot renew the original authority', () => {
  const t = fixture();
  const record = configureTeamAdmission(t.root, t.binding, randomUUID(), t.teamChange);
  for (const patch of [
    { policyDigest: 'a'.repeat(64) },
    { ownerId: 'foreign' },
    { templateBundleDigest: 'b'.repeat(64) },
  ]) {
    writeAtomic(t.root, 'team-admission-' + digest(t.binding.scopeId) + '.json', { ...record, ...patch });
    expect(t.teamResolver(t.context)).toBeNull();
    expect(t.resolver(t.context)).not.toBeNull();
  }
});
it('S05-T07 approved brief renewal changes the admitted generation while preserving the policy and allowance', () => {
  const t = fixture(),
    old = t.resolver(t.context)!;
  const renewed = renewBriefContext(
    { root: t.root, db: t.db, binding: t.binding, accountFingerprint: t.accountFingerprint, assertIdle() {} },
    { runId: 'c'.repeat(64), runGeneration: 1, expectedGeneration: t.retained.generation },
  );
  expect(t.resolver(t.context)).toEqual({ ...old, contextGeneration: renewed.generation });
  t.db.exec("UPDATE cos_brief_context_renewals SET status='preparing'");
  expect(t.resolver(t.context)).toBeNull();
});
it('S05-T07 disabling and re-enabling produces a different authority pin even with the same template', () => {
  const t = fixture(),
    old = t.resolver(t.context)!;
  configureDelegation(t.root, t.binding, randomUUID(), { ...t.change, expectedRevision: 1, enabled: false });
  expect(t.resolver(t.context)).toBeNull();
  configureDelegation(t.root, t.binding, randomUUID(), { ...t.change, expectedRevision: 2 });
  const next = t.resolver(t.context)!;
  expect(next.delegationDigest).not.toBe(old.delegationDigest);
  expect(next.provider).toEqual(old.provider);
  expect(next.contextGeneration).toBe(old.contextGeneration);
});
it('S05-T09 the final already-reserved turn retains read authority without replenishing its allowance', () => {
  const t = fixture(),
    authority = t.resolver(t.context);
  for (let i = 0; i < t.policy.maxAttempts; i++)
    expect(reserveSubscriptionAttempt(t.db, t.policy, 'event', randomUUID())).toBe(true);
  const before = t.db.prepare('SELECT * FROM cos_model_budgets').all();
  expect(t.resolver(t.context)).toEqual(authority);
  expect(reserveSubscriptionAttempt(t.db, t.policy, 'event', randomUUID())).toBe(false);
  expect(t.db.prepare('SELECT * FROM cos_model_budgets').all()).toEqual(before);
});
it('S05-T03 no initial context, altered policy generation or unavailable credential owner can create mission authority', () => {
  const t = fixture();
  writeAtomic(t.root, 'model-activation.json', { ...t.policy, contextGeneration: randomUUID() });
  expect(t.resolver(t.context)).toBeNull();
  writeAtomic(t.root, 'model-activation.json', t.policy);
  f.owner.mockReturnValue(null);
  expect(t.resolver(t.context)).toBeNull();
  f.owner.mockReturnValue(t.owner);
  t.db.exec('DROP TABLE cos_conversation_states');
  const before = t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  expect(t.resolver(t.context)).toBeNull();
  expect(t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual(before);
});
