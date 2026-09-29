import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseConfigurationError, parseDatabaseConfig, externalDatabaseConfig } from '../store/config.js';
import { connectChecked, DatabasePreflightError } from '../store/preflight.js';
import { migrationStatus } from '../store/migrations.js';
import { BoundedDatabase } from '../store/client.js';
import { PriorityStore } from '../store/priorities.js';
import { localTarget, databaseFingerprint } from './target-identity.js';
import { activeMaintenanceLease, assertMaintenanceLease, admittedGeneration } from './maintenance.js';
import type { BindingRequest } from './bind.js';
import { readEnvFile } from '../../../env.js';

type AdminArguments = { command: 'status' } | { command: 'bind'; binding: BindingRequest };
export function parseAdminArguments(args: string[]): AdminArguments {
  if (args.length === 1 && args[0] === 'status') return { command: 'status' };
  const keys = ['--scope', '--instance', '--channel', '--owner', '--bot', '--provider'];
  if (args[0] !== 'bind' || args.length !== 13) throw new Error('invalid_admin_arguments');
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!keys.includes(args[i]) || values[args[i]] || !/^[a-zA-Z0-9_-]{1,128}$/.test(args[i + 1]))
      throw new Error('invalid_admin_arguments');
    values[args[i]] = args[i + 1];
  }
  if (!['codex', 'claude'].includes(values['--provider'])) throw new Error('invalid_admin_arguments');
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
      status: version === 1 ? 'ready' : 'schema_incompatible',
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
    if ((await migrationStatus(check)) !== 1) throw new DatabasePreflightError('schema_incompatible');
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
  Promise.resolve()
    .then(async () => {
      const args = parseAdminArguments(process.argv.slice(2)),
        env = adminEnvironment();
      return args.command === 'status' ? adminStatus(env) : bindCommand(args.binding, env);
    })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(JSON.stringify({ status: 'unavailable', code: safeDependencyStatus(error) }));
      process.exitCode = 1;
    });
}
