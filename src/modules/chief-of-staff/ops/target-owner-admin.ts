import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deploymentSettings } from './deployment-settings.js';
import { readPrivate } from './target-state.js';
import { withDeploymentLock } from './deployment-lock.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
const commands = [
  'vault-status',
  'database-check',
  'status',
  'operator-status',
  'operator-control',
  'owner-export',
  'export-purge',
  'operations-backup',
  'operations-restore-check',
];
export function parseOwnerAdminArguments(args: string[]): {
  settings: string;
  databaseEnvironment?: string;
  admin: string[];
} {
  const delimiter = args.indexOf('--'),
    flags = args.slice(0, delimiter),
    admin = args.slice(delimiter + 1);
  const invalid = (): never => {
    throw new Error('invalid_owner_admin_arguments');
  };
  if (
    delimiter < 0 ||
    !commands.includes(admin[0]) ||
    ![2, 4].includes(flags.length) ||
    flags[0] !== '--settings' ||
    (flags.length === 4 && flags[2] !== '--database-environment')
  )
    return invalid();
  const canonical = (file: string) =>
    typeof file === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(file) && path.resolve(file) === file;
  if (
    !canonical(flags[1]) ||
    (flags.length === 4 && !canonical(flags[3])) ||
    (admin[0] === 'operations-restore-check') !== (flags.length === 4) ||
    (['database-check', 'vault-status'].includes(admin[0]) && admin.length !== 1)
  )
    return invalid();
  return { settings: flags[1], databaseEnvironment: flags[3], admin };
}
export async function ownerDatabasePreflight(
  input: ReleaseManifest,
  probe: () => Promise<number>,
): Promise<Record<string, unknown>> {
  const manifest = validateReleaseManifest(input);
  const { databaseReadiness } = await import('./database-readiness.js');
  const { DatabasePreflightError } = await import('../store/preflight.js');
  try {
    const version = await probe(),
      compatible =
        Number.isSafeInteger(version) && version >= manifest.postgres.minimum && version <= manifest.postgres.maximum;
    return {
      status: compatible ? 'ready' : 'schema_incompatible',
      schema_version: version,
      database_readiness: databaseReadiness(compatible ? null : new DatabasePreflightError('schema_incompatible')),
      model_activation: 'not_verified',
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Administrative preflight reports fixed readiness stages, never private environment or driver diagnostics.
  } catch (error) {
    return { status: 'unavailable', database_readiness: databaseReadiness(error), model_activation: 'not_verified' };
  }
}
export async function selectedOwnerAdminProfile(
  command: string,
  profiles: { runtime(): NodeJS.ProcessEnv; test(): NodeJS.ProcessEnv },
): Promise<NodeJS.ProcessEnv> {
  if (!commands.includes(command)) throw new Error('invalid_owner_admin_arguments');
  return ['operator-control', 'vault-status'].includes(command)
    ? {}
    : command === 'operations-restore-check'
      ? profiles.test()
      : profiles.runtime();
}
export async function targetOwnerAdmin(args: string[]): Promise<Record<string, unknown>> {
  const request = parseOwnerAdminArguments(args),
    settings = deploymentSettings(readPrivate(request.settings));
  process.chdir(settings.installationRoot);
  // Fix cwd before loading native/runtime modules. Never source a whole private environment file.
  const { parseAdminArguments, adminEnvironment, adminStatus } = await import('./admin.js');
  const parsed =
    request.admin[0] === 'database-check' ? { command: 'database-check' as const } : parseAdminArguments(request.admin);
  if (
    !commands.includes(parsed.command) ||
    parsed.command === 'bind' ||
    ('settingsFile' in parsed && parsed.settingsFile !== request.settings)
  )
    throw new Error('invalid_owner_admin_arguments');
  const {
    verifyTargetPaths,
    targetBinding,
    readTargetDatabaseEnvironment,
    readTargetTestEnvironment,
    checkedTargetDatabase,
  } = await import('./target-host.js');
  const { verifyProtectionHelper } = await import('./programme-protection.js');
  verifyTargetPaths(settings, 0);
  const release = await verifyProtectionHelper(
    settings,
    targetBinding(settings),
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'target-helper.js'),
  );
  const selected = await selectedOwnerAdminProfile(parsed.command, {
    runtime: () => readTargetDatabaseEnvironment(settings, 'runtime'),
    test: () => readTargetTestEnvironment(request.databaseEnvironment!),
  });
  const env =
    parsed.command === 'database-check'
      ? selected
      : adminEnvironment(parsed.command, { ...selected, COS_TARGET_STATE_DIR: settings.stateRoot });
  const run = async () => {
    if (parsed.command === 'database-check')
      return ownerDatabasePreflight(release, async () => {
        const client = await checkedTargetDatabase(settings);
        try {
          const { migrationStatus } = await import('../store/migrations.js');
          return await migrationStatus(client);
        } finally {
          await client.end();
        }
      });
    if (parsed.command === 'status') return adminStatus(env);
    if (parsed.command === 'vault-status') {
      const { vaultStatusCommand } = await import('./vault-admin.js');
      return vaultStatusCommand(env);
    }
    const { contextAdminCommand } = await import('./context-admin.js');
    return contextAdminCommand(parsed, env);
  };
  // Inspection and durable owner denials remain available while another operation owns its longer lease.
  return ['operator-control', 'operator-status', 'status', 'database-check', 'vault-status'].includes(parsed.command)
    ? run()
    : withDeploymentLock(settings.stateRoot + '.operation.lock', run);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.NANOCLAW_LOG_STDERR = 'true';
  targetOwnerAdmin(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(JSON.stringify({ status: 'unavailable', code: 'owner_admin_unverified' }));
      process.exitCode = 1;
    });
}
