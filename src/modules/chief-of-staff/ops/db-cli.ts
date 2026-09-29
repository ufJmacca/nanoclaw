import path from 'node:path';
import { localTarget, databaseFingerprint } from './target-identity.js';
import { activeMaintenanceLease, assertMaintenanceLease, type MaintenanceLease } from './maintenance.js';
import type { TargetBinding } from './target-state.js';
import { pathToFileURL } from 'node:url';
import { DatabaseConfigurationError, parseDatabaseConfig } from '../store/config.js';
import { connectChecked, DatabasePreflightError } from '../store/preflight.js';
import { migrate, migrationStatus } from '../store/migrations.js';

export function parseDbArguments(args: string[]): { command: string; profile: 'runtime' | 'test'; confirm?: string } {
  const [command, ...rest] = args;
  if (!['check', 'migrate-status', 'migrate'].includes(command)) throw new Error('invalid_command');
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--profile', '--confirm-database'].includes(rest[i]) || !rest[i + 1] || values[rest[i]])
      throw new Error('invalid_arguments');
    values[rest[i]] = rest[i + 1];
  }
  if (values['--profile'] !== 'runtime' && values['--profile'] !== 'test') throw new Error('explicit_profile_required');
  return { command, profile: values['--profile'], confirm: values['--confirm-database'] };
}

export async function databaseCommand(args: string[], env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const { command, profile, confirm } = parseDbArguments(args);
  const prefix = profile === 'test' ? 'COS_TEST_PG' : 'COS_PG';
  let runtimeGuard: { root: string; binding: TargetBinding; lease: MaintenanceLease } | undefined;
  if (command === 'migrate') {
    if (!confirm || confirm !== env[prefix + 'DATABASE'])
      throw new DatabasePreflightError('database_confirmation_mismatch');
    if (profile === 'runtime') {
      const root = env.COS_TARGET_STATE_DIR ?? '';
      const target = localTarget(root, process.cwd(), path.join(process.cwd(), 'data'));
      runtimeGuard = { root, binding: target.binding, lease: activeMaintenanceLease(root, target.binding) };
    }
  }
  const client = await connectChecked(env, profile, command === 'migrate' ? 'migration' : 'runtime');
  try {
    if (runtimeGuard) {
      if (
        (await databaseFingerprint(client, parseDatabaseConfig(env, 'runtime', 'migration'))) !==
        runtimeGuard.binding.databaseFingerprint
      )
        throw new DatabasePreflightError('database_identity_mismatch');
      if (!(await client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked)
        throw new DatabasePreflightError('maintenance_writer_active');
      assertMaintenanceLease(runtimeGuard.root, runtimeGuard.binding, runtimeGuard.lease);
    }
    const version =
      command === 'migrate' ? await migrate(client, env[prefix + 'USER'] ?? '') : await migrationStatus(client);
    return { status: 'ok', profile, command, schema_version: version };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.NANOCLAW_LOG_STDERR = 'true';
  databaseCommand(process.argv.slice(2), process.env)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      const code =
        error instanceof DatabaseConfigurationError
          ? 'misconfigured'
          : error instanceof DatabasePreflightError
            ? error.code
            : 'invalid_command_or_unavailable';
      console.error(JSON.stringify({ status: 'unavailable', code }));
      process.exitCode = 1;
    });
}
