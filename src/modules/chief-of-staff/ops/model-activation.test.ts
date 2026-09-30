import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureCosBoundarySchema, installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../../db/schema.js';
import { getDeliveredIds, getDueOutboundMessages } from '../../../db/session-db.js';
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
    db = new Database(':memory:'),
    inbound = new Database(':memory:'),
    outbound = new Database(':memory:');
  inbound.exec(INBOUND_SCHEMA);
  outbound.exec(OUTBOUND_SCHEMA);
  cleanup.push(() => {
    db.close();
    inbound.close();
    outbound.close();
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
  const options = { root, db, inbound, outbound, binding, accountFingerprint, assertAuthority: vi.fn() };
  return { root, db, inbound, outbound, binding, state, context, policy, options };
}
it('resumes retained context without reviving cancelled inputs, unsent replies, scheduled output or RPC work', () => {
  const f = fixture();
  issueActivation(f.options, f.policy);
  reserveSubscriptionAttempt(f.db, f.policy, 'old-ingress', randomUUID());
  fs.writeFileSync(path.join(f.context.directory, 'history'), 'retained discussion');
  f.inbound.exec(
    "INSERT INTO messages_in(id,kind,timestamp,content) VALUES('old-input','chat','fixture','cancelled prompt')",
  );
  f.outbound.exec(`INSERT INTO messages_out(id,kind,timestamp,content) VALUES
    ('old-reply','chat','fixture','cancelled answer'),
    ('old-rpc','system','fixture','cancelled proposal'),
    ('sent','chat','fixture','already sent');
    INSERT INTO messages_out(id,kind,timestamp,content,deliver_after) VALUES('scheduled','chat','fixture','later','2999-01-01');
    INSERT INTO session_state VALUES('continuation','same native thread','fixture')`);
  f.inbound.exec("INSERT INTO delivered VALUES('sent','platform-id','delivered','original')");
  f.db
    .prepare('INSERT INTO cos_ingress_receipts(scope_id,ingress_id,received_at,projected) VALUES(?,?,?,0)')
    .run(f.binding.scopeId, 'old-ingress', 'fixture');
  const resumeId = randomUUID();
  resumeContext(f.options, f.policy.activationId, resumeId);
  // Fresh owner ingress must not make any pre-pause work deliverable again.
  f.db.exec("UPDATE cos_identity_boundaries SET ingress_id='fresh',ingress_at='fixture'");
  const pending = () => getDueOutboundMessages(f.outbound).filter((m) => !getDeliveredIds(f.inbound).has(m.id));
  expect(pending()).toEqual([]);
  expect(getDeliveredIds(f.inbound).has('scheduled')).toBe(true);
  expect(f.inbound.prepare("SELECT status,trigger,content FROM messages_in WHERE id='old-input'").get()).toEqual({
    status: 'failed',
    trigger: 0,
    content: 'cancelled prompt',
  });
  expect(f.inbound.prepare("SELECT * FROM delivered WHERE message_out_id='sent'").get()).toMatchObject({
    platform_message_id: 'platform-id',
    status: 'delivered',
    delivered_at: 'original',
  });
  expect(f.db.prepare('SELECT projected FROM cos_ingress_receipts').get()).toEqual({ projected: 1 });
  expect(f.db.prepare('SELECT used FROM cos_model_budgets').get()).toEqual({ used: 1 });
  expect(f.outbound.prepare('SELECT value FROM session_state').get()).toEqual({ value: 'same native thread' });
  expect(fs.readFileSync(path.join(f.context.directory, 'history'), 'utf8')).toBe('retained discussion');
  expect(f.state.current(f.binding, f.policy.accountFingerprint, f.context.generation)).toBe(true);
  f.outbound.exec(
    "INSERT INTO messages_out(id,kind,timestamp,content) VALUES('fresh-reply','chat','fixture','fresh answer')",
  );
  f.inbound.exec(
    "INSERT INTO messages_in(id,kind,timestamp,content) VALUES('fresh-input','chat','fixture','fresh prompt')",
  );
  resumeContext(f.options, f.policy.activationId, resumeId);
  expect(pending().map((m) => m.id)).toEqual(['fresh-reply']);
  expect(f.inbound.prepare("SELECT status FROM messages_in WHERE id='fresh-input'").get()).toEqual({
    status: 'pending',
  });
});
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
it.each(['queue', 'boundary'])('leaves CoS paused after a %s failure and requires a new deliberate resume', (stage) => {
  const f = fixture();
  issueActivation(f.options, f.policy);
  f.outbound.exec("INSERT INTO messages_out(id,kind,timestamp,content) VALUES('old','chat','fixture','old answer')");
  const target = stage === 'queue' ? f.inbound : f.db;
  target.exec(
    stage === 'queue'
      ? "CREATE TRIGGER fail_resume BEFORE INSERT ON delivered BEGIN SELECT RAISE(ABORT,'fixture interruption'); END"
      : "CREATE TRIGGER fail_resume BEFORE UPDATE OF paused ON cos_identity_boundaries WHEN NEW.paused=0 BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
  );
  const id = randomUUID();
  expect(() => resumeContext(f.options, f.policy.activationId, id)).toThrow('fixture interruption');
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  target.exec('DROP TRIGGER fail_resume');
  expect(() => resumeContext(f.options, f.policy.activationId, id)).toThrow('resume_outcome_uncertain');
  expect(resumeContext(f.options, f.policy.activationId, randomUUID())).toMatchObject({ status: 'resumed' });
  expect(getDeliveredIds(f.inbound).has('old')).toBe(true);
});
it('reconciles a lost completion receipt without cancelling later work', () => {
  const f = fixture();
  issueActivation(f.options, f.policy);
  const id = randomUUID(),
    rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (
      String(to) === path.join(f.root, 'context-resumptions', id + '.json') &&
      JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'complete'
    )
      throw new Error('lost receipt');
    return rename(from, to);
  });
  expect(() => resumeContext(f.options, f.policy.activationId, id)).toThrow('lost receipt');
  vi.restoreAllMocks();
  f.outbound.exec("INSERT INTO messages_out(id,kind,timestamp,content) VALUES('new','chat','fixture','new answer')");
  expect(resumeContext(f.options, f.policy.activationId, id)).toMatchObject({
    status: 'resume_replayed',
    paused: false,
  });
  expect(getDeliveredIds(f.inbound).has('new')).toBe(false);
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
