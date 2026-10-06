/** Synthetic cross-database recovery. Profiles run sequentially; no live transport, account or Pi data is copied. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import Database from 'better-sqlite3';
import {
  assertRuntimeFixtureGuard,
  connectFixtureDatabase,
  fixtureDatabaseConfig,
  fixtureProfile,
} from './fixture-database.js';
import { databaseFingerprint } from '../../modules/chief-of-staff/ops/target-identity.js';
import { SCHEMA_VERSION, migrationStatus } from '../../modules/chief-of-staff/store/migrations.js';
import { readPrivate, writeAtomic } from '../../modules/chief-of-staff/ops/target-state.js';
import { digest, type Context } from '../../modules/chief-of-staff/domain/contracts.js';
import { installCosBoundary, type CosBinding } from '../../cos-boundary.js';
import type { Session } from '../../types.js';
import { HostOwnerControls } from '../../modules/chief-of-staff/ops/owner-controls.js';
import { ownerDenialsPermitResume } from '../../modules/chief-of-staff/ops/owner-denial-resume.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import {
  ActionWitness,
  initializeActionWitness,
  type StartedActionWitness,
} from '../../modules/chief-of-staff/actions/witness.js';
import { createActionIntent } from '../../modules/chief-of-staff/actions/intent.js';
import {
  backupCoordinatedState,
  verifyCoordinatedBackup,
  restoreCoordinatedSandbox,
  restoreCoordinatedTestScope,
  verifyCoordinatedSandbox,
  verifyCoordinatedLocalSandbox,
  type CoordinatedBackupIdentity,
} from '../../modules/chief-of-staff/ops/coordinated-backup.js';

export function parseRecoveryDrillArguments(args: string[]): { phase: 'capture' | 'restore'; root: string } {
  if (
    args.length !== 4 ||
    args[0] !== '--phase' ||
    !['capture', 'restore'].includes(args[1]) ||
    args[2] !== '--root' ||
    !/^\/[a-zA-Z0-9_./-]+$/.test(args[3]) ||
    args[3] === '/' ||
    path.resolve(args[3]) !== args[3]
  )
    throw Error('invalid_recovery_drill_arguments');
  return { phase: args[1] as 'capture' | 'restore', root: args[3] };
}
function privateRoot(root: string) {
  const s = fs.lstatSync(root);
  if (!s.isDirectory() || fs.realpathSync(root) !== root || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700)
    throw Error('private_recovery_drill_required');
}
const nativeHash = (file: string) => {
  const s = fs.lstatSync(file);
  if (
    !s.isFile() ||
    s.nlink !== 1 ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o600 ||
    fs.realpathSync(file) !== file
  )
    throw Error('private_recovery_drill_required');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
};
type Capture = {
  format: 'cos-synthetic-recovery-capture/v1';
  context: Context;
  binding: CosBinding;
  databaseFingerprint: string;
  operationId: string;
  checkpointDigest: string;
  nativeHeadDigest: string;
  witness: { installationDigest: string; generation: string; actionId: string; startDigest: string };
  source: { commit: string; tree: string };
  admissionRestored: false;
  effectsEnabled: false;
};
function identity(root: string, captured: Capture): CoordinatedBackupIdentity {
  return {
    context: captured.context,
    databaseFingerprint: captured.databaseFingerprint,
    operationId: captured.operationId,
    receiptRoot: path.join(root, 'receipt'),
    nativeDatabases: [path.join(root, 'native.sqlite')],
    artifacts: { root: path.join(root, 'artifacts') },
    restrictionFiles: [],
    witness: new ActionWitness(
      path.join(root, 'effects'),
      captured.witness.installationDigest,
      captured.witness.generation,
    ),
  };
}
async function cleanup(client: pg.Client, context: Context) {
  assert.match(context.scopeId, /^recovery-drill-[a-f0-9-]{36}$/);
  await client.query('BEGIN');
  try {
    const own = (
      await client.query('SELECT owner_id,agent_group_id FROM cos.scopes WHERE id=$1 FOR UPDATE', [context.scopeId])
    ).rows[0];
    if (own) {
      assert.equal(own.owner_id, 'synthetic-recovery-owner');
      assert.equal(own.agent_group_id, context.scopeId);
      for (const table of ['revocation_tombstones', 'sources', 'records'])
        await client.query('DELETE FROM cos.' + table + ' WHERE scope_id=$1', [context.scopeId]);
      await client.query('DELETE FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$1', [
        context.scopeId,
        context.ownerId,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
function started(context: Context): StartedActionWitness {
  const id = randomUUID(),
    now = Date.parse('2026-10-05T21:00:00Z');
  const intent = createActionIntent({
    now,
    requestId: id,
    context,
    destination: { instanceId: 'synthetic-recovery', channelId: context.scopeId },
    request: {
      kind: 'calendar_block',
      binding_id: id,
      calendar_id: 'synthetic@example.test',
      start: '2026-10-05T22:00:00Z',
      end: '2026-10-05T23:00:00Z',
      time_zone: 'UTC',
      title: 'Synthetic effect marker',
      description: '',
      project_id: null,
      mission_id: null,
      attendees: [],
    },
    resources: [
      {
        kind: 'writer_binding',
        id,
        version: 1,
        digest: digest('synthetic writer'),
        observed_at: '2026-10-05T21:00:00Z',
      },
      {
        kind: 'availability',
        id: 'availability-' + digest('synthetic slot'),
        version: 1,
        digest: digest('synthetic free'),
        observed_at: '2026-10-05T21:00:00Z',
      },
    ],
  });
  return {
    format: 'cos-action-start-witness/v1',
    intent,
    approvedDigest: digest(intent),
    proposalId: id,
    decisionIngressId: 'synthetic-approved',
    leaseOwner: id,
    fence: 1,
    recordedAt: '2026-10-05T21:01:00Z',
  };
}
/** Called inside the guarded driver so capture and its exclusion lock use the same trusted connection owner. */
export async function captureRecoveryDrill(
  root: string,
  env: NodeJS.ProcessEnv,
  client: pg.Client,
  current: () => void,
) {
  if (process.platform !== 'linux' || fixtureProfile(env) !== 'runtime')
    throw Error('guarded_runtime_capture_required');
  privateRoot(path.dirname(root));
  if (fs.lstatSync(root, { throwIfNoEntry: false })) throw Error('recovery_capture_exists');
  const check = async () => {
    current();
    await assertRuntimeFixtureGuard(env);
    current();
  };
  await check();
  const config = await fixtureDatabaseConfig(env, 'migration'),
    fingerprint = await databaseFingerprint(client, config);
  assert.equal(fingerprint, await assertRuntimeFixtureGuard(env));
  assert.equal(await migrationStatus(client), SCHEMA_VERSION);
  assert.equal((await client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0].locked, true);
  const scopeId = 'recovery-drill-' + randomUUID();
  const context: Context = {
    scopeId,
    ownerId: 'synthetic-recovery-owner',
    agentGroupId: scopeId,
    sessionId: scopeId,
    ingressId: 'synthetic-owner-event',
  };
  const binding: CosBinding = {
    ...context,
    messagingGroupId: scopeId,
    provider: 'codex',
    instanceId: 'synthetic-recovery',
    channelId: scopeId,
    botId: 'synthetic-bot',
  };
  // The binding contains only its documented identity fields, never a fixture ingress capability.
  delete (binding as Partial<Context>).ingressId;
  let seeded = false;
  try {
    fs.mkdirSync(root, { mode: 0o700 });
    for (const name of ['receipt', 'artifacts', 'staging']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    writeAtomic(root, 'seed.json', { context, status: 'started', kind: 'synthetic_only' });
    await check();
    await client.query('BEGIN');
    try {
      await client.query(
        "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,$2,'synthetic-recovery',$1,$1,'paused')",
        [scopeId, context.ownerId],
      );
      await client.query(
        "INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance) VALUES($1,$2,'goal','Synthetic restored goal','No real source content','active',1,'{}')",
        ['goal-' + scopeId, scopeId],
      );
      for (const [id, status] of [
        ['revoked-source', 'revoked'],
        ['later-source', 'current'],
      ])
        await client.query(
          "INSERT INTO cos.sources(id,scope_id,source_key,title,status,processing_providers,access_policy,provenance) VALUES($1,$2,$1,'Synthetic source',$3,ARRAY['codex'],'{}','{}')",
          [id + '-' + scopeId, scopeId, status],
        );
      await client.query(
        "INSERT INTO cos.revocation_tombstones(scope_id,source_id,kind,version,provenance) VALUES($1,$2,'revoke',1,'{}')",
        [scopeId, 'revoked-source-' + scopeId],
      );
      await check();
      await client.query('COMMIT');
      seeded = true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    const nativeFile = path.join(root, 'native.sqlite'),
      native = new Database(nativeFile);
    try {
      installCosBoundary(binding, native);
      native.exec(
        "CREATE TABLE ordinary_messages(id TEXT PRIMARY KEY,body TEXT); INSERT INTO ordinary_messages VALUES('synthetic-message','preserved synthetic history')",
      );
    } finally {
      native.close();
    }
    fs.chmodSync(nativeFile, 0o600);
    const owner = initializeActionWitness(path.join(root, 'effects'), digest({ syntheticInstallation: scopeId }));
    const witness = new ActionWitness(path.join(root, 'effects'), owner.installationDigest, owner.generation);
    const operationId = 'synthetic-' + randomUUID();
    const options = {
      client,
      context,
      databaseFingerprint: fingerprint,
      operationId,
      receiptRoot: path.join(root, 'receipt'),
      nativeDatabases: [nativeFile],
      restrictionFiles: [],
      artifacts: new KnowledgeArtifacts(path.join(root, 'artifacts'), path.join(root, 'staging')),
      witness,
      quiescent: async () => {
        await check();
        return {
          generation: 1,
          activeWorkers: 0 as const,
          activeOperations: 0 as const,
          nativeWriters: 0 as const,
          effectsEnabled: false as const,
        };
      },
    };
    const checkpoint = await backupCoordinatedState(options);
    // A newer deny/effect journal must survive restoration of the older checkpoint.
    await check();
    const start = started(context);
    witness.begin(start);
    const head = new Database(nativeFile);
    try {
      const session = {
        id: scopeId,
        agent_group_id: scopeId,
        messaging_group_id: scopeId,
        agent_provider: 'codex',
        status: 'active',
        thread_id: null,
      } as Session;
      const control = new HostOwnerControls({ db: head, session: () => session, stop: () => {} });
      assert.equal(
        control.record(
          binding,
          {
            id: 'post-backup-revocation',
            ownerId: context.ownerId,
            timestamp: new Date().toISOString(),
            text: 'cos revoke source later-source-' + scopeId,
          },
          { kind: 'revoke_source', target: 'later-source-' + scopeId },
        ).status,
        'ok',
      );
      head.prepare("UPDATE cos_operator_denials SET state='reconciled'").run();
    } finally {
      head.close();
    }
    const info = JSON.parse(fs.readFileSync('build-info.json', 'utf8')) as { commit: string; tree: string };
    assert.match(info.commit, /^[a-f0-9]{40}$/);
    assert.match(info.tree, /^[a-f0-9]{40}$/);
    await check();
    writeAtomic(root, 'capture.json', {
      format: 'cos-synthetic-recovery-capture/v1',
      context,
      binding,
      databaseFingerprint: fingerprint,
      operationId,
      checkpointDigest: digest(checkpoint),
      nativeHeadDigest: nativeHash(nativeFile),
      witness: { ...checkpoint.journal, actionId: start.intent.actionId, startDigest: digest(start) },
      source: { commit: info.commit, tree: info.tree },
      admissionRestored: false,
      effectsEnabled: false,
    } satisfies Capture);
  } finally {
    try {
      if (seeded) {
        await check();
        await cleanup(client, context);
        writeAtomic(root, 'seed.json', { context, status: 'cleaned', kind: 'synthetic_only' });
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(73101003)');
    }
  }
  return { status: 'synthetic_capture_verified', liveModelCalls: 0, realMessages: 0, externalAccountWrites: 0 };
}

export async function restoreRecoveryDrill(root: string, env: NodeJS.ProcessEnv) {
  if (process.platform !== 'linux' || fixtureProfile(env) !== 'test') throw Error('separate_test_restore_required');
  privateRoot(root);
  privateRoot(path.dirname(root));
  const captured = readPrivate<Capture>(path.join(root, 'capture.json'));
  assert.equal(captured.format, 'cos-synthetic-recovery-capture/v1');
  assert.match(captured.context.scopeId, /^recovery-drill-[a-f0-9-]{36}$/);
  assert.equal(captured.context.ownerId, 'synthetic-recovery-owner');
  assert.equal(captured.context.agentGroupId, captured.context.scopeId);
  assert.equal(captured.context.sessionId, captured.context.scopeId);
  assert.equal(captured.admissionRestored, false);
  assert.equal(captured.effectsEnabled, false);
  const base = identity(root, captured),
    initial = digest(captured),
    client = await connectFixtureDatabase(env, 'migration');
  const operationRoot = path.join(path.dirname(root), 'recovery-operation'),
    sandboxRoot = path.join(path.dirname(root), 'recovery-sandbox');
  const check = async () => {
    assert.equal(digest(readPrivate(path.join(root, 'capture.json'))), initial);
    assert.equal(nativeHash(base.nativeDatabases[0]), captured.nativeHeadDigest);
    assert.equal(digest(base.witness.find(captured.witness.actionId)), captured.witness.startDigest);
    assert.equal(digest(await verifyCoordinatedBackup(base)), captured.checkpointDigest);
  };
  let completedProof: Record<string, unknown> | undefined;
  try {
    await check();
    const sandbox = {
      client,
      config: await fixtureDatabaseConfig(env, 'migration'),
      testTargetId: env.COS_TEST_TARGET_ID ?? '',
    };
    assert.notEqual(await databaseFingerprint(client, sandbox.config), captured.databaseFingerprint);
    if (!fs.existsSync(operationRoot)) fs.mkdirSync(operationRoot, { mode: 0o700 });
    privateRoot(operationRoot);
    const restored = await restoreCoordinatedTestScope(base, operationRoot, sandbox, check);
    assert.equal(restored.admissionRestored, false);
    assert.equal((await restoreCoordinatedTestScope(base, operationRoot, sandbox, check)).inserted, false);
    if (fs.existsSync(sandboxRoot)) await verifyCoordinatedLocalSandbox(base, sandboxRoot);
    else
      await restoreCoordinatedSandbox(
        {
          ...base,
          quiescent: async () => ({
            generation: 1,
            activeWorkers: 0,
            activeOperations: 0,
            nativeWriters: 0,
            effectsEnabled: false,
          }),
        },
        sandboxRoot,
      );
    const proof = await verifyCoordinatedSandbox(base, sandboxRoot, sandbox);
    assert.equal(proof.sandboxSeparated, true);
    assert.equal(proof.admissionRestored, false);
    assert.equal(proof.eventJournalRestored, false);
    const restoredNative = new Database(path.join(sandboxRoot, 'sqlite', '0', 'native.sqlite'), { readonly: true });
    try {
      assert.deepEqual(restoredNative.prepare('SELECT * FROM ordinary_messages').all(), [
        { id: 'synthetic-message', body: 'preserved synthetic history' },
      ]);
    } finally {
      restoredNative.close();
    }
    const scope = captured.context.scopeId;
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM cos.revocation_tombstones WHERE scope_id=$1', [scope]))
        .rows[0].n,
      1,
    );
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM cos.actions WHERE scope_id=$1', [scope])).rows[0].n,
      0,
    );
    const start = base.witness.find(captured.witness.actionId)!;
    assert.throws(() => base.witness.begin(start), /action_already_started/);
    const native = new Database(base.nativeDatabases[0], { readonly: true });
    try {
      assert.equal(await ownerDenialsPermitResume(native, captured.binding, client), false);
      // Synthetic administrator reconciliation; real providers require separate read-back/disposition.
      await client.query(
        "INSERT INTO cos.revocation_tombstones(scope_id,source_id,kind,version,provenance) VALUES($1,$2,'revoke',1,'{}')",
        [scope, 'later-source-' + scope],
      );
      await client.query("UPDATE cos.sources SET status='revoked' WHERE scope_id=$1 AND id=$2", [
        scope,
        'later-source-' + scope,
      ]);
      assert.equal(await ownerDenialsPermitResume(native, captured.binding, client), true);
      assert.deepEqual(native.prepare('SELECT paused FROM cos_identity_boundaries').get(), { paused: 1 });
    } finally {
      native.close();
    }
    await check();
    completedProof = {
      format: 'cos-synthetic-two-database-recovery/v1',
      source: captured.source,
      checkpointDigest: captured.checkpointDigest,
      proof,
      scenarios: [
        'verified_distinct_external_databases',
        'idempotent_scope_restore',
        'isolated_native_history',
        'prior_tombstone_retained',
        'post_backup_deny_blocks_resume',
        'post_backup_effect_not_replayed',
        'reconciled_denial_does_not_open_admission',
        'owned_fixture_cleanup',
      ],
      admissionRestored: false,
      effectsEnabled: false,
      providerReadback: 'not_invoked_synthetic_only',
      serverBackupPolicy: 'not_verified',
    };
  } finally {
    try {
      if (fs.existsSync(path.join(operationRoot, 'restore-start.json'))) await cleanup(client, captured.context);
    } finally {
      await client.end();
    }
  }
  if (!completedProof) throw Error('synthetic_recovery_drill_failed');
  writeAtomic(path.dirname(root), 'recovery-proof.json', completedProof);
  return {
    status: 'synthetic_two_database_restore_verified',
    scenarios: 8,
    admissionRestored: false,
    effectsEnabled: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseRecoveryDrillArguments(process.argv.slice(2));
    // Capture is owned by the live guarded driver, never a free-standing runtime login.
    if (args.phase !== 'restore') throw Error('guarded_runtime_capture_required');
    process.stdout.write(JSON.stringify(await restoreRecoveryDrill(args.root, process.env)) + '\n');
  } catch {
    process.stderr.write('{"status":"failed","code":"synthetic_recovery_drill_failed"}\n');
    process.exitCode = 1;
  }
}
