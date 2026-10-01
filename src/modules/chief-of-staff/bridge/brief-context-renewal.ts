/** Host-only replacement of a stale calendar context for an admitted scheduled brief.
 * Retains all history and the exact issued consent; never changes queues, ingress, pause or usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { hasTable } from '../../../db/connection.js';
import { digest } from '../domain/contracts.js';
import { subscriptionActivation, type SubscriptionActivation } from './model-policy.js';
import { readPrivate } from '../ops/target-state.js';
import {
  contextGenerationPattern,
  privateConversationDirectory,
  syncConversationDirectory,
  rememberConversationOwner,
} from '../ops/conversation-ownership.js';

type Options = {
  root: string;
  db: Database.Database;
  binding: CosBinding;
  accountFingerprint: string;
  assertIdle(): void;
};
export type BriefContextRenewalRequest = { runId: string; runGeneration: number; expectedGeneration: string };
type Row = { generation: string; binding_digest: string; account_fingerprint: string; status: string };
type Renewal = {
  id: string;
  scope_id: string;
  binding_digest: string;
  account_fingerprint: string;
  policy_digest: string;
  policy_generation: string;
  activation_id: string;
  expected_generation: string;
  generation: string;
  status: 'preparing' | 'complete';
};
function schema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS cos_brief_context_renewals (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, binding_digest TEXT NOT NULL, account_fingerprint TEXT NOT NULL,
    policy_digest TEXT NOT NULL, policy_generation TEXT NOT NULL, activation_id TEXT NOT NULL,
    expected_generation TEXT NOT NULL, generation TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('preparing','complete','superseded')));
    CREATE UNIQUE INDEX IF NOT EXISTS cos_brief_context_renewal_pending ON cos_brief_context_renewals(scope_id) WHERE status='preparing';`);
}
function row(o: Options): Row {
  const value = o.db.prepare('SELECT * FROM cos_conversation_states WHERE scope_id=?').get(o.binding.scopeId) as
    | Row
    | undefined;
  if (
    !value ||
    value.status !== 'active' ||
    value.binding_digest !== digest(o.binding) ||
    value.account_fingerprint !== o.accountFingerprint
  )
    throw new Error('brief_context_identity_changed');
  return value;
}
function guard(o: Options, pausedAllowed: boolean) {
  o.assertIdle();
  privateConversationDirectory(o.root);
  const boundary = o.db
    .prepare('SELECT binding,paused FROM cos_identity_boundaries WHERE scope_id=?')
    .get(o.binding.scopeId) as { binding: string; paused: number } | undefined;
  if (
    !boundary ||
    digest(JSON.parse(boundary.binding)) !== digest(o.binding) ||
    (!pausedAllowed && boundary.paused !== 0)
  )
    throw new Error('brief_context_identity_changed');
  row(o);
}
function issued(o: Options, now: number): SubscriptionActivation {
  const policy = subscriptionActivation(
    readPrivate(path.join(o.root, 'model-activation.json')),
    o.binding.scopeId,
    o.accountFingerprint,
    now,
  );
  if (!policy) throw new Error('brief_context_consent_unavailable');
  privateConversationDirectory(path.join(o.root, 'model-activations'));
  const issuance = readPrivate<{
    version: number;
    phase: string;
    bindingDigest: string;
    policy: SubscriptionActivation;
  }>(path.join(o.root, 'model-activations', policy.activationId + '.json'));
  const budget = o.db
    .prepare('SELECT used,policy_digest FROM cos_model_budgets WHERE activation_id=?')
    .get(policy.activationId) as { used: number; policy_digest: string } | undefined;
  if (
    issuance.version !== 1 ||
    issuance.phase !== 'installed' ||
    issuance.bindingDigest !== digest(o.binding) ||
    digest(issuance.policy) !== digest(policy) ||
    !budget ||
    budget.policy_digest !== digest(policy) ||
    !Number.isSafeInteger(budget.used) ||
    budget.used < 0
  )
    throw new Error('brief_context_consent_unavailable');
  if (now !== 0 && budget.used >= policy.maxAttempts) throw new Error('brief_context_consent_exhausted');
  return policy;
}
/** A recorded replacement remains bound to the unchanged policy digest and original generation. */
export function policyAllowsBriefContext(
  db: Database.Database,
  binding: CosBinding,
  policy: SubscriptionActivation,
  generation: string,
): boolean {
  if (policy.contextGeneration === generation) return true;
  if (!hasTable(db, 'cos_brief_context_renewals')) return false;
  return !!db
    .prepare(
      "SELECT 1 FROM cos_brief_context_renewals WHERE scope_id=? AND binding_digest=? AND account_fingerprint=? AND activation_id=? AND policy_digest=? AND policy_generation=? AND generation=? AND status='complete'",
    )
    .get(
      binding.scopeId,
      digest(binding),
      policy.accountFingerprint,
      policy.activationId,
      digest(policy),
      policy.contextGeneration,
      generation,
    );
}
function complete(o: Options, renewal: Renewal) {
  guard(o, true);
  const policy = issued(o, 0),
    current = row(o);
  if (
    renewal.scope_id !== o.binding.scopeId ||
    renewal.binding_digest !== digest(o.binding) ||
    renewal.account_fingerprint !== o.accountFingerprint ||
    renewal.policy_digest !== digest(policy) ||
    renewal.policy_generation !== policy.contextGeneration ||
    renewal.activation_id !== policy.activationId ||
    !contextGenerationPattern.test(renewal.generation) ||
    !contextGenerationPattern.test(renewal.expected_generation) ||
    renewal.generation === renewal.expected_generation
  )
    throw new Error('brief_context_renewal_conflict');
  if (renewal.status === 'complete') {
    if (current.generation !== renewal.generation) throw new Error('brief_context_renewal_superseded');
    privateConversationDirectory(path.join(o.root, 'conversations', renewal.generation));
    return { generation: renewal.generation };
  }
  if (
    renewal.status !== 'preparing' ||
    current.generation !== renewal.expected_generation ||
    !policyAllowsBriefContext(o.db, o.binding, policy, current.generation)
  )
    throw new Error('brief_context_renewal_conflict');
  const root = path.join(o.root, 'conversations'),
    directory = path.join(root, renewal.generation);
  privateConversationDirectory(root);
  privateConversationDirectory(path.join(root, current.generation));
  rememberConversationOwner(o.root, o.binding, o.accountFingerprint, current.generation);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
  privateConversationDirectory(directory);
  if (fs.readdirSync(directory).length) throw new Error('brief_context_renewal_not_empty');
  syncConversationDirectory(directory);
  syncConversationDirectory(root);
  rememberConversationOwner(o.root, o.binding, o.accountFingerprint, renewal.generation);
  o.db
    .transaction(() => {
      guard(o, true);
      if (row(o).generation !== renewal.expected_generation || digest(issued(o, 0)) !== renewal.policy_digest)
        throw new Error('brief_context_renewal_conflict');
      o.db
        .prepare(
          "UPDATE cos_conversation_states SET generation=?,reason=NULL,updated_at=? WHERE scope_id=? AND generation=? AND status='active'",
        )
        .run(renewal.generation, new Date().toISOString(), o.binding.scopeId, renewal.expected_generation);
      o.db
        .prepare("UPDATE cos_brief_context_renewals SET status='complete' WHERE id=? AND status='preparing'")
        .run(renewal.id);
    })
    .immediate();
  return { generation: renewal.generation };
}
/** Finish only an already-admitted transition. Does not create consent, unpause or dispatch work. */
export function resumeBriefContextRenewal(o: Options): void {
  if (!hasTable(o.db, 'cos_brief_context_renewals')) return;
  const pending = o.db
    .prepare("SELECT * FROM cos_brief_context_renewals WHERE scope_id=? AND status='preparing'")
    .get(o.binding.scopeId) as Renewal | undefined;
  if (pending) complete(o, pending);
}
/** Caller has just revalidated the approved run and private channel and holds owner/idle fences. */
export function renewBriefContext(o: Options, request: BriefContextRenewalRequest): { generation: string } {
  if (
    !/^[a-f0-9]{64}$/.test(request.runId) ||
    !Number.isSafeInteger(request.runGeneration) ||
    request.runGeneration < 1 ||
    !contextGenerationPattern.test(request.expectedGeneration)
  )
    throw new Error('invalid_brief_context_renewal');
  guard(o, false);
  schema(o.db);
  const id = digest({ binding: o.binding, runId: request.runId, runGeneration: request.runGeneration });
  const existing = o.db.prepare('SELECT * FROM cos_brief_context_renewals WHERE id=?').get(id) as Renewal | undefined;
  if (existing) {
    if (
      existing.expected_generation !== request.expectedGeneration &&
      !(existing.status === 'complete' && existing.generation === request.expectedGeneration)
    )
      throw new Error('brief_context_renewal_conflict');
    return complete(o, existing);
  }
  const policy = issued(o, Date.now()),
    current = row(o);
  if (
    current.generation !== request.expectedGeneration ||
    !policyAllowsBriefContext(o.db, o.binding, policy, current.generation)
  )
    throw new Error('brief_context_renewal_conflict');
  const renewal: Renewal = {
    id,
    scope_id: o.binding.scopeId,
    binding_digest: digest(o.binding),
    account_fingerprint: o.accountFingerprint,
    policy_digest: digest(policy),
    policy_generation: policy.contextGeneration,
    activation_id: policy.activationId,
    expected_generation: current.generation,
    generation: randomUUID(),
    status: 'preparing',
  };
  o.db
    .prepare(
      'INSERT INTO cos_brief_context_renewals VALUES(@id,@scope_id,@binding_digest,@account_fingerprint,@policy_digest,@policy_generation,@activation_id,@expected_generation,@generation,@status)',
    )
    .run(renewal);
  return complete(o, renewal);
}

/** Explicit operator recovery owns this supersession; runtime retries cannot revive it. */
export function supersedeBriefContextRenewals(
  db: Database.Database,
  scopeId: string,
  expectedGeneration: string,
): void {
  if (hasTable(db, 'cos_brief_context_renewals'))
    db.prepare(
      "UPDATE cos_brief_context_renewals SET status='superseded' WHERE scope_id=? AND expected_generation=? AND status='preparing'",
    ).run(scopeId, expectedGeneration);
}
