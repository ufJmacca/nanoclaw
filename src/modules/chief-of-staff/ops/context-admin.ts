import { policyAllowsBriefContext } from '../bridge/brief-context-renewal.js';
import { runVaultProvisionAdmin } from './vault-owner-admin.js';
/** Owner-run controls. Calendar sync may refresh its own tokens; no model calls or message sends. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { initDb, initReadOnlyDb, initOwnerControlDb, closeDb } from '../../../db/connection.js';
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
import { validStatusInput, type StatusInput } from '../contracts/operations-protocol.js';
import { connectChecked } from '../store/preflight.js';
import { parseDatabaseConfig, externalDatabaseConfig } from '../store/config.js';
import { migrationStatus, SCHEMA_VERSION } from '../store/migrations.js';
import { BoundedDatabase } from '../store/client.js';
import { PriorityStore } from '../store/priorities.js';
import { databaseFingerprint } from './target-identity.js';
import { localTarget } from './target-identity.js';
import { acquireTargetLock, readPrivate, type TargetState } from './target-state.js';
import { activeMaintenanceLease, assertMaintenanceLease } from './maintenance.js';
import { targetCommands } from './target-host.js';
import { backupNativeDatabase } from './native-installation.js';
import { backupConversations } from './conversation-backup.js';
import { recoverConversation } from './conversation-recovery.js';
import { HostOwnerControls, parseOwnerControl } from './owner-controls.js';
import { RestrictedExecutionProbe } from '../bridge/native-execution.js';
import { getInstallSlug } from '../../../install-slug.js';
import type { Session } from '../../../types.js';
import { hasOwnerAccessDenials, ownerDenialsPermitResume, ownerDenialCheckpoint } from './owner-denial-resume.js';
import { issueActivation, resumeContext, rebindRecoveredActivation } from './model-activation.js';

import { isKnowledgeCommand, runKnowledgeAdmin, type KnowledgeAdminArguments } from './knowledge-admin.js';
import { isCalendarCommand, runCalendarAdmin, type CalendarAdminArguments } from './calendar-admin.js';
import { isMissionCommand, runMissionAdmin, type MissionAdminArguments } from './mission-admin.js';
import { isOwnerExportCommand, runOwnerExportAdmin, type OwnerExportArguments } from './owner-export-admin.js';
import {
  isCalendarAccountCommand,
  runCalendarAccountAdmin,
  type CalendarAccountArguments,
} from './calendar-account-admin.js';
import { isActionAccountCommand, runActionAccountAdmin, type ActionAccountArguments } from './action-account-admin.js';
import { isActionAdminCommand, runActionAdmin, type ActionAdminArguments } from './action-admin.js';
import {
  isActionRecoveryCommand,
  runActionRecoveryAdmin,
  type ActionRecoveryArguments,
} from './action-recovery-admin.js';

export type ContextAdminArguments =
  | { command: 'vault-provision'; scopeId: string }
  | OwnerExportArguments
  | ActionRecoveryArguments
  | ActionAdminArguments
  | ActionAccountArguments
  | MissionAdminArguments
  | KnowledgeAdminArguments
  | CalendarAdminArguments
  | CalendarAccountArguments
  | { command: 'context-status'; scopeId: string }
  | { command: 'operator-status'; scopeId: string; input: StatusInput }
  | { command: 'operator-control'; scopeId: string; requestId: string; text: string }
  | { command: 'context-prepare'; scopeId: string }
  | { command: 'model-activate'; scopeId: string; policyFile: string }
  | { command: 'context-resume'; scopeId: string; activationId: string; resumeId: string }
  | { command: 'context-recover'; scopeId: string; expectedGeneration: string; recoveryId: string };
type Dependencies = {
  target(root: string): TargetState;
  quiescent(target: TargetState): Promise<boolean>;
  facts(binding: CosBinding): Promise<ChannelFacts>;
  stop?(session: Session): void;
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
      // eslint-disable-next-line no-catch-all/no-catch-all -- Unconfirmed retained context storage requires recovery before admission.
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
  if (policy && row && context === 'active' && policyAllowsBriefContext(db, binding, policy, row.generation)) {
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
  if (
    env.COS_ENABLED !== 'true' &&
    ![
      'operator-status',
      'operator-control',
      'owner-export',
      'export-purge',
      'operations-backup',
      'operations-restore-check',
      'vault-provision',
    ].includes(args.command)
  )
    return { status: 'disabled', live_model: 'not_verified' };
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(args.scopeId)) throw new Error('invalid_admin_arguments');
  const root = env.COS_TARGET_STATE_DIR ?? '';
  const d: Dependencies = dependencies ?? {
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
  if (args.command === 'operator-control') {
    const control = parseOwnerControl(args.text);
    if (!control || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.requestId))
      throw Error('invalid_admin_arguments');
    const native = initOwnerControlDb(central);
    try {
      const binding = bindingFor(native, args.scopeId);
      if (!nativeBinding(binding)) return { status: 'denied', live_model: 'not_invoked' };
      const probe = new RestrictedExecutionProbe(getInstallSlug(target.binding.installationRoot));
      const controls = new HostOwnerControls({
        db: native,
        session: getSession,
        stop: (id) => {
          const session = getSession(id);
          if (
            !session ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(session.id) ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(session.agent_group_id)
          )
            throw Error('cos_execution_identity_unknown');
          if (d.stop) d.stop(session);
          else
            probe.stop(path.join(target.binding.dataRoot, 'v2-sessions', session.agent_group_id, session.id, 'cos-v1'));
        },
      });
      // A local owner authenticated by private target/native ownership may only reduce authority, without channel/network/model access.
      const result = controls.record(
        binding,
        {
          id: 'owner-local-' + args.requestId,
          ownerId: binding.ownerId,
          text: args.text,
          timestamp: new Date().toISOString(),
        },
        control,
      );
      return { ...result, scope_id: binding.scopeId, live_model: 'not_invoked', delivery: 'owner_local_only' };
    } finally {
      closeDb();
    }
  }
  if (args.command === 'context-status') {
    const db = new Database(central, { readonly: true, fileMustExist: true });
    try {
      return localStatus(db, root, bindingFor(db, args.scopeId));
    } finally {
      db.close();
    }
  }
  if (args.command === 'operator-status') {
    if (!validStatusInput(args.input)) throw new Error('invalid_admin_arguments');
    const native = initReadOnlyDb(central);
    let store: PriorityStore | undefined;
    try {
      const binding = bindingFor(native, args.scopeId),
        session = getSession(binding.sessionId);
      const current = async () => {
        if (!session || !nativeBinding(binding) || !validPrivateChannel(binding, await d.facts(binding))) return false;
        return nativeBinding(binding) && digest(d.target(root).binding) === digest(target.binding);
      };
      if (!(await current())) return { status: 'denied' };
      const check = await connectChecked(env, 'runtime');
      try {
        if (
          (await databaseFingerprint(check, parseDatabaseConfig(env, 'runtime'))) !==
            target.binding.databaseFingerprint ||
          (await migrationStatus(check)) !== SCHEMA_VERSION
        )
          return { status: 'unavailable' };
      } finally {
        await check.end();
      }
      store = new PriorityStore(BoundedDatabase.fromConfig(await externalDatabaseConfig(env, 'runtime')));
      const result = await store.operatorStatus({ ...binding, ingressId: 'owner-local-inspection' }, args.input);
      if (result.status === 'ok') {
        const fresh = await store.operatorStatus({ ...binding, ingressId: 'owner-local-inspection' }, {});
        if (fresh.status !== 'ok') return { status: fresh.status };
      }
      const boundary = cosBoundary(session!, native);
      return (await current())
        ? {
            ...result,
            scope_id: binding.scopeId,
            paused: boundary.restricted && boundary.paused,
            live_model: 'not_invoked',
          }
        : { status: 'denied' };
    } finally {
      try {
        await store?.database.pool.end();
      } finally {
        closeDb();
      }
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
      if (args.command === 'vault-provision') {
        return runVaultProvisionAdmin({ root, maintenance, native, hostLease: lease, check });
      }
      if (isOwnerExportCommand(args)) {
        return runOwnerExportAdmin({
          args,
          env,
          roots: {
            targetRoot: root,
            installationRoot: target.binding.installationRoot,
            dataRoot: target.binding.dataRoot,
          },
          binding,
          databaseFingerprint: target.binding.databaseFingerprint,
          check,
          assertAuthority,
        });
      }
      if (isActionRecoveryCommand(args)) {
        return runActionRecoveryAdmin({
          args,
          env,
          roots: {
            targetRoot: root,
            installationRoot: target.binding.installationRoot,
            dataRoot: target.binding.dataRoot,
          },
          binding,
          native,
          hostLease: lease,
          check,
          assertAuthority,
        });
      }
      if (isActionAdminCommand(args)) {
        return runActionAdmin({
          args,
          env,
          roots: {
            targetRoot: root,
            installationRoot: target.binding.installationRoot,
            dataRoot: target.binding.dataRoot,
          },
          binding,
          databaseFingerprint: target.binding.databaseFingerprint,
          check,
          assertAuthority,
        });
      }
      if (isActionAccountCommand(args)) {
        return runActionAccountAdmin({
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
      }
      if (isMissionCommand(args)) {
        return runMissionAdmin({
          args,
          env,
          root,
          binding,
          databaseFingerprint: target.binding.databaseFingerprint,
          check,
          assertAuthority,
        });
      }
      if (isKnowledgeCommand(args)) {
        if (args.command === 'source-purge') inbound = openInboundDb(binding.agentGroupId, binding.sessionId);
        return runKnowledgeAdmin({
          args,
          db,
          inbound,
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
      }
      if (isCalendarCommand(args)) {
        return runCalendarAdmin({
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
      }
      if (isCalendarAccountCommand(args)) {
        return runCalendarAccountAdmin({
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
      }
      const accountFingerprint = accountBinding(root);
      if (!accountFingerprint) throw new Error('subscription_account_binding_unavailable');
      const activationOptions = { root, db, binding, accountFingerprint, assertAuthority };
      if (args.command === 'model-activate') {
        if (!path.isAbsolute(args.policyFile) || fs.realpathSync(args.policyFile) !== args.policyFile)
          throw new Error('unsafe_activation_state');
        return issueActivation(activationOptions, readPrivate(args.policyFile));
      }
      if (args.command === 'context-resume') {
        let ownerDenialsCheckpoint: string | undefined;
        if (hasOwnerAccessDenials(native, binding)) {
          const remote = await connectChecked(env, 'runtime');
          try {
            if (
              (await databaseFingerprint(remote, parseDatabaseConfig(env, 'runtime'))) !==
                target.binding.databaseFingerprint ||
              (await migrationStatus(remote)) !== SCHEMA_VERSION
            )
              throw Error('operator_denial_requires_reconciliation');
            await remote.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            if (!(await ownerDenialsPermitResume(native, binding, remote)))
              throw Error('operator_denial_requires_reconciliation');
            ownerDenialsCheckpoint = ownerDenialCheckpoint(native, binding);
            await remote.query('COMMIT');
          } finally {
            await remote.end();
          }
          await check();
        }
        inbound = openInboundDb(binding.agentGroupId, binding.sessionId);
        outbound = openOutboundDb(binding.agentGroupId, binding.sessionId);
        return resumeContext(
          { ...activationOptions, inbound, outbound, ownerDenialsCheckpoint },
          args.activationId,
          args.resumeId,
        );
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
    // eslint-disable-next-line no-catch-all/no-catch-all -- Preserve the original failure until all native/target leases are released below.
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
