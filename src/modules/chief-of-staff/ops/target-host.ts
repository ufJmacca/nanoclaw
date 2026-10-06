import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseEnv, promisify } from 'node:util';
import Database from 'better-sqlite3';
import { getInstallSlug } from '../../../install-slug.js';
import { imageProfile, type ImageInspection } from '../../../release-runtime.js';
import { machineFingerprint, databaseFingerprint } from './target-identity.js';
import { connectChecked } from '../store/preflight.js';
import { parseDatabaseConfig } from '../store/config.js';
import type { DeploymentSettings } from './deployment-settings.js';
import type { ReleaseManifest } from './release-manifest.js';
import type { TargetBinding } from './target-state.js';

const runtimeKeys = [
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
].map((suffix) => 'COS_PG' + suffix);
export const RUNTIME_DATABASE_ENVIRONMENT_KEYS: readonly string[] = Object.freeze([...runtimeKeys]);
function privateEnvironment(file: string, allowed: string[]): NodeJS.ProcessEnv {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error('unsafe_target_credentials');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536)
      throw new Error('unsafe_target_credentials');
    const values = parseEnv(fs.readFileSync(fd, 'utf8'));
    if (Object.keys(values).some((key) => !allowed.includes(key))) throw new Error('unsafe_target_credentials');
    return values;
  } finally {
    fs.closeSync(fd);
  }
}
export function readTargetDatabaseEnvironment(
  settings: Pick<DeploymentSettings, 'runtimeEnvironment' | 'migrationEnvironment'>,
  login: 'runtime' | 'migration',
): NodeJS.ProcessEnv {
  const runtime = privateEnvironment(settings.runtimeEnvironment, runtimeKeys);
  if (login === 'runtime') return runtime;
  const shared = runtimeKeys.filter((key) => !['COS_PGUSER', 'COS_PGPASSWORD'].includes(key));
  const migration = privateEnvironment(settings.migrationEnvironment, [
    ...shared,
    'COS_PG_MIGRATION_USER',
    'COS_PG_MIGRATION_PASSWORD',
  ]);
  if (shared.some((key) => migration[key] !== undefined && migration[key] !== runtime[key]))
    throw new Error('target_credential_profile_mismatch');
  return { ...runtime, ...migration };
}
/** Explicitly selected separate restore profile, read only by trusted owner tooling. */
export function readTargetTestEnvironment(file: string): NodeJS.ProcessEnv {
  return privateEnvironment(file, [
    ...runtimeKeys.map((key) => key.replace('COS_PG', 'COS_TEST_PG')),
    'COS_TEST_PG_MIGRATION_USER',
    'COS_TEST_PG_MIGRATION_PASSWORD',
    'COS_TEST_TARGET_ID',
  ]);
}
export function serviceObservation(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.trim().split('\n')) {
    const match = /^(ActiveState|SubState|MainPID|WorkingDirectory)=(.*)$/.exec(line);
    if (!match || values[match[1]] !== undefined) throw new Error('invalid_service_observation');
    values[match[1]] = match[2];
  }
  if (
    Object.keys(values).length !== 4 ||
    !/^[0-9]+$/.test(values.MainPID) ||
    !Number.isSafeInteger(Number(values.MainPID)) ||
    !['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading'].includes(values.ActiveState) ||
    !/^[a-z-]+$/.test(values.SubState) ||
    !path.isAbsolute(values.WorkingDirectory)
  )
    throw new Error('invalid_service_observation');
  return {
    activeState: values.ActiveState,
    subState: values.SubState,
    pid: Number(values.MainPID),
    cwd: values.WorkingDirectory,
  };
}
export function targetBinding(settings: DeploymentSettings): TargetBinding {
  return {
    hostFingerprint: settings.hostFingerprint,
    databaseFingerprint: settings.databaseFingerprint,
    service: settings.service,
    installationRoot: settings.installationRoot,
    dataRoot: settings.dataRoot,
  };
}
export function targetCommands(settings: Pick<DeploymentSettings, 'userHome' | 'installationRoot' | 'service'>) {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error('target_user_required');
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: settings.userHome,
    LANG: 'C.UTF-8',
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
  const execute = async (file: string, args: string[], timeout = 30000, cwd = settings.installationRoot) =>
    (await promisify(execFile)(file, args, { env, cwd, timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const docker = (args: string[], timeout = 30000) =>
    execute('/usr/bin/docker', ['--host=unix:///var/run/docker.sock', ...args], timeout);
  const service = (operation: 'show' | 'cat' | 'stop' | 'start' | 'restart' | 'daemon-reload') =>
    execute(
      '/usr/bin/systemctl',
      [
        '--user',
        operation,
        ...(operation === 'daemon-reload' ? [] : [settings.service]),
        ...(operation === 'show' ? ['--property=ActiveState,SubState,MainPID,WorkingDirectory'] : []),
      ],
      120000,
    );
  return {
    docker,
    service,
    observe: async () => serviceObservation(await service('show')),
    inspect: async (id: string): Promise<ImageInspection> => {
      if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('immutable_image_required');
      const rows = JSON.parse(await docker(['image', 'inspect', id]));
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('image_unavailable');
      return rows[0];
    },
    ownedContainers: async () =>
      (
        await docker([
          'ps',
          '--filter',
          `label=nanoclaw-install=${getInstallSlug(settings.installationRoot)}`,
          '--format',
          '{{.ID}}',
        ])
      )
        .split('\n')
        .filter(Boolean),
    payloadProbe: async (payload: string) => {
      const result = await execute(
        path.join(payload, 'node/bin/node'),
        [
          '-e',
          "const D=require('better-sqlite3');const db=new D(':memory:');db.exec('CREATE TABLE native_probe(id INTEGER)');db.close();if(process.platform!=='linux'||process.arch!=='arm64')process.exit(2);console.log('native-payload-ok')",
        ],
        10000,
        payload,
      );
      if (result !== 'native-payload-ok') throw new Error('incompatible_host_payload');
    },
  };
}
export function verifyTargetPaths(settings: DeploymentSettings, minimumFreeBytes: number): void {
  if (machineFingerprint() !== settings.hostFingerprint || process.cwd() !== settings.installationRoot)
    throw new Error('wrong_deployment_target');
  for (const directory of [settings.userHome, settings.installationRoot, settings.dataRoot]) {
    const stat = fs.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      fs.realpathSync(directory) !== directory ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o022
    )
      throw new Error('unsafe_target_installation');
  }
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) throw new Error('invalid_disk_requirement');
  const disk = fs.statfsSync(settings.userHome);
  if (disk.bavail * disk.bsize < minimumFreeBytes) throw new Error('insufficient_target_disk');
  const database = path.join(settings.dataRoot, 'v2.db');
  if (fs.realpathSync(database) !== database || !fs.lstatSync(database).isFile())
    throw new Error('unsafe_target_installation');
}
export async function checkedTargetDatabase(settings: DeploymentSettings, login: 'runtime' | 'migration' = 'runtime') {
  const env = readTargetDatabaseEnvironment(settings, login),
    client = await connectChecked(env, 'runtime', login);
  try {
    if (
      (await databaseFingerprint(client, parseDatabaseConfig(env, 'runtime', login))) !== settings.databaseFingerprint
    )
      throw new Error('wrong_target_database');
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}
/** Inventory every existing provider/package profile, including session-specific provider overrides. */
export function verifyInstalledProfiles(settings: DeploymentSettings, manifest: ReleaseManifest): void {
  const db = new Database(path.join(settings.dataRoot, 'v2.db'), { readonly: true, fileMustExist: true });
  try {
    const groups = db.prepare('SELECT id,folder,agent_provider FROM agent_groups').all() as Array<{
      id: string;
      folder: string;
      agent_provider: string | null;
    }>;
    for (const group of groups) {
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(group.folder)) throw new Error('unsafe_installed_group');
      const folder = path.join(settings.installationRoot, 'groups', group.folder),
        file = path.join(folder, 'container.json');
      let config: { provider?: string; packages?: { apt?: string[]; npm?: string[] } } = {};
      if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file);
        if (fs.realpathSync(file) !== file || !stat.isFile() || stat.size > 1048576)
          throw new Error('unsafe_installed_group');
        config = JSON.parse(fs.readFileSync(file, 'utf8'));
      }
      const sessions = db
        .prepare("SELECT DISTINCT agent_provider FROM sessions WHERE agent_group_id=? AND status='active'")
        .all(group.id) as Array<{ agent_provider: string | null }>;
      const providers = new Set([
        group.agent_provider || config.provider || 'claude',
        ...sessions.map((row) => row.agent_provider || group.agent_provider || config.provider || 'claude'),
      ]);
      for (const provider of providers) {
        const profile = imageProfile(provider, { apt: config.packages?.apt ?? [], npm: config.packages?.npm ?? [] });
        if (!manifest.images.some((image) => image.role === 'agent' && image.profile === profile))
          throw new Error('installed_profile_unavailable');
      }
    }
  } finally {
    db.close();
  }
}
