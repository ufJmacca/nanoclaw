import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { connectChecked } from '../store/preflight.js';
import { parseDatabaseConfig, externalDatabaseConfig } from '../store/config.js';
import { migrationStatus, SCHEMA_VERSION } from '../store/migrations.js';
import { BoundedDatabase } from '../store/client.js';
import { openKnowledgeArtifacts } from '../knowledge/config.js';
import { databaseFingerprint } from './target-identity.js';
import { privateConversationDirectory } from './conversation-ownership.js';
import { exportOwnerRecords, purgeOwnerExports } from './owner-export.js';

export type OwnerExportArguments =
  | { command: 'owner-export'; scopeId: string; requestId: string }
  | { command: 'export-purge'; scopeId: string; requestId: string; retentionDays: number };
export function isOwnerExportCommand(args: { command: string }): args is OwnerExportArguments {
  return ['owner-export', 'export-purge'].includes(args.command);
}
export function parseOwnerExportArguments(args: string[]): OwnerExportArguments {
  const purge = args[0] === 'export-purge',
    allowed = ['--scope', '--request-id', ...(purge ? ['--retention-days'] : [])],
    values: Record<string, string> = {};
  if (!isOwnerExportCommand({ command: args[0] }) || args.length !== allowed.length * 2 + 1)
    throw Error('invalid_admin_arguments');
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1])
      throw Error('invalid_admin_arguments');
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'],
    requestId = values['--request-id'];
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId ?? '') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId ?? '')
  )
    throw Error('invalid_admin_arguments');
  if (!purge) return { command: 'owner-export', scopeId, requestId };
  const days = values['--retention-days'];
  if (!/^(0|[1-9][0-9]{0,2})$/.test(days ?? '') || Number(days) > 365) throw Error('invalid_admin_arguments');
  return { command: 'export-purge', scopeId, requestId, retentionDays: Number(days) };
}
/** The enclosing owner command retains target/maintenance/native leases and fresh private membership checks.
 * Database credentials are runtime-only; provider credential stores and model/account activation are never opened.
 */
export async function runOwnerExportAdmin(o: {
  args: OwnerExportArguments;
  env: NodeJS.ProcessEnv;
  roots: { targetRoot: string; installationRoot: string; dataRoot: string };
  binding: CosBinding;
  databaseFingerprint: string;
  check(): Promise<void>;
  assertAuthority(): void;
}): Promise<Record<string, unknown>> {
  if (o.args.scopeId !== o.binding.scopeId || o.binding.provider !== 'codex') throw Error('context_binding_changed');
  await o.check();
  const client = await connectChecked(o.env, 'runtime');
  try {
    if (
      (await databaseFingerprint(client, parseDatabaseConfig(o.env, 'runtime'))) !== o.databaseFingerprint ||
      (await migrationStatus(client)) !== SCHEMA_VERSION
    )
      throw Error('export_database_mismatch');
  } finally {
    await client.end();
  }
  await o.check();
  const database = BoundedDatabase.fromConfig(await externalDatabaseConfig(o.env, 'runtime'), () => {
    o.assertAuthority();
    return true;
  });
  try {
    await o.check();
    const root = path.join(o.roots.targetRoot, 'exports');
    if (!fs.lstatSync(root, { throwIfNoEntry: false })) fs.mkdirSync(root, { mode: 0o700 });
    privateConversationDirectory(root);
    const options = {
      database,
      context: {
        scopeId: o.binding.scopeId,
        ownerId: o.binding.ownerId,
        agentGroupId: o.binding.agentGroupId,
        sessionId: o.binding.sessionId,
        ingressId: 'owner-export-' + o.args.requestId,
      },
      provider: o.binding.provider,
      artifacts: openKnowledgeArtifacts(o.roots.targetRoot, [o.roots.installationRoot, o.roots.dataRoot]),
      root,
      requestId: o.args.requestId,
      check: o.check,
    };
    const result =
      o.args.command === 'owner-export'
        ? await exportOwnerRecords(options)
        : await purgeOwnerExports({ ...options, retentionMs: o.args.retentionDays * 86400000 });
    await o.check();
    return { ...result, scope_id: o.binding.scopeId, paused: true, live_model: 'not_invoked' };
  } finally {
    await database.pool.end();
  }
}
