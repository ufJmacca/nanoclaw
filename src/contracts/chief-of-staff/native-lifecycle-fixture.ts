import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { McpFixture } from './mcp-fixture.js';
import { fixtureRelease } from './release-fixture.js';
import { ensureSchema } from '../../db/session-db.js';
import {
  acquireHostExecutionLease,
  assertHostExecutionLease,
  releaseHostExecutionLease,
  type HostExecutionLease,
} from '../../db/host-execution-lease.js';
import { prepareHostExecutionOwnership } from '../../host-shutdown.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from '../../container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from '../../config.js';
import { getInstallSlug } from '../../install-slug.js';
import { safeHostEnvironment } from '../../host-environment.js';
import { restrictedLaunch, type RestrictedLaunchInput } from '../../modules/chief-of-staff/bridge/restricted-launch.js';
import { nativeSmokeLaunch } from '../../modules/chief-of-staff/ops/native-smoke-launch.js';
import {
  deployRelease,
  type DeploymentEffects,
  type DeploymentReceipt,
} from '../../modules/chief-of-staff/ops/deployment.js';
import {
  initializeTarget,
  protectTarget,
  readPrivate,
  readTarget,
  writeAtomic,
  type TargetBinding,
} from '../../modules/chief-of-staff/ops/target-state.js';
import { admittedGeneration } from '../../modules/chief-of-staff/ops/maintenance.js';
import { runTargetHealth, type TargetHealthReceipt } from '../../modules/chief-of-staff/ops/target-health.js';

export type NativeLifecycleFixture = { root: string; hostRoot: string; image: string; caseId: string };

/** Real Docker/MCP and startup cleanup; deployment effects and data are synthetic. */
export async function rehearseNativeLifecycle(input: NativeLifecycleFixture) {
  if (
    process.platform !== 'linux' ||
    input.root !== process.cwd() ||
    [input.root, input.hostRoot].some((p) => !path.isAbsolute(p) || path.resolve(p) !== p || /[,\r\n\0]/.test(p)) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.image) ||
    !/^[a-f0-9-]{36}$/.test(input.caseId)
  )
    throw Error('isolated_lifecycle_fixture_required');
  const stat = fs.lstatSync(input.root);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700 ||
    fs.realpathSync(input.root) !== input.root
  )
    throw Error('private_lifecycle_fixture_required');
  assert.equal(CONTAINER_INSTALL_LABEL, 'nanoclaw-install=' + getInstallSlug(input.root));
  process.env.NANOCLAW_LOG_STDERR = 'true';
  const marker = 'nanoclaw.cos-lifecycle-case=' + input.caseId;
  const docker = async (...args: string[]) =>
    (
      await promisify(execFile)('docker', args, {
        env: safeHostEnvironment('docker'),
        timeout: 10000,
        maxBuffer: 1024 ** 2,
      })
    ).stdout.trim();
  assert.equal(await docker('ps', '--all', '--quiet', '--filter', 'label=' + CONTAINER_INSTALL_LABEL), '');
  const db = new Database(path.join(input.root, 'synthetic.db'));
  db.exec(
    'CREATE TABLE host_execution_lease(singleton_id INTEGER PRIMARY KEY,owner_id TEXT,pid INTEGER,acquired_at TEXT); CREATE TABLE fixture_protected_state(id INTEGER PRIMARY KEY,body TEXT NOT NULL)',
  );
  const protectedState = JSON.stringify({
    messages: ['synthetic retained message'],
    context: 'fixture-main',
    paused: true,
    attempts: 6,
  });
  db.prepare('INSERT INTO fixture_protected_state VALUES(1,?)').run(protectedState);
  const unchanged = () =>
    assert.equal(
      (db.prepare('SELECT body FROM fixture_protected_state WHERE id=1').get() as { body: string }).body,
      protectedState,
    );
  const targetRoot = path.join(input.root, 'target');
  const binding: TargetBinding = {
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
    service: 'fixture.service',
    installationRoot: input.root,
    dataRoot: input.root,
  };
  initializeTarget(targetRoot, binding);
  protectTarget(targetRoot, binding);
  const old = { ...fixtureRelease('S02'), releaseId: 'release-lifecycle-old' };
  let selected = old,
    mode: 'baseline' | 'legacy' | 'corrected' = 'baseline';
  let activeRelease: string | null = null,
    lease: HostExecutionLease | undefined,
    startups = 0;
  let client: McpFixture | undefined, server: net.Server | undefined, canary: string | undefined;
  const closeProbe = async () => {
    await client?.close();
    client = undefined;
    if (canary) await docker('rm', '--force', canary).catch(() => {});
    canary = undefined;
    if (server)
      await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  };
  const openProbe = async (launchProbe: (input: RestrictedLaunchInput) => ReturnType<typeof restrictedLaunch>) => {
    const probe = fs.mkdtempSync(path.join(input.root, 'probe-'));
    const session = path.join(probe, 'cos-v1');
    fs.mkdirSync(session, { mode: 0o700 });
    fs.mkdirSync(path.join(session, 'agent'), { mode: 0o700 });
    ensureSchema(path.join(session, 'inbound.db'), 'inbound');
    ensureSchema(path.join(session, 'outbound.db'), 'outbound');
    const configurationFile = path.join(probe, 'config.json'),
      gatewaySocket = path.join(probe, 'model.sock');
    fs.writeFileSync(
      configurationFile,
      JSON.stringify({
        provider: 'codex',
        model: 'fixture-model',
        agentGroupId: 'fixture-smoke',
        assistantName: 'CoS',
        groupName: 'CoS',
        maxMessagesPerPrompt: 10,
        mcpServers: {},
      }),
      { mode: 0o600 },
    );
    server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(gatewaySocket, resolve);
    });
    const launch = launchProbe({
      image: input.image,
      sessionDirectory: session,
      configurationFile,
      gatewaySocket,
      uid: process.getuid!(),
      gid: process.getgid!(),
      entry: 'mcp',
    });
    launch.args = launch.args.map((arg) =>
      arg.startsWith('type=bind,') ? arg.replace('src=' + input.root + '/', 'src=' + input.hostRoot + '/') : arg,
    );
    launch.args.splice(launch.args.indexOf(input.image), 0, '--label', marker);
    client = new McpFixture(input.root, session, input.hostRoot, input.image, '', launch, { startupTimeoutMs: 90000 });
    await client.start();
    canary = await docker(
      'run',
      '--detach',
      '--rm',
      '--pull=never',
      '--name',
      'nanoclaw-lifecycle-old-' + randomUUID(),
      '--label',
      CONTAINER_INSTALL_LABEL,
      '--label',
      marker,
      '--network=none',
      '--read-only',
      '--user=1000:1000',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=32',
      '--memory=128m',
      '--entrypoint=bun',
      input.image,
      '-e',
      'setInterval(()=>{},1000)',
    );
    assert.match(canary, /^[a-f0-9]{64}$/);
    const owned = (await docker('ps', '--no-trunc', '--quiet', '--filter', 'label=' + CONTAINER_INSTALL_LABEL))
      .split('\n')
      .filter(Boolean);
    const probeId = JSON.parse(await docker('inspect', client.name))[0].Id as string;
    assert.ok(owned.every((id) => id === canary || id === probeId));
    const ownership = prepareHostExecutionOwnership({
      initializeDatabase: () => db,
      migrateDatabase: () => unchanged(),
      acquireExecutionLease: () => acquireHostExecutionLease(db),
      migrateFilesystem: () => {},
      ensureContainerRuntime: ensureContainerRuntimeRunning,
      cleanupOrphans,
      openContainerAdmissions: () => unchanged(),
      openDeliveryIntake: () => unchanged(),
    });
    lease = ownership.lease;
    startups++;
    assertHostExecutionLease(db, lease);
    assert.equal(await docker('ps', '--quiet', '--filter', 'id=' + canary), '');
  };
  const effects: DeploymentEffects = {
    verify: async () => {
      unchanged();
    },
    source: async () => {},
    artifacts: async () => {},
    quiesce: async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }),
    backup: async () => {
      unchanged();
    },
    migrate: async () => {
      unchanged();
    },
    activate: async () => {
      activeRelease = selected.releaseId;
      if (mode !== 'baseline') await openProbe(mode === 'legacy' ? restrictedLaunch : nativeSmokeLaunch);
    },
    health: async () => {
      if (mode === 'baseline') return true;
      try {
        return await runTargetHealth({
          releaseId: selected.releaseId,
          sourceCommit: selected.source.commit,
          checks: [
            {
              stage: 'process',
              run: async () => {
                assert.equal(activeRelease, selected.releaseId);
                assert.ok(lease);
                assertHostExecutionLease(db, lease);
                unchanged();
              },
            },
            {
              stage: 'fixture',
              run: async () => {
                assert.ok(client);
                if (!(await docker('ps', '--quiet', '--filter', 'name=^/' + client.name + '$')))
                  throw Object.assign(Error('synthetic_probe_stopped'), { code: 'fixture_mcp_transport_unavailable' });
                const tools = await client.request('tools/list', {});
                assert.ok(tools.tools.some((tool: { name: string }) => tool.name === 'cos_mail_search'));
              },
            },
          ],
          write: (result) => writeAtomic(path.join(targetRoot, 'releases', selected.releaseId), 'health.json', result),
        });
      } finally {
        await closeProbe();
      }
    },
    reconcile: async () => 'retry_safe',
    rollback: async (previous) => {
      assert.equal(previous, old.releaseId);
      activeRelease = previous;
      unchanged();
      if (lease) assert.equal(releaseHostExecutionLease(db, lease), true);
      lease = undefined;
      return true;
    },
  };
  try {
    await deployRelease({ root: targetRoot, binding, manifest: selected, effects });
    selected = {
      ...fixtureRelease('S02'),
      releaseId: 'release-lifecycle-collision',
      previousReleaseIds: [old.releaseId],
    };
    mode = 'legacy';
    await assert.rejects(
      deployRelease({ root: targetRoot, binding, manifest: selected, effects }),
      /deployment_rolled_back/,
    );
    const failedFile = path.join(targetRoot, 'releases', selected.releaseId, 'deployment.json');
    const failedBytes = fs.readFileSync(failedFile);
    assert.equal(readPrivate<DeploymentReceipt>(failedFile).status, 'rolled_back');
    assert.equal(
      readPrivate<TargetHealthReceipt>(path.join(path.dirname(failedFile), 'health.json')).code,
      'fixture_mcp_transport_unavailable',
    );
    assert.equal(readTarget(targetRoot, binding).releaseId, old.releaseId);
    assert.equal(admittedGeneration(targetRoot, binding), null);
    const beforeReplay = startups;
    await assert.rejects(
      deployRelease({ root: targetRoot, binding, manifest: selected, effects }),
      /deployment_rolled_back/,
    );
    assert.equal(startups, beforeReplay);
    unchanged();
    selected = {
      ...fixtureRelease('S02'),
      releaseId: 'release-lifecycle-corrected',
      previousReleaseIds: [old.releaseId],
    };
    mode = 'corrected';
    assert.equal((await deployRelease({ root: targetRoot, binding, manifest: selected, effects })).status, 'healthy');
    assert.notEqual(admittedGeneration(targetRoot, binding), null);
    assert.equal(readTarget(targetRoot, binding).lifecycle, 'protected');
    assert.deepEqual(fs.readFileSync(failedFile), failedBytes);
    unchanged();
    return {
      status: 'native_startup_cleanup_health_rollback_lifecycle_rehearsed',
      image: input.image,
      startupCleanupAndRealMcp: true,
      legacyCollisionReproduced: true,
      compatibleRollbackClosedAdmission: true,
      terminalReplayRejected: true,
      freshCorrectedOperationHealthy: true,
      originalFailurePreserved: true,
      syntheticProtectedStatePreserved: true,
      fixtureStartups: startups,
      actualAccountCalls: 0,
      actualModelCalls: 0,
      deploymentSourceArtifactsAndMigration: 'synthetic_effects',
      actualPiAcceptance: false,
    };
  } finally {
    await closeProbe();
    if (lease) releaseHostExecutionLease(db, lease);
    db.close();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  rehearseNativeLifecycle(JSON.parse(process.argv[2]))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          status: 'native_lifecycle_rehearsal_failed',
          code: typeof error?.code === 'string' ? error.code : null,
          message: String(error?.message ?? '').slice(0, 1000),
          actualAccountCalls: 0,
          actualModelCalls: 0,
        }),
      );
      process.exitCode = 1;
    });
}
