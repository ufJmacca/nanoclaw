import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { configureDelegation, readDelegationManifest } from '../missions/delegation.js';
import { installReviewedMissionTemplate } from '../missions/template-admin.js';
import { connectChecked } from '../store/preflight.js';
import { parseDatabaseConfig } from '../store/config.js';
import { migrationStatus, SCHEMA_VERSION } from '../store/migrations.js';
import { databaseFingerprint } from './target-identity.js';
export type MissionAdminArguments = {
  command: 'mission-configure';
  scopeId: string;
  requestId: string;
  manifestFile: string;
};
export function isMissionCommand(args: { command: string }): args is MissionAdminArguments {
  return args.command === 'mission-configure';
}
export function parseMissionArguments(args: string[]): MissionAdminArguments {
  const invalid = () => Error('invalid_admin_arguments');
  if (!isMissionCommand({ command: args[0] }) || args.length !== 7) throw invalid();
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!['--scope', '--request-id', '--manifest'].includes(args[i]) || values[args[i]] !== undefined || !args[i + 1])
      throw invalid();
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'],
    requestId = values['--request-id'],
    manifestFile = values['--manifest'];
  if (
    !scopeId ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId) ||
    !requestId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId) ||
    !manifestFile ||
    !path.isAbsolute(manifestFile) ||
    path.resolve(manifestFile) !== manifestFile ||
    /[\0\r\n]/.test(manifestFile)
  )
    throw invalid();
  return { command: 'mission-configure', scopeId, requestId, manifestFile };
}
/** Context admin holds target/host leases, requires a paused binding and revalidates private membership. */
export async function runMissionAdmin(options: {
  args: MissionAdminArguments;
  env: NodeJS.ProcessEnv;
  root: string;
  binding: CosBinding;
  databaseFingerprint: string;
  check(): Promise<void>;
  assertAuthority(): void;
}): Promise<Record<string, unknown>> {
  const { args, binding } = options;
  if (args.scopeId !== binding.scopeId || binding.provider !== 'codex') throw Error('context_binding_changed');
  await options.check();
  const change = readDelegationManifest(args.manifestFile);
  const client = await connectChecked(options.env, 'runtime', 'migration');
  let transaction = false;
  try {
    if (
      (await databaseFingerprint(client, parseDatabaseConfig(options.env, 'runtime', 'migration'))) !==
      options.databaseFingerprint
    )
      throw Error('mission_database_mismatch');
    if (!(await client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked)
      throw Error('mission_configuration_busy');
    if ((await migrationStatus(client)) !== SCHEMA_VERSION) throw Error('mission_schema_incompatible');
    await options.check();
    await client.query('BEGIN');
    transaction = true;
    await installReviewedMissionTemplate(client, binding, args.requestId, change);
    await options.check();
    await client.query('COMMIT');
    transaction = false;
    // An uncertain database outcome cannot grant authority. A retry checks the exact installed template.
    await options.check();
    options.assertAuthority();
    const record = configureDelegation(options.root, binding, args.requestId, change);
    return {
      status: 'configured_paused',
      scope_id: binding.scopeId,
      revision: record.revision,
      enabled: record.enabled,
      template_digest: record.templateDigest,
      live_model: 'not_invoked',
    };
  } finally {
    try {
      if (transaction) await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
}
