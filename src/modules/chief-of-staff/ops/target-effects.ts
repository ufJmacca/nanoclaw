import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { digest } from '../domain/contracts.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { imageProfile, readReleaseAt } from '../../../release-runtime.js';
import { migrationStatus, SCHEMA_VERSION } from '../store/migrations.js';
import { databaseCommand } from './db-cli.js';
import { readPrivate, readTarget, writeAtomic } from './target-state.js';
import { maintenanceLeaseForOwner, assertMaintenanceLease } from './maintenance.js';
import { backupNativeDatabase, installServiceOverride, restoreServiceOverride } from './native-installation.js';
import { backupConversations, verifyConversationBackup } from './conversation-backup.js';
import { backupCalendarState, verifyCalendarBackup } from '../calendar/backup.js';
import { fenceLegacyCoordinators } from './legacy-rollback.js';
import { assertNativeReleaseCompatibility } from './native-release-compatibility.js';
import { artifactHash, verifyReleaseBundle, verifyLoadedImages } from './release-artifacts.js';
import { payloadDigest } from './payload.js';
import { waitForTargetProcess } from './service-readiness.js';
import { syncPinnedSource } from './source-sync.js';
import { nativeFixtureSmoke } from './native-smoke.js';
import {
  targetBinding,
  targetCommands,
  verifyTargetPaths,
  checkedTargetDatabase,
  readTargetDatabaseEnvironment,
  verifyInstalledProfiles,
} from './target-host.js';
import type { DeploymentSettings } from './deployment-settings.js';
import { validateReleaseManifest, supportsReleaseSchema, type ReleaseManifest } from './release-manifest.js';
import type { DeploymentEffects, DeploymentReceipt } from './deployment.js';
import { bindCommand } from './admin.js';
import type { BindingRequest } from './bind.js';
import { readEnvFile } from '../../../env.js';

type Baseline = {
  version: 1;
  bindingDigest: string;
  releaseId: string | null;
  executable: string;
  entryPoint: string;
  unit: string;
  recoveryFrom?: string;
};
/** Concrete Pi operations. The CLI holds an OS lock; mutations additionally require its durable maintenance lease. */
export function createTargetEffects(
  settings: DeploymentSettings,
  input: ReleaseManifest,
  manifestHash: string,
  coordinatorBinding?: BindingRequest,
): DeploymentEffects {
  const manifest = validateReleaseManifest(input),
    binding = targetBinding(settings),
    commands = targetCommands(settings);
  const stage = path.join(settings.stagingRoot, manifest.releaseId),
    release = path.join(settings.releaseRoot, manifest.releaseId),
    payload = path.join(release, 'payload'),
    receipt = path.join(settings.stateRoot, 'releases', manifest.releaseId),
    central = path.join(settings.dataRoot, 'v2.db');
  const override = {
    configurationRoot: path.join(settings.userHome, '.config/systemd/user'),
    receiptRoot: receipt,
    service: settings.service,
    installationRoot: settings.installationRoot,
    payloadRoot: payload,
    manifest: path.join(release, 'release.json'),
    stateRoot: settings.stateRoot,
    runtimeEnvironment: settings.runtimeEnvironment,
  };
  const lease = (quiescent = true) => {
    const current = maintenanceLeaseForOwner(settings.stateRoot, binding, manifest.releaseId);
    if (quiescent) assertMaintenanceLease(settings.stateRoot, binding, current);
    return current;
  };
  const verifyQuiescent = async () => {
    lease();
    const observed = await commands.observe();
    if (
      observed.pid !== 0 ||
      observed.cwd !== settings.installationRoot ||
      !['inactive', 'failed'].includes(observed.activeState) ||
      (await commands.ownedContainers()).length
    )
      throw new Error('target_not_quiescent');
    lease();
  };
  const calendarBackup = {
    roots: { targetRoot: settings.stateRoot, installationRoot: settings.installationRoot, dataRoot: settings.dataRoot },
    operationId: manifest.releaseId,
    receiptRoot: receipt,
    check: verifyQuiescent,
  };
  const observeProcess = async (expectedPayload?: string) => {
    const observed = await commands.observe();
    if (
      observed.cwd !== settings.installationRoot ||
      observed.activeState !== 'active' ||
      observed.subState !== 'running' ||
      observed.pid <= 0
    )
      throw new Error('target_service_unhealthy');
    const proc = `/proc/${observed.pid}`;
    if (fs.statSync(proc).uid !== process.getuid?.() || fs.readlinkSync(proc + '/cwd') !== settings.installationRoot)
      throw new Error('target_process_mismatch');
    const args = fs
        .readFileSync(proc + '/cmdline', 'utf8')
        .split('\0')
        .filter(Boolean),
      executable = fs.readlinkSync(proc + '/exe');
    if (
      args.length !== 2 ||
      !path.isAbsolute(args[1]) ||
      (expectedPayload &&
        (executable !== path.join(expectedPayload, 'node/bin/node') ||
          args[1] !== path.join(expectedPayload, 'dist/index.js')))
    )
      throw new Error('target_process_mismatch');
    const db = new Database(central, { readonly: true, fileMustExist: true });
    try {
      const owner = db.prepare('SELECT pid FROM host_execution_lease WHERE singleton_id=1').get() as
        | { pid: number }
        | undefined;
      if (!owner || owner.pid !== observed.pid) throw new Error('target_host_ownership_mismatch');
    } finally {
      db.close();
    }
    return { executable, entryPoint: args[1] };
  };
  const schema = async () => {
    const check = await checkedTargetDatabase(settings);
    try {
      return await migrationStatus(check);
    } finally {
      await check.end();
    }
  };
  const nativeCompatible = (candidate: ReleaseManifest | null) => {
    const db = new Database(central, { readonly: true, fileMustExist: true });
    try {
      assertNativeReleaseCompatibility(db, candidate);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'specialist_release_required') return false;
      throw error;
    } finally {
      db.close();
    }
  };
  const stopAndVerify = async () => {
    await commands.service('stop');
    const stopped = await commands.observe();
    if (
      stopped.cwd !== settings.installationRoot ||
      stopped.pid !== 0 ||
      !['inactive', 'failed'].includes(stopped.activeState)
    )
      throw new Error('target_not_quiescent');
    for (const id of await commands.ownedContainers()) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('invalid_owned_container');
      await commands.docker(['stop', '--time', '10', id]);
    }
    if ((await commands.ownedContainers()).length) throw new Error('target_not_quiescent');
    const db = new Database(central, { readonly: true, fileMustExist: true });
    try {
      const owner = db.prepare('SELECT pid FROM host_execution_lease WHERE singleton_id=1').get() as
        | { pid: number }
        | undefined;
      if (owner) {
        try {
          process.kill(owner.pid, 0);
          throw new Error('target_host_writer_active');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    } finally {
      db.close();
    }
  };
  const baseline = () => {
    const value = readPrivate<Baseline>(path.join(receipt, 'baseline.json'));
    if (
      value.version !== 1 ||
      value.bindingDigest !== digest(binding) ||
      !path.isAbsolute(value.executable) ||
      !path.isAbsolute(value.entryPoint)
    )
      throw new Error('baseline_conflict');
    if (value.recoveryFrom !== undefined) {
      if (!/^release-[a-zA-Z0-9_-]{1,120}$/.test(value.recoveryFrom)) throw new Error('baseline_conflict');
      const own = readPrivate<DeploymentReceipt>(path.join(receipt, 'deployment.json'));
      const previous = readPrivate<DeploymentReceipt>(
        path.join(settings.stateRoot, 'releases', value.recoveryFrom, 'deployment.json'),
      );
      if (
        own.recoveryFrom !== value.recoveryFrom ||
        previous.status !== 'superseded' ||
        previous.supersededBy !== manifest.releaseId ||
        previous.bindingDigest !== digest(binding)
      )
        throw new Error('baseline_conflict');
    }
    return value;
  };
  const effects: DeploymentEffects = {
    async prepareRecovery(previous) {
      if (
        !/^release-[a-zA-Z0-9_-]{1,120}$/.test(previous.releaseId) ||
        previous.releaseId === manifest.releaseId ||
        previous.bindingDigest !== digest(binding)
      )
        throw new Error('deployment_recovery_denied');
      const priorManifest = validateReleaseManifest(
        readPrivate(path.join(settings.releaseRoot, previous.releaseId, 'release.json')),
      );
      if (
        priorManifest.releaseId !== previous.releaseId ||
        digest(priorManifest) !== previous.manifestDigest ||
        !supportsReleaseSchema(manifest, await schema()) ||
        !nativeCompatible(manifest)
      )
        throw new Error('deployment_recovery_denied');
      const priorEffects = createTargetEffects(settings, priorManifest, previous.manifestDigest);
      const result = await priorEffects.quiesce();
      if (result.activeCoordinators !== 0 || result.activeDatabaseOperations !== 0) return result;
      const original = readPrivate<Baseline>(
        path.join(settings.stateRoot, 'releases', previous.releaseId, 'baseline.json'),
      );
      const recovered: Baseline = {
        ...original,
        releaseId: readTarget(settings.stateRoot, binding).releaseId,
        recoveryFrom: previous.releaseId,
        unit: await commands.service('cat'),
      };
      const file = path.join(receipt, 'baseline.json');
      if (fs.lstatSync(file, { throwIfNoEntry: false }) && digest(readPrivate(file)) !== digest(recovered))
        throw new Error('baseline_conflict');
      writeAtomic(receipt, 'baseline.json', recovered);
      return result;
    },
    async verify() {
      const bundle = await verifyReleaseBundle(stage, manifestHash);
      if (digest(bundle.manifest) !== digest(manifest)) throw new Error('release_manifest_mismatch');
      const setupFile = path.join(receipt, 'binding-setup.json');
      if (
        fs.lstatSync(setupFile, { throwIfNoEntry: false }) &&
        digest(readPrivate(setupFile)) !== digest(coordinatorBinding ?? null)
      )
        throw new Error('binding_setup_conflict');
      verifyTargetPaths(settings, 1024 * 1024 * 1024);
      if (!nativeCompatible(manifest)) throw new Error('specialist_release_required');
      verifyInstalledProfiles(settings, manifest);
      if ((await commands.observe()).cwd !== settings.installationRoot) throw new Error('wrong_service_installation');
      for (const login of ['runtime', 'migration'] as const) {
        const check = await checkedTargetDatabase(settings, login);
        await check.end();
      }
    },
    async source() {
      const result = await syncPinnedSource({
        repository: settings.installationRoot,
        sourceRoot: settings.sourceRoot,
        releaseId: manifest.releaseId,
        source: manifest.source,
      });
      writeAtomic(receipt, 'source.json', result);
    },
    async artifacts() {
      await verifyLoadedImages(manifest, commands.inspect);
      if (
        (await artifactHash(override.manifest, 262144)) !== manifestHash ||
        (await payloadDigest(payload)) !== manifest.hostPayloadDigest
      )
        throw new Error('release_payload_mismatch');
      readReleaseAt(payload, override.manifest);
      await commands.payloadProbe(payload);
    },
    async quiesce() {
      lease(false);
      if (!fs.lstatSync(path.join(receipt, 'baseline.json'), { throwIfNoEntry: false })) {
        const identity = await observeProcess();
        const previous = readTarget(settings.stateRoot, binding).releaseId;
        if (previous === null && identity.entryPoint !== path.join(settings.installationRoot, 'dist/index.js'))
          throw new Error('unrecorded_service_invocation');
        writeAtomic(receipt, 'baseline.json', {
          version: 1,
          bindingDigest: digest(binding),
          releaseId: previous,
          ...identity,
          unit: await commands.service('cat'),
        });
      } else baseline();
      await stopAndVerify();
      const check = await checkedTargetDatabase(settings);
      try {
        const locked = (await check.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked;
        return { activeCoordinators: 0, activeDatabaseOperations: locked ? 0 : 1 };
      } finally {
        await check.end();
      }
    },
    async backup() {
      await verifyQuiescent();
      await backupNativeDatabase(central, receipt);
      const db = new Database(central, { readonly: true, fileMustExist: true });
      let sessions: Array<{ id: string; agent_group_id: string }>;
      try {
        sessions = db.prepare('SELECT id,agent_group_id FROM sessions ORDER BY id').all() as typeof sessions;
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cos_conversation_states'").get()) {
          const contexts = db.prepare('SELECT generation FROM cos_conversation_states').all() as Array<{
            generation: string;
          }>;
          for (const context of contexts) {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(context.generation))
              throw new Error('conversation_backup_missing_history');
            const directory = path.join(settings.stateRoot, 'conversations', context.generation);
            const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
            if (
              !stat?.isDirectory() ||
              fs.realpathSync(directory) !== directory ||
              stat.uid !== process.getuid?.() ||
              (stat.mode & 0o777) !== 0o700
            )
              throw new Error('conversation_backup_missing_history');
          }
        }
      } finally {
        db.close();
      }
      const backups = [];
      for (const session of sessions) {
        if ([session.id, session.agent_group_id].some((id) => !/^[a-zA-Z0-9_-]{1,200}$/.test(id)))
          throw new Error('unsafe_session_reference');
        for (const suffix of ['', 'cos-v1'])
          for (const name of ['inbound.db', 'outbound.db']) {
            const source = path.join(
              settings.dataRoot,
              'v2-sessions',
              session.agent_group_id,
              session.id,
              suffix,
              name,
            );
            if (!fs.lstatSync(source, { throwIfNoEntry: false })) continue;
            const destination = path.join(receipt, 'session-' + digest(source).slice(0, 32));
            if (!fs.existsSync(destination)) fs.mkdirSync(destination, { mode: 0o700 });
            backups.push(await backupNativeDatabase(source, destination));
          }
      }
      const conversations = await backupConversations(path.join(settings.stateRoot, 'conversations'), receipt);
      const calendar = await backupCalendarState(calendarBackup);
      await verifyQuiescent();
      writeAtomic(receipt, 'native-state.json', {
        version: 1,
        installationRoot: settings.installationRoot,
        dataRoot: settings.dataRoot,
        groupsRoot: path.join(settings.installationRoot, 'groups'),
        sessions: backups,
        conversations,
        calendar,
        configurationPreserved: true,
      });
    },
    async migrate() {
      await verifyQuiescent();
      // Revalidate the preserved central backup before either store is changed.
      await backupNativeDatabase(central, receipt);
      await verifyConversationBackup(path.join(settings.stateRoot, 'conversations'), receipt);
      await verifyCalendarBackup(calendarBackup);
      await verifyQuiescent();
      const env: NodeJS.ProcessEnv = {
        ...readTargetDatabaseEnvironment(settings, 'migration'),
        COS_TARGET_STATE_DIR: settings.stateRoot,
      };
      if (manifest.postgres.maximum !== SCHEMA_VERSION) throw new Error('migration_manifest_mismatch');
      const result = await databaseCommand(
        ['migrate', '--profile', 'runtime', '--confirm-database', env.COS_PGDATABASE!],
        env,
      );
      const db = new Database(central, { fileMustExist: true });
      try {
        db.pragma('foreign_keys = ON');
        runMigrations(db);
      } finally {
        db.close();
      }
      writeAtomic(receipt, 'migration.json', {
        ...result,
        sourceCommit: manifest.source.commit,
        migrations: manifest.migrations,
        native: 'cos-subscription-context',
      });
      if (coordinatorBinding) {
        writeAtomic(receipt, 'binding-setup.json', coordinatorBinding);
        const keys = ['MATTERMOST_URL', 'MATTERMOST_BOT_TOKEN', 'MATTERMOST_INSTANCE'];
        const file = readEnvFile(keys);
        const selected = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? file[key]]));
        const result = await bindCommand(coordinatorBinding, {
          ...readTargetDatabaseEnvironment(settings, 'runtime'),
          ...selected,
          COS_ENABLED: 'true',
          COS_TARGET_STATE_DIR: settings.stateRoot,
        });
        writeAtomic(receipt, 'binding.json', result);
      }
    },
    async activate() {
      lease();
      if (!supportsReleaseSchema(manifest, await schema())) throw new Error('schema_incompatible');
      await effects.artifacts();
      if (!nativeCompatible(manifest)) throw new Error('specialist_release_required');
      installServiceOverride(override);
      await commands.service('daemon-reload');
      await commands.service('restart');
    },
    async health() {
      if (!nativeCompatible(manifest)) return false;
      let running = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          await observeProcess(payload);
          running = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!running) return false;
      if (!supportsReleaseSchema(manifest, await schema())) return false;
      verifyInstalledProfiles(settings, manifest);
      await verifyLoadedImages(manifest, commands.inspect);
      const image = manifest.images.find(
        (image) => image.role === 'agent' && image.profile === imageProfile('codex', { apt: [], npm: [] }),
      );
      if (!image) throw new Error('coordinator_image_unavailable');
      const result = await nativeFixtureSmoke({
        root: path.join(settings.stateRoot, 'smoke'),
        hostRoot: path.join(settings.stateRoot, 'smoke'),
        image: image.id,
      });
      writeAtomic(receipt, 'native-smoke.json', {
        ...result,
        sourceCommit: manifest.source.commit,
        imageId: image.id,
        at: new Date().toISOString(),
      });
      return true;
    },
    async reconcile(phase) {
      if (phase === 'activate') {
        try {
          if (!nativeCompatible(manifest)) return 'retry_safe';
          await observeProcess(payload);
          return 'done';
        } catch {
          return 'retry_safe';
        }
      }
      if (phase === 'migrate') {
        lease();
        // Migrations themselves verify recorded checksums and execute transactionally on every retry.
        return 'retry_safe';
      }
      return 'retry_safe';
    },
    async rollback(previousReleaseId) {
      lease(false);
      const previous = baseline();
      if (previous.releaseId !== previousReleaseId) throw new Error('rollback_identity_mismatch');
      // A failed predecessor is retained as recovery evidence, never promoted to known-good rollback code.
      if (previous.recoveryFrom) return false;
      let rollbackManifest: ReleaseManifest | null = null;
      if (previousReleaseId) {
        if (!manifest.previousReleaseIds.includes(previousReleaseId)) return false;
        const prior = validateReleaseManifest(
          readPrivate(path.join(settings.releaseRoot, previousReleaseId, 'release.json')),
        );
        rollbackManifest = prior;
        if (!nativeCompatible(prior)) return false;
        const priorReceipt = readPrivate<{ status: string; manifestDigest: string }>(
          path.join(settings.stateRoot, 'releases', previousReleaseId, 'deployment.json'),
        );
        if (priorReceipt.status !== 'healthy' || priorReceipt.manifestDigest !== digest(prior)) return false;
        verifyInstalledProfiles(settings, prior);
        const version = await schema();
        if (!supportsReleaseSchema(prior, version, manifest.sqlite.maximum)) return false;
        await verifyLoadedImages(prior, commands.inspect);
        if (
          (await payloadDigest(path.join(settings.releaseRoot, previousReleaseId, 'payload'))) !==
          prior.hostPayloadDigest
        )
          return false;
      }
      if (!nativeCompatible(rollbackManifest)) return false;
      await stopAndVerify();
      // A child may have been allocated while preflight awaited image/schema checks.
      if (!nativeCompatible(rollbackManifest)) return false;
      if (previousReleaseId === null) {
        const db = new Database(central, { fileMustExist: true });
        try {
          db.pragma('foreign_keys = ON');
          fenceLegacyCoordinators(db);
        } finally {
          db.close();
        }
      }
      if (fs.lstatSync(path.join(receipt, 'service-override.json'), { throwIfNoEntry: false }))
        restoreServiceOverride(override);
      else if ((await commands.service('cat')) !== previous.unit) throw new Error('service_override_conflict');
      await commands.service('daemon-reload');
      await commands.service('start');
      const restored = await waitForTargetProcess(() =>
        observeProcess(previousReleaseId ? path.join(settings.releaseRoot, previousReleaseId, 'payload') : undefined),
      );
      return restored.entryPoint === previous.entryPoint && restored.executable === previous.executable;
    },
  };
  return effects;
}
