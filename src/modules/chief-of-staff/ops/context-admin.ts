/** Owner-run local controls. No model calls, credential refresh or message sends. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { initDb, closeDb } from '../../../db/connection.js';
import { getSession } from '../../../db/sessions.js';
import {
  acquireHostExecutionLease,
  assertHostExecutionLease,
  releaseHostExecutionLease,
  type HostExecutionLease,
} from '../../../db/host-execution-lease.js';
import { validateMattermostSessionForExecution } from '../../../channels/mattermost-subscription.js';
import { NodeMattermostTransport } from '../../../channels/mattermost-client.js';
import { openInboundDb, openOutboundDb } from '../../../session-manager.js';
import { createMattermostFacts } from '../bridge/mattermost-facts.js';
import { validPrivateChannel, type ChannelFacts } from '../bridge/identity.js';
import { createConversationState } from '../bridge/conversation-state.js';
import { subscriptionActivation } from '../bridge/model-policy.js';
import { digest } from '../domain/contracts.js';
import { localTarget } from './target-identity.js';
import { acquireTargetLock, readPrivate, type TargetState } from './target-state.js';
import { activeMaintenanceLease, assertMaintenanceLease } from './maintenance.js';
import { targetCommands } from './target-host.js';
import { backupNativeDatabase } from './native-installation.js';
import { backupConversations } from './conversation-backup.js';
import { recoverConversation } from './conversation-recovery.js';
import { issueActivation, resumeContext, rebindRecoveredActivation } from './model-activation.js';

import { isKnowledgeCommand, runKnowledgeAdmin, type KnowledgeAdminArguments } from './knowledge-admin.js';

export type ContextAdminArguments =
  | KnowledgeAdminArguments
  | { command: 'context-status'; scopeId: string }
  | { command: 'context-prepare'; scopeId: string }
  | { command: 'model-activate'; scopeId: string; policyFile: string }
  | { command: 'context-resume'; scopeId: string; activationId: string; resumeId: string }
  | { command: 'context-recover'; scopeId: string; expectedGeneration: string; recoveryId: string };
type Dependencies = {
  target(root: string): TargetState;
  quiescent(target: TargetState): Promise<boolean>;
  facts(binding: CosBinding): Promise<ChannelFacts>;
};
function privateDirectory(directory: string) {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    fs.realpathSync(directory) !== directory ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_context_admin_state');
}
function accountBinding(root: string): string | null {
  const directory = path.join(root, 'codex-auth');
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) return null;
  privateDirectory(directory);
  const file = path.join(directory, 'account-binding.json');
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null;
  const value = readPrivate<{ accountHash: string; sourcePathHash: string }>(file);
  if (
    !/^[a-f0-9]{64}$/.test(value.accountHash) ||
    value.sourcePathHash !==
      createHash('sha256')
        .update(path.join(os.homedir(), '.codex', 'auth.json'))
        .digest('hex')
  )
    throw new Error('subscription_account_binding_unavailable');
  return value.accountHash;
}
function bindingFor(db: Database.Database, scope: string): CosBinding {
  const row = db.prepare('SELECT binding FROM cos_identity_boundaries WHERE scope_id=?').get(scope) as
    | { binding: string }
    | undefined;
  if (!row) throw new Error('context_binding_required');
  const value = JSON.parse(row.binding) as CosBinding;
  if (value.scopeId !== scope || value.provider !== 'codex') throw new Error('context_binding_required');
  return value;
}
function nativeBinding(binding: CosBinding) {
  const session = getSession(binding.sessionId);
  if (!session) return false;
  const native = validateMattermostSessionForExecution(session),
    boundary = cosBoundary(session);
  return (
    native.strict &&
    native.valid &&
    boundary.restricted &&
    !!boundary.binding &&
    digest(boundary.binding) === digest(binding)
  );
}
function localStatus(db: Database.Database, root: string, binding: CosBinding) {
  const row = db
    .prepare(
      'SELECT generation,status,binding_digest,account_fingerprint FROM cos_conversation_states WHERE scope_id=?',
    )
    .get(binding.scopeId) as
    | { generation: string; status: string; binding_digest: string; account_fingerprint: string }
    | undefined;
  const accountFingerprint = accountBinding(root);
  const boundary = db.prepare('SELECT paused FROM cos_identity_boundaries WHERE scope_id=?').get(binding.scopeId) as {
    paused: number;
  };
  let context = row?.status ?? 'not_initialized';
  if (row && (row.binding_digest !== digest(binding) || row.account_fingerprint !== accountFingerprint))
    context = 'identity_mismatch';
  if (row && context === 'active') {
    try {
      if (!/^[a-f0-9-]{36}$/.test(row.generation)) throw new Error('invalid_generation');
      privateDirectory(path.join(root, 'conversations'));
      privateDirectory(path.join(root, 'conversations', row.generation));
    } catch {
      context = 'recovery_required';
    }
  }
  const file = path.join(root, 'model-activation.json');
  const present = !!fs.lstatSync(file, { throwIfNoEntry: false });
  const policy =
    present && accountFingerprint
      ? subscriptionActivation(readPrivate(file), binding.scopeId, accountFingerprint)
      : null;
  let remainingAttempts: number | null = null;
  let activation = present ? 'invalid_or_expired' : 'not_configured';
  if (policy && row && context === 'active' && policy.contextGeneration === row.generation) {
    const budget = db
      .prepare('SELECT policy_digest,used FROM cos_model_budgets WHERE activation_id=?')
      .get(policy.activationId) as { policy_digest: string; used: number } | undefined;
    if (!budget || budget.policy_digest === digest(policy)) {
      remainingAttempts = Math.max(0, policy.maxAttempts - (budget?.used ?? 0));
      activation = remainingAttempts > 0 ? 'configured' : 'exhausted';
    }
  }
  return {
    status: 'local_configuration',
    scopeId: binding.scopeId,
    paused: boundary.paused !== 0,
    context,
    generation: row?.generation ?? null,
    accountFingerprint,
    credential_binding: accountFingerprint ? 'recorded_not_live_verified' : 'missing',
    activation,
    remainingAttempts,
    live_model: 'not_verified',
    private_channel: 'not_checked',
  };
}
export async function contextAdminCommand(
  args: ContextAdminArguments,
  env: NodeJS.ProcessEnv,
  dependencies?: Dependencies,
): Promise<Record<string, unknown>> {
  if (env.COS_ENABLED !== 'true') return { status: 'disabled', live_model: 'not_verified' };
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(args.scopeId)) throw new Error('invalid_admin_arguments');
  const root = env.COS_TARGET_STATE_DIR ?? '';
  const d = dependencies ?? {
    target: (root: string) => localTarget(root, process.cwd(), path.join(process.cwd(), 'data')),
    quiescent: async (target: TargetState) => {
      const commands = targetCommands({
        userHome: os.homedir(),
        installationRoot: target.binding.installationRoot,
        service: target.binding.service,
      });
      const observed = await commands.observe();
      return (
        observed.pid === 0 &&
        observed.cwd === target.binding.installationRoot &&
        ['inactive', 'failed'].includes(observed.activeState) &&
        (await commands.ownedContainers()).length === 0
      );
    },
    facts: createMattermostFacts(
      {
        baseUrl: env.MATTERMOST_URL ?? '',
        botToken: env.MATTERMOST_BOT_TOKEN ?? '',
        instanceKey: env.MATTERMOST_INSTANCE ?? '',
      },
      new NodeMattermostTransport(),
      nativeBinding,
    ),
  };
  const target = d.target(root),
    central = path.join(target.binding.dataRoot, 'v2.db');
  privateDirectory(root);
  const stat = fs.lstatSync(central);
  if (
    !stat.isFile() ||
    fs.realpathSync(central) !== central ||
    stat.uid !== process.getuid?.() ||
    stat.nlink !== 1 ||
    stat.mode & 0o022
  )
    throw new Error('unsafe_context_admin_state');
  if (args.command === 'context-status') {
    const db = new Database(central, { readonly: true, fileMustExist: true });
    try {
      return localStatus(db, root, bindingFor(db, args.scopeId));
    } finally {
      db.close();
    }
  }
  const unlock = acquireTargetLock(root);
  let db: Database.Database | undefined, hostLease: HostExecutionLease | undefined;
  let inbound: Database.Database | undefined, outbound: Database.Database | undefined;
  let result: Record<string, unknown> | undefined,
    failure: unknown,
    released = true;
  try {
    result = await (async () => {
      const maintenance = activeMaintenanceLease(root, target.binding);
      if (!(await d.quiescent(target))) throw new Error('target_not_quiescent');
      db = initDb(central);
      hostLease = acquireHostExecutionLease(db);
      const native = db,
        lease = hostLease,
        binding = bindingFor(db, args.scopeId);
      const assertAuthority = () => {
        assertMaintenanceLease(root, target.binding, maintenance);
        assertHostExecutionLease(native, lease);
        if (!nativeBinding(binding)) throw new Error('context_binding_changed');
        const boundary = cosBoundary(getSession(binding.sessionId)!);
        if (!boundary.restricted || (args.command !== 'context-resume' && !boundary.paused))
          throw new Error('context_recovery_requires_paused_binding');
      };
      const check = async () => {
        assertAuthority();
        if (!validPrivateChannel(binding, await d.facts(binding))) throw new Error('private_owner_membership_required');
        if (!(await d.quiescent(target))) throw new Error('target_not_quiescent');
        assertAuthority();
      };
      await check();
      if (isKnowledgeCommand(args))
        return runKnowledgeAdmin({
          args,
          env,
          roots: {
            targetRoot: root,
            installationRoot: target.binding.installationRoot,
            dataRoot: target.binding.dataRoot,
          },
          binding,
          check,
          assertAuthority,
        });
      const accountFingerprint = accountBinding(root);
      if (!accountFingerprint) throw new Error('subscription_account_binding_unavailable');
      const activationOptions = { root, db, binding, accountFingerprint, assertAuthority };
      if (args.command === 'model-activate') {
        if (!path.isAbsolute(args.policyFile) || fs.realpathSync(args.policyFile) !== args.policyFile)
          throw new Error('unsafe_activation_state');
        return issueActivation(activationOptions, readPrivate(args.policyFile));
      }
      if (args.command === 'context-resume') {
        inbound = openInboundDb(binding.agentGroupId, binding.sessionId);
        outbound = openOutboundDb(binding.agentGroupId, binding.sessionId);
        return resumeContext({ ...activationOptions, inbound, outbound }, args.activationId, args.resumeId);
      }
      if (args.command === 'context-prepare') {
        const context = createConversationState(root, db).prepare(binding, accountFingerprint);
        return {
          status: 'prepared_paused',
          generation: context.generation,
          accountFingerprint,
          live_model: 'not_verified',
        };
      }
      inbound = openInboundDb(binding.agentGroupId, binding.sessionId);
      outbound = openOutboundDb(binding.agentGroupId, binding.sessionId);
      const input = inbound,
        output = outbound;
      const recovered = await recoverConversation({
        root,
        db,
        inbound,
        outbound,
        binding,
        accountFingerprint,
        expectedGeneration: args.expectedGeneration,
        recoveryId: args.recoveryId,
        assertAuthority,
        backup: async () => {
          await check();
          const parent = path.join(root, 'context-recovery-backups');
          if (!fs.lstatSync(parent, { throwIfNoEntry: false })) fs.mkdirSync(parent, { mode: 0o700 });
          privateDirectory(parent);
          const destination = path.join(parent, args.recoveryId);
          if (!fs.lstatSync(destination, { throwIfNoEntry: false })) fs.mkdirSync(destination, { mode: 0o700 });
          privateDirectory(destination);
          await backupNativeDatabase(central, destination);
          for (const [name, source] of [
            ['inbound', input.name],
            ['outbound', output.name],
          ]) {
            const directory = path.join(destination, name);
            if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
            await backupNativeDatabase(source, directory);
          }
          await backupConversations(path.join(root, 'conversations'), destination);
          await check();
        },
      });
      await check();
      const activation = rebindRecoveredActivation(activationOptions, {
        expectedGeneration: args.expectedGeneration,
        recoveryId: args.recoveryId,
      });
      return { ...recovered, activation };
    })();
  } catch (error) {
    failure = error;
  } finally {
    try {
      inbound?.close();
      outbound?.close();
      if (db && hostLease) released = releaseHostExecutionLease(db, hostLease);
    } finally {
      try {
        if (db) closeDb();
      } finally {
        unlock();
      }
    }
  }
  if (!released) throw new Error('context_admin_lease_release_failed', { cause: failure });
  if (failure) throw failure;
  if (!result) throw new Error('context_admin_result_unavailable');
  return result;
}
