import path from 'node:path';
import { isKnowledgeCommand, parseKnowledgeArguments } from './knowledge-admin.js';
import { isCalendarCommand, parseCalendarArguments } from './calendar-admin.js';
import { pathToFileURL } from 'node:url';
import { DatabaseConfigurationError, parseDatabaseConfig, externalDatabaseConfig } from '../store/config.js';
import { connectChecked, DatabasePreflightError } from '../store/preflight.js';
import { migrationStatus, SCHEMA_VERSION } from '../store/migrations.js';
import { BoundedDatabase } from '../store/client.js';
import { PriorityStore } from '../store/priorities.js';
import { localTarget, databaseFingerprint } from './target-identity.js';
import { activeMaintenanceLease, assertMaintenanceLease, admittedGeneration } from './maintenance.js';
import type { BindingRequest } from './bind.js';
import { readEnvFile } from '../../../env.js';
import { contextAdminCommand, type ContextAdminArguments } from './context-admin.js';

type AdminArguments = { command: 'status' } | { command: 'bind'; binding: BindingRequest } | ContextAdminArguments;
export function parseAdminArguments(args: string[]): AdminArguments {
  if (isKnowledgeCommand({ command: args[0] })) return parseKnowledgeArguments(args);
  if (isCalendarCommand({ command: args[0] })) return parseCalendarArguments(args);
  if (args.length === 1 && args[0] === 'status') return { command: 'status' };
  if (['context-status', 'context-prepare', 'context-recover', 'model-activate', 'context-resume'].includes(args[0])) {
    const values: Record<string, string> = {};
    const recovery = args[0] === 'context-recover';
    const allowed = recovery
      ? ['--scope', '--expected-generation', '--recovery-id']
      : args[0] === 'model-activate'
        ? ['--scope', '--policy']
        : args[0] === 'context-resume'
          ? ['--scope', '--activation-id', '--resume-id']
          : ['--scope'];
    if (args.length !== 1 + allowed.length * 2) throw new Error('invalid_admin_arguments');
    for (let i = 1; i < args.length; i += 2) {
      if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1])
        throw new Error('invalid_admin_arguments');
      values[args[i]] = args[i + 1];
    }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(values['--scope'])) throw new Error('invalid_admin_arguments');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (args[0] === 'model-activate') {
      if (
        !path.isAbsolute(values['--policy']) ||
        path.resolve(values['--policy']) !== values['--policy'] ||
        /[\0\r\n]/.test(values['--policy'])
      )
        throw new Error('invalid_admin_arguments');
      return { command: 'model-activate', scopeId: values['--scope'], policyFile: values['--policy'] };
    }
    if (args[0] === 'context-resume') {
      if (!/^[a-f0-9]{32}$/.test(values['--activation-id']) || !uuid.test(values['--resume-id']))
        throw new Error('invalid_admin_arguments');
      return {
        command: 'context-resume',
        scopeId: values['--scope'],
        activationId: values['--activation-id'],
        resumeId: values['--resume-id'],
      };
    }
    if (recovery) {
      if (!uuid.test(values['--expected-generation']) || !uuid.test(values['--recovery-id']))
        throw new Error('invalid_admin_arguments');
      return {
        command: 'context-recover',
        scopeId: values['--scope'],
        expectedGeneration: values['--expected-generation'],
        recoveryId: values['--recovery-id'],
      };
    }
    return { command: args[0] as 'context-status' | 'context-prepare', scopeId: values['--scope'] };
  }
  const keys = ['--scope', '--instance', '--channel', '--owner', '--bot', '--provider'];
  if (args[0] !== 'bind' || args.length !== 13) throw new Error('invalid_admin_arguments');
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!keys.includes(args[i]) || values[args[i]] || !/^[a-zA-Z0-9_-]{1,128}$/.test(args[i + 1]))
      throw new Error('invalid_admin_arguments');
    values[args[i]] = args[i + 1];
  }
  if (values['--provider'] !== 'codex') throw new Error('invalid_admin_arguments');
  return {
    command: 'bind',
    binding: {
      scopeId: values['--scope'],
      instanceId: values['--instance'],
      channelId: values['--channel'],
      ownerId: values['--owner'],
      botId: values['--bot'],
      provider: values['--provider'] as 'codex' | 'claude',
    },
  };
}
type StatusDependencies = {
  target(env: NodeJS.ProcessEnv): { maintenance: boolean; lifecycle: string } | null;
  database(env: NodeJS.ProcessEnv): Promise<number>;
};
export function safeDependencyStatus(error: unknown): string {
  if (error instanceof DatabaseConfigurationError) return 'misconfigured';
  if (error instanceof DatabasePreflightError) {
    if (
      [
        'tls_rejected',
        'authentication_denied',
        'schema_incompatible',
        'schema_privilege_denied',
        'unsupported_server',
        'database_identity_mismatch',
      ].includes(error.code)
    )
      return error.code;
  }
  return 'unreachable';
}
/** Exact local codes only; never emit filesystem, transport or credential error text. */
export function safeAdminError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === 'NanoClaw host execution lease is already held by a live process')
      return 'host_writer_active';
    if (
      [
        'invalid_admin_arguments',
        'invalid_source_manifest',
        'invalid_calendar_manifest',
        'calendar_disabled',
        'calendar_operation_conflict',
        'unsafe_calendar_admin_state',
        'calendar_configuration_unavailable',
        'calendar_backup_unavailable',
        'unsafe_conversation_ownership',
        'unsafe_conversation_purge',
        'conversation_purge_conflict',
        'conversation_purge_authority_required',
        'unsupported_source',
        'source_line_too_long',
        'source_too_many_chunks',
        'unsafe_knowledge_file',
        'unstable_knowledge_file',
        'staged_source_changed',
        'unsafe_knowledge_configuration',
        'unowned_knowledge_configuration',
        'target_not_quiescent',
        'target_locked',
        'stale_maintenance_lease',
        'maintenance_history_conflict',
        'host_execution_authority_lost',
        'private_owner_membership_required',
        'subscription_account_binding_unavailable',
        'context_binding_required',
        'context_binding_changed',
        'unsafe_context_admin_state',
        'context_recovery_requires_paused_binding',
        'context_recovery_stale_generation',
        'context_recovery_superseded',
        'context_recovery_conflict',
        'context_recovery_requires_existing_generation',
        'context_recovery_not_empty',
        'unsafe_context_recovery',
        'context_admin_lease_release_failed',
        'cos_context_recovery_required',
        'conversation_backup_space',
        'conversation_backup_changed',
        'conversation_backup_conflict',
        'unsafe_conversation_backup',
        'unsafe_activation_state',
        'activation_requires_paused_binding',
        'activation_context_mismatch',
        'activation_conflict',
        'activation_superseded',
        'activation_exhausted',
        'invalid_resume_request',
        'resume_conflict',
        'resume_outcome_uncertain',
      ].includes(error.message)
    )
      return error.message;
  }
  return safeDependencyStatus(error);
}
export async function adminStatus(
  env: NodeJS.ProcessEnv,
  dependencies: StatusDependencies = {
    target: (env) => {
      if (!env.COS_TARGET_STATE_DIR) return null;
      const state = localTarget(env.COS_TARGET_STATE_DIR, process.cwd(), path.join(process.cwd(), 'data'));
      return { ...state, maintenance: admittedGeneration(env.COS_TARGET_STATE_DIR, state.binding) === null };
    },
    database: async (env) => {
      const check = await connectChecked(env, 'runtime');
      try {
        const state = localTarget(env.COS_TARGET_STATE_DIR!, process.cwd(), path.join(process.cwd(), 'data'));
        if (
          (await databaseFingerprint(check, parseDatabaseConfig(env, 'runtime'))) !== state.binding.databaseFingerprint
        )
          throw new DatabasePreflightError('database_identity_mismatch');
        return await migrationStatus(check);
      } finally {
        await check.end();
      }
    },
  },
): Promise<Record<string, unknown>> {
  const base = { component: 'cos_storage_and_target', model_activation: 'not_verified', scope_binding: 'not_verified' };
  if (env.COS_ENABLED !== 'true') return { ...base, status: 'disabled' };
  try {
    const target = dependencies.target(env);
    if (!target) return { ...base, status: 'unbound' };
    if (target.maintenance) return { ...base, status: 'maintenance', lifecycle: target.lifecycle };
    const version = await dependencies.database(env);
    return {
      ...base,
      status: version === SCHEMA_VERSION ? 'ready' : 'schema_incompatible',
      schema_version: version,
      lifecycle: target.lifecycle,
    };
  } catch (error) {
    return { ...base, status: safeDependencyStatus(error) };
  }
}
/** Only the owner-run host command reaches setup; no RPC or delivery action exposes it. */
export async function bindCommand(request: BindingRequest, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const root = env.COS_TARGET_STATE_DIR ?? '';
  const target = localTarget(root, process.cwd(), path.join(process.cwd(), 'data'));
  const lease = activeMaintenanceLease(root, target.binding);
  const check = await connectChecked(env, 'runtime');
  let store: PriorityStore | undefined;
  let closeNative: (() => void) | undefined;
  try {
    if ((await databaseFingerprint(check, parseDatabaseConfig(env, 'runtime'))) !== target.binding.databaseFingerprint)
      throw new DatabasePreflightError('database_identity_mismatch');
    if (!(await check.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked)
      throw new DatabasePreflightError('maintenance_writer_active');
    assertMaintenanceLease(root, target.binding, lease);
    if ((await migrationStatus(check)) !== SCHEMA_VERSION) throw new DatabasePreflightError('schema_incompatible');
    const { initDb, closeDb } = await import('../../../db/connection.js');
    const { runMigrations } = await import('../../../db/migrations/index.js');
    const { getSession } = await import('../../../db/sessions.js');
    const { validateMattermostSessionForExecution } = await import('../../../channels/mattermost-subscription.js');
    const { NodeMattermostTransport } = await import('../../../channels/mattermost-client.js');
    const { createMattermostFacts } = await import('../bridge/mattermost-facts.js');
    const { bindCoordinator } = await import('./bind.js');
    const db = initDb(path.join(target.binding.dataRoot, 'v2.db'));
    closeNative = closeDb;
    runMigrations(db);
    store = new PriorityStore(BoundedDatabase.fromConfig(await externalDatabaseConfig(env, 'runtime')));
    const facts = createMattermostFacts(
      {
        baseUrl: env.MATTERMOST_URL ?? '',
        botToken: env.MATTERMOST_BOT_TOKEN ?? '',
        instanceKey: env.MATTERMOST_INSTANCE ?? '',
      },
      new NodeMattermostTransport(),
      (binding) => {
        const session = getSession(binding.sessionId);
        if (!session) return false;
        const current = validateMattermostSessionForExecution(session);
        return (
          current.strict &&
          current.valid &&
          current.value.agentGroup.id === binding.agentGroupId &&
          current.value.messagingGroup.id === binding.messagingGroupId
        );
      },
    );
    const binding = await bindCoordinator(request, { facts, bindScope: (value) => store!.bindScope(value) });
    return {
      status: 'bound_paused',
      scope_id: binding.scopeId,
      session_id: binding.sessionId,
      provider: binding.provider,
    };
  } finally {
    try {
      closeNative?.();
    } finally {
      try {
        await store?.database.pool.end();
      } finally {
        await check.end();
      }
    }
  }
}
function adminEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    'COS_ENABLED',
    'COS_TARGET_STATE_DIR',
    'COS_KNOWLEDGE_ENABLED',
    'COS_CALENDAR_ENABLED',
    'COS_KNOWLEDGE_RETENTION_DAYS',
    'MATTERMOST_URL',
    'MATTERMOST_BOT_TOKEN',
    'MATTERMOST_INSTANCE',
    ...[
      'HOST',
      'PORT',
      'DATABASE',
      'USER',
      'PASSWORD',
      'SSLMODE',
      'SSLROOTCERT',
      '_ALLOW_PLAINTEXT',
      '_POOL_MAX',
      '_CONNECT_TIMEOUT_MS',
      '_STATEMENT_TIMEOUT_MS',
      '_QUERY_TIMEOUT_MS',
      '_LOCK_TIMEOUT_MS',
      '_IDLE_TIMEOUT_MS',
      '_IDLE_TX_TIMEOUT_MS',
      '_APPLICATION_NAME',
    ].map((key) => 'COS_PG' + key),
  ];
  const file = readEnvFile(keys);
  return Object.fromEntries(keys.map((key) => [key, process.env[key] ?? file[key]]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.NANOCLAW_LOG_STDERR = 'true';
  Promise.resolve()
    .then(async () => {
      const args = parseAdminArguments(process.argv.slice(2)),
        env = adminEnvironment();
      if (args.command === 'status') return adminStatus(env);
      if (args.command === 'bind') return bindCommand(args.binding, env);
      return contextAdminCommand(args, env);
    })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(JSON.stringify({ status: 'unavailable', code: safeAdminError(error) }));
      process.exitCode = 1;
    });
}
