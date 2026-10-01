/** Trusted operator controls; these never invoke a model, send a message or wake a runner. */
import { policyAllowsBriefContext } from '../bridge/brief-context-renewal.js';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { createConversationState } from '../bridge/conversation-state.js';
import { modelActivation, subscriptionActivation, type SubscriptionActivation } from '../bridge/model-policy.js';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';

type Options = {
  root: string;
  db: Database.Database;
  binding: CosBinding;
  accountFingerprint: string;
  assertAuthority(): void;
};
type Issuance = {
  version: 1;
  bindingDigest: string;
  policy: SubscriptionActivation;
  previousDigest: string | null;
  phase: 'prepared' | 'installed';
};
function directory(root: string, name?: string) {
  const verify = (file: string) => {
    const stat = fs.lstatSync(file);
    if (
      !path.isAbsolute(file) ||
      !stat.isDirectory() ||
      fs.realpathSync(file) !== file ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw new Error('unsafe_activation_state');
  };
  verify(root);
  if (!name) return root;
  const file = path.join(root, name);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) fs.mkdirSync(file, { mode: 0o700 });
  verify(file);
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}
function boundary(o: Options, requirePaused: boolean) {
  o.assertAuthority();
  directory(o.root);
  const row = o.db
    .prepare('SELECT binding,paused FROM cos_identity_boundaries WHERE scope_id=?')
    .get(o.binding.scopeId) as { binding: string; paused: number } | undefined;
  if (!row || digest(JSON.parse(row.binding)) !== digest(o.binding) || (requirePaused && row.paused !== 1))
    throw new Error('activation_requires_paused_binding');
  return row;
}
function currentGeneration(o: Options): string {
  const row = o.db
    .prepare("SELECT generation FROM cos_conversation_states WHERE scope_id=? AND status='active'")
    .get(o.binding.scopeId) as { generation: string } | undefined;
  if (!row || !createConversationState(o.root, o.db).current(o.binding, o.accountFingerprint, row.generation))
    throw new Error('activation_context_mismatch');
  return row.generation;
}
function policyFor(o: Options, value: unknown) {
  const policy = subscriptionActivation(value, o.binding.scopeId, o.accountFingerprint);
  if (!policy || !policyAllowsBriefContext(o.db, o.binding, policy, currentGeneration(o)))
    throw new Error('activation_context_mismatch');
  return policy;
}

function active(root: string): unknown | null {
  const file = path.join(root, 'model-activation.json');
  return fs.lstatSync(file, { throwIfNoEntry: false }) ? readPrivate(file) : null;
}
function remaining(o: Options, policy: SubscriptionActivation) {
  const row = o.db
    .prepare('SELECT policy_digest,used FROM cos_model_budgets WHERE activation_id=?')
    .get(policy.activationId) as { policy_digest: string; used: number } | undefined;
  if (!row || row.policy_digest !== digest(policy) || !Number.isSafeInteger(row.used) || row.used < 0)
    throw new Error('activation_conflict');
  return Math.max(0, policy.maxAttempts - row.used);
}
/** The stable activation ID freezes consent before the first attempt, not only after usage begins. */
export function issueActivation(o: Options, value: unknown) {
  boundary(o, true);
  const policy = policyFor(o, value),
    history = directory(o.root, 'model-activations'),
    file = policy.activationId + '.json';
  const current = active(o.root),
    currentDigest = current === null ? null : digest(current);
  let record: Issuance;
  if (fs.lstatSync(path.join(history, file), { throwIfNoEntry: false })) {
    record = readPrivate<Issuance>(path.join(history, file));
    if (
      record.version !== 1 ||
      record.bindingDigest !== digest(o.binding) ||
      digest(record.policy) !== digest(policy) ||
      !['prepared', 'installed'].includes(record.phase)
    )
      throw new Error('activation_conflict');
    if (currentDigest !== digest(policy) && (record.phase === 'installed' || currentDigest !== record.previousDigest))
      throw new Error('activation_superseded');
  } else {
    if (current !== null) {
      const previous = current as SubscriptionActivation;
      if (
        previous.scopeId !== o.binding.scopeId ||
        !(
          subscriptionActivation(previous, previous.scopeId, previous.accountFingerprint, 0) ||
          modelActivation(previous, previous.scopeId, 0)
        )
      )
        throw new Error('activation_conflict');
      // Preserve an older manually configured/legacy policy as well as issued policies.
      const prior = 'previous-' + currentDigest + '.json';
      if (fs.lstatSync(path.join(history, prior), { throwIfNoEntry: false })) {
        if (digest(readPrivate(path.join(history, prior))) !== currentDigest) throw new Error('activation_conflict');
      } else writeAtomic(history, prior, current);
    }
    record = { version: 1, bindingDigest: digest(o.binding), policy, previousDigest: currentDigest, phase: 'prepared' };
    writeAtomic(history, file, record);
  }
  o.db
    .transaction(() => {
      boundary(o, true);
      policyFor(o, policy);
      o.db
        .prepare('INSERT OR IGNORE INTO cos_model_budgets(activation_id,policy_digest) VALUES(?,?)')
        .run(policy.activationId, digest(policy));
      remaining(o, policy);
    })
    .immediate();
  boundary(o, true);
  const fresh = active(o.root);
  if ((fresh === null ? null : digest(fresh)) !== currentDigest) throw new Error('activation_conflict');
  if (currentDigest !== digest(policy)) writeAtomic(o.root, 'model-activation.json', policy);
  if (record.phase !== 'installed') writeAtomic(history, file, { ...record, phase: 'installed' });
  return {
    status: 'activation_configured_paused',
    activationId: policy.activationId,
    generation: currentGeneration(o),
    remainingAttempts: remaining(o, policy),
    expiresAt: policy.expiresAt,
    live_model: 'not_verified',
  };
}
type Rebinding = {
  version: 1;
  recoveryDigest: string;
  bindingDigest: string;
  issuance: Issuance;
  next: SubscriptionActivation;
  phase: 'prepared' | 'complete';
};
/** Rebinding is not consent issuance. Only the generation may change after a verified recovery;
 * expiry, account, model, limits, usage and attempt/ingress ledgers remain unchanged. Never resumes. */
export function rebindRecoveredActivation(o: Options, request: { expectedGeneration: string; recoveryId: string }) {
  boundary(o, true);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!uuid.test(request.expectedGeneration) || !uuid.test(request.recoveryId))
    throw new Error('invalid_context_rebinding');
  const recoveryDigest = digest({ binding: o.binding, accountFingerprint: o.accountFingerprint, ...request });
  const recovery = readPrivate<{ version: number; requestDigest: string; generation: string; phase: string }>(
    path.join(directory(o.root, 'context-recoveries'), request.recoveryId + '.json'),
  );
  const guard = () => {
    boundary(o, true);
    if (
      recovery.version !== 1 ||
      recovery.phase !== 'complete' ||
      recovery.requestDigest !== recoveryDigest ||
      !uuid.test(recovery.generation) ||
      recovery.generation === request.expectedGeneration ||
      !createConversationState(o.root, o.db).current(o.binding, o.accountFingerprint, recovery.generation)
    )
      throw new Error('context_rebinding_requires_completed_recovery');
  };
  guard();
  const history = directory(o.root, 'model-context-rebindings'),
    file = request.recoveryId + '.json';
  let record: Rebinding;
  if (fs.lstatSync(path.join(history, file), { throwIfNoEntry: false })) {
    record = readPrivate<Rebinding>(path.join(history, file));
  } else {
    const current = active(o.root);
    if (current === null) return { status: 'not_transferred', reason: 'missing' };
    const policy = subscriptionActivation(current, o.binding.scopeId, o.accountFingerprint, 0);
    if (!policy || !policyAllowsBriefContext(o.db, o.binding, policy, request.expectedGeneration))
      return { status: 'not_transferred', reason: 'context_or_policy_mismatch' };
    if (Date.parse(policy.expiresAt) <= Date.now()) return { status: 'not_transferred', reason: 'expired' };
    const issuanceFile = path.join(directory(o.root, 'model-activations'), policy.activationId + '.json');
    if (!fs.lstatSync(issuanceFile, { throwIfNoEntry: false }))
      return { status: 'not_transferred', reason: 'unissued' };
    const issuance = readPrivate<Issuance>(issuanceFile);
    if (
      issuance.version !== 1 ||
      issuance.phase !== 'installed' ||
      issuance.bindingDigest !== digest(o.binding) ||
      digest(issuance.policy) !== digest(policy)
    )
      throw new Error('activation_conflict');
    if (remaining(o, policy) < 1) return { status: 'not_transferred', reason: 'exhausted' };
    record = {
      version: 1,
      recoveryDigest,
      bindingDigest: digest(o.binding),
      issuance,
      next: { ...policy, contextGeneration: recovery.generation },
      phase: 'prepared',
    };
    writeAtomic(history, file, record);
  }
  const prior = record.issuance?.policy,
    next = record.next;
  if (
    record.version !== 1 ||
    record.recoveryDigest !== recoveryDigest ||
    record.bindingDigest !== digest(o.binding) ||
    !['prepared', 'complete'].includes(record.phase) ||
    record.issuance?.version !== 1 ||
    record.issuance.phase !== 'installed' ||
    record.issuance.bindingDigest !== digest(o.binding) ||
    !subscriptionActivation(prior, o.binding.scopeId, o.accountFingerprint, 0) ||
    !policyAllowsBriefContext(o.db, o.binding, prior, request.expectedGeneration) ||
    digest(next) !== digest({ ...prior, contextGeneration: recovery.generation })
  )
    throw new Error('activation_conflict');
  const nextIssuance = { ...record.issuance, policy: next },
    issuanceRoot = directory(o.root, 'model-activations');
  const installed = () => readPrivate<Issuance>(path.join(issuanceRoot, next.activationId + '.json'));
  const result = () => ({
    status: 'rebound_paused',
    activationId: next.activationId,
    generation: next.contextGeneration,
    remainingAttempts: remaining(o, next),
    expiresAt: next.expiresAt,
    activation:
      Date.parse(next.expiresAt) <= Date.now() ? 'expired' : remaining(o, next) > 0 ? 'configured' : 'exhausted',
    live_model: 'not_verified',
  });
  if (record.phase === 'complete') {
    if (digest(active(o.root)) !== digest(next) || digest(installed()) !== digest(nextIssuance))
      throw new Error('activation_superseded');
    return result();
  }
  guard();
  if (
    ![digest(prior), digest(next)].includes(digest(active(o.root))) ||
    ![digest(record.issuance), digest(nextIssuance)].includes(digest(installed()))
  )
    throw new Error('activation_superseded');
  o.db
    .transaction(() => {
      guard();
      const budget = o.db
        .prepare('SELECT policy_digest,used FROM cos_model_budgets WHERE activation_id=?')
        .get(next.activationId) as { policy_digest: string; used: number } | undefined;
      if (
        !budget ||
        ![digest(prior), digest(next)].includes(budget.policy_digest) ||
        !Number.isSafeInteger(budget.used) ||
        budget.used < 0
      )
        throw new Error('activation_conflict');
      // No INSERT and no writes to usage: even an interrupted transfer cannot refill or reset a budget.
      o.db
        .prepare('UPDATE cos_model_budgets SET policy_digest=? WHERE activation_id=?')
        .run(digest(next), next.activationId);
    })
    .immediate();
  guard();
  if (digest(installed()) !== digest(nextIssuance))
    writeAtomic(issuanceRoot, next.activationId + '.json', nextIssuance);
  if (digest(active(o.root)) !== digest(next)) writeAtomic(o.root, 'model-activation.json', next);
  guard();
  remaining(o, next);
  writeAtomic(history, file, { ...record, phase: 'complete' });
  return result();
}
/** A repeated resume request observes the result; it can never undo a later pause. */
export function resumeContext(
  o: Options & { inbound: Database.Database; outbound: Database.Database },
  activationId: string,
  resumeId: string,
) {
  boundary(o, false);
  if (
    !/^[a-f0-9]{32}$/.test(activationId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(resumeId)
  )
    throw new Error('invalid_resume_request');
  const policy = policyFor(o, active(o.root));
  if (policy.activationId !== activationId) throw new Error('activation_superseded');
  const issuance = readPrivate<Issuance>(path.join(directory(o.root, 'model-activations'), activationId + '.json'));
  if (
    issuance.version !== 1 ||
    issuance.phase !== 'installed' ||
    issuance.bindingDigest !== digest(o.binding) ||
    digest(issuance.policy) !== digest(policy)
  )
    throw new Error('activation_conflict');
  if (remaining(o, policy) < 1) throw new Error('activation_exhausted');
  const history = directory(o.root, 'context-resumptions'),
    file = resumeId + '.json';
  const requestDigest = digest({ binding: o.binding, policy, resumeId });
  if (fs.lstatSync(path.join(history, file), { throwIfNoEntry: false })) {
    const record = readPrivate<{ version: number; requestDigest: string; phase: string }>(path.join(history, file));
    if (
      record.version !== 1 ||
      record.requestDigest !== requestDigest ||
      !['prepared', 'complete'].includes(record.phase)
    )
      throw new Error('resume_conflict');
    const paused = boundary(o, false).paused !== 0;
    if (record.phase === 'prepared') {
      // Could be an uncommitted resume or a later emergency pause. Neither permits automatic retry.
      if (paused) throw new Error('resume_outcome_uncertain');
      writeAtomic(history, file, { ...record, phase: 'complete' });
    }
    return {
      status: 'resume_replayed',
      activationId,
      generation: currentGeneration(o),
      paused,
      live_model: 'not_verified',
    };
  }
  boundary(o, true);
  writeAtomic(history, file, { version: 1, requestDigest, phase: 'prepared' });
  // The caller holds quiescent maintenance and the exclusive host lease: no old
  // worker can append after this snapshot. Retire its work before reopening the
  // boundary. A crash here leaves CoS paused; a new deliberate resume is required.
  // Completed/uncertain resume retries above never touch queues again.
  o.inbound
    .transaction(() => {
      boundary(o, true);
      o.inbound
        .prepare("UPDATE messages_in SET status='failed',trigger=0 WHERE status IN ('pending','processing')")
        .run();
      const insert = o.inbound.prepare(
        "INSERT OR IGNORE INTO delivered(message_out_id,platform_message_id,status,delivered_at) VALUES(?,NULL,'quarantined_pause',?)",
      );
      const now = new Date().toISOString();
      for (const row of o.outbound.prepare('SELECT id FROM messages_out').iterate() as Iterable<{ id: string }>)
        insert.run(row.id, now);
      boundary(o, true);
    })
    .immediate();
  o.db
    .transaction(() => {
      boundary(o, true);
      policyFor(o, active(o.root));
      if (digest(active(o.root)) !== digest(policy)) throw new Error('activation_superseded');
      if (remaining(o, policy) < 1) throw new Error('activation_exhausted');
      // Interrupted pre-pause projection must not recreate cancelled inputs.
      o.db.prepare('UPDATE cos_ingress_receipts SET projected=1 WHERE scope_id=?').run(o.binding.scopeId);
      o.db
        .prepare(
          'UPDATE cos_identity_boundaries SET paused=0,ingress_id=NULL,ingress_at=NULL WHERE scope_id=? AND paused=1',
        )
        .run(o.binding.scopeId);
    })
    .immediate();
  writeAtomic(history, file, { version: 1, requestDigest, phase: 'complete' });
  return {
    status: 'resumed',
    activationId,
    generation: currentGeneration(o),
    paused: false,
    live_model: 'not_verified',
  };
}
