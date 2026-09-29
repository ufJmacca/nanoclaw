import { pathToFileURL } from 'node:url';
import { DatabaseConfigurationError } from '../store/config.js';
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
  if (command === 'migrate') {
    if (!confirm || confirm !== env[prefix + 'DATABASE'])
      throw new DatabasePreflightError('database_confirmation_mismatch');
    // Runtime deployment must supply a Pi-owned binding; the test profile
    // remains independently usable while that release helper is introduced.
    if (profile === 'runtime') throw new DatabasePreflightError('runtime_binding_required');
  }
  const client = await connectChecked(env, profile, command === 'migrate' ? 'migration' : 'runtime');
  try {
    const version =
      command === 'migrate' ? await migrate(client, env[prefix + 'USER'] ?? '') : await migrationStatus(client);
    return { status: 'ok', profile, command, schema_version: version };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
