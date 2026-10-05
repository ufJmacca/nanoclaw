/** Trusted owner commands. Calendar consent, recovery evidence and database permission are separate gates. */
import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { openWriterCredentials } from '../actions/config.js';
import {
  parseActionHostGrant,
  readActionHostProfile,
  verifyActionGrantRecovery,
  actionRecoveryPinCurrent,
  type ActionHostProfile,
} from '../actions/profile.js';
import { openTargetActionWitness } from '../actions/host-ownership.js';
import { writerAccountFingerprint } from '../actions/google-writer.js';
import { connectChecked } from '../store/preflight.js';
import { parseDatabaseConfig } from '../store/config.js';
import { migrationStatus, SCHEMA_VERSION } from '../store/migrations.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { localTarget, databaseFingerprint } from './target-identity.js';
import { writeAtomic } from './target-state.js';
import { readActionAccountConsent } from './action-account-admin.js';
import { readCalendarAdminJson as readJson, calendarAdminOperation as operation } from './calendar-admin.js';
export type ActionAdminArguments =
  | { command: 'action-configure'; scopeId: string; requestId: string; manifestFile: string }
  | { command: 'action-disable'; scopeId: string; requestId: string; bindingId: string };
export function isActionAdminCommand(args: { command: string }): args is ActionAdminArguments {
  return ['action-configure', 'action-disable'].includes(args.command);
}
export function parseActionAdminArguments(args: string[]): ActionAdminArguments {
  const invalid = () => Error('invalid_admin_arguments'),
    configure = args[0] === 'action-configure';
  if (!isActionAdminCommand({ command: args[0] }) || args.length !== 7) throw invalid();
  const allowed = ['--scope', '--request-id', configure ? '--manifest' : '--binding'],
    values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]) throw invalid();
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'],
    requestId = values['--request-id'],
    uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId ?? '') || !uuid.test(requestId ?? '')) throw invalid();
  if (!configure) {
    if (!uuid.test(values['--binding'] ?? '')) throw invalid();
    return { command: 'action-disable', scopeId, requestId, bindingId: values['--binding'] };
  }
  const file = values['--manifest'];
  if (!file || !path.isAbsolute(file) || path.resolve(file) !== file || /[\0\r\n]/.test(file)) throw invalid();
  return { command: 'action-configure', scopeId, requestId, manifestFile: file };
}
type Options = {
  args: ActionAdminArguments;
  env: NodeJS.ProcessEnv;
  roots: CalendarStorageRoots;
  binding: CosBinding;
  databaseFingerprint: string;
  check(): Promise<void>;
  assertAuthority(): void;
};
/** Context admin owns target/maintenance/native leases and requires the original paused private binding. */
export async function runActionAdmin(o: Options, inspect?: StorageInspection): Promise<Record<string, unknown>> {
  const { args, roots, binding } = o;
  if (args.scopeId !== binding.scopeId || binding.provider !== 'codex') throw Error('context_binding_changed');
  await o.check();
  const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
  if (target.binding.databaseFingerprint !== o.databaseFingerprint) throw Error('action_database_mismatch');
  const installationDigest = digest(target.binding),
    witness = openTargetActionWitness(roots.targetRoot, installationDigest),
    file = path.join(roots.targetRoot, 'actions', 'writer-profile.json'),
    existing = fs.lstatSync(file, { throwIfNoEntry: false })
      ? readActionHostProfile(roots.targetRoot, installationDigest, witness.generation)
      : null;
  const current = () => {
    o.assertAuthority();
    if (
      digest(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot).binding) !== installationDigest ||
      openTargetActionWitness(roots.targetRoot, installationDigest).generation !== witness.generation ||
      digest(
        fs.lstatSync(file, { throwIfNoEntry: false })
          ? readActionHostProfile(roots.targetRoot, installationDigest, witness.generation)
          : null,
      ) !== digest(existing)
    )
      throw Error('action_configuration_conflict');
  };
  const base = { scope_id: binding.scopeId, paused: true, live_model: 'not_invoked' };
  if (args.command === 'action-disable') {
    if (!existing) throw Error('action_profile_unavailable');
    const grant = existing.grants.find(
      (g) =>
        g.id === args.bindingId &&
        g.scopeId === binding.scopeId &&
        g.ownerId === binding.ownerId &&
        g.sessionId === binding.sessionId &&
        g.agentGroupId === binding.agentGroupId &&
        g.binding.bindingDigest === digest(binding),
    );
    if (!grant) throw Error('action_configuration_conflict');
    operation(roots, args.requestId, { command: args.command, binding, bindingId: args.bindingId });
    await o.check();
    current();
    writeAtomic(path.dirname(file), path.basename(file), {
      ...existing,
      grants: existing.grants.map((g) => (g.id === args.bindingId ? { ...g, writeEnabled: false } : g)),
    });
    return { ...base, status: 'disabled_paused', binding_id: args.bindingId, writer_enabled: false };
  }
  const grant = parseActionHostGrant(readJson(args.manifestFile));
  if (
    grant.scopeId !== binding.scopeId ||
    grant.ownerId !== binding.ownerId ||
    grant.sessionId !== binding.sessionId ||
    grant.agentGroupId !== binding.agentGroupId ||
    grant.binding.bindingDigest !== digest(binding) ||
    grant.binding.instanceId !== binding.instanceId ||
    grant.binding.channelId !== binding.channelId
  )
    throw Error('action_configuration_conflict');
  const consent = readActionAccountConsent(roots, binding, grant.id, inspect);
  if (
    consent.credentialReference !== grant.credentialReference ||
    consent.selection.calendarId !== grant.binding.calendarId ||
    writerAccountFingerprint(consent.selection.primaryCalendarId) !== grant.binding.accountFingerprint
  )
    throw Error('action_configuration_conflict');
  await verifyActionGrantRecovery(roots, grant, witness, o.databaseFingerprint, inspect);
  const owner = openWriterCredentials(roots, inspect),
    credential = await owner.credentials.inspect(grant.scopeId, grant.id, grant.credentialReference);
  if (credential.auth !== 'ready' || digest([...credential.scopes].sort()) !== digest([...grant.binding.scopes].sort()))
    throw Error('action_configuration_conflict');
  const next: ActionHostProfile = {
    format: 'cos-action-host/v1',
    installationDigest,
    journalGeneration: witness.generation,
    grants: [...(existing?.grants.filter((g) => g.id !== grant.id) ?? []), grant],
  };
  if (next.grants.length > 20 || new Set(next.grants.map((g) => g.credentialReference)).size !== next.grants.length)
    throw Error('action_configuration_conflict');
  const prior = existing?.grants.find((g) => g.id === grant.id);
  // One binding/reference owns one immutable provider identity. Reconnection requires a new consent ID.
  if (prior && digest({ ...prior, writeEnabled: grant.writeEnabled }) !== digest(grant))
    throw Error('action_configuration_conflict');
  operation(roots, args.requestId, { command: args.command, binding, grant });
  const ready = async () => {
    await o.check();
    current();
    owner.verify();
    if (
      !actionRecoveryPinCurrent(roots.targetRoot, grant) ||
      digest(readActionAccountConsent(roots, binding, grant.id, inspect)) !== digest(consent)
    )
      throw Error('action_configuration_conflict');
  };
  await ready();
  const client = await connectChecked(o.env, 'runtime', 'migration');
  let transaction = false;
  try {
    if (
      (await databaseFingerprint(client, parseDatabaseConfig(o.env, 'runtime', 'migration'))) !== o.databaseFingerprint
    )
      throw Error('action_database_mismatch');
    if ((await migrationStatus(client)) !== SCHEMA_VERSION) throw Error('action_schema_incompatible');
    if (!(await client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked)
      throw Error('action_configuration_busy');
    await ready();
    await client.query('BEGIN');
    transaction = true;
    const scoped = await client.query(
      "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND instance_id=$4 AND channel_id=$5 AND status='active' FOR UPDATE",
      [binding.scopeId, binding.ownerId, binding.agentGroupId, binding.instanceId, binding.channelId],
    );
    if (scoped.rowCount !== 1) throw Error('action_configuration_conflict');
    const installed = (
      await client.query(
        'SELECT b.owner_id,b.session_id,b.version,b.state,r.body,r.digest,r.consent_ref FROM cos.action_writer_bindings b JOIN cos.action_writer_revisions r ON r.scope_id=b.scope_id AND r.binding_id=b.id AND r.version=b.version WHERE b.scope_id=$1 AND b.id=$2',
        [binding.scopeId, grant.id],
      )
    ).rows[0];
    if (installed) {
      if (
        installed.owner_id !== binding.ownerId ||
        installed.session_id !== binding.sessionId ||
        installed.version !== 1 ||
        installed.state !== 'enabled' ||
        digest(installed.body) !== digest(grant.binding) ||
        installed.digest !== digest(grant.binding) ||
        installed.consent_ref !== digest(consent)
      )
        throw Error('action_configuration_conflict');
    } else {
      await client.query(
        "INSERT INTO cos.action_writer_bindings(scope_id,id,owner_id,session_id,version,state) VALUES($1,$2,$3,$4,1,'enabled')",
        [binding.scopeId, grant.id, binding.ownerId, binding.sessionId],
      );
      await client.query(
        'INSERT INTO cos.action_writer_revisions(scope_id,binding_id,version,body,digest,consent_ref) VALUES($1,$2,1,$3,$4,$5)',
        [binding.scopeId, grant.id, JSON.stringify(grant.binding), digest(grant.binding), digest(consent)],
      );
    }
    await ready();
    await client.query('COMMIT');
    transaction = false;
    // An unknown commit leaves only database metadata: without this separately published profile no host can write.
    await ready();
    current();
    writeAtomic(path.dirname(file), path.basename(file), next);
    readActionHostProfile(roots.targetRoot, installationDigest, witness.generation);
    return { ...base, status: 'configured_paused', binding_id: grant.id, writer_enabled: grant.writeEnabled };
  } finally {
    try {
      if (transaction) await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
}
