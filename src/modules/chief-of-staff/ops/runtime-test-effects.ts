import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getInstallSlug } from '../../../install-slug.js';
import { readReleaseAt } from '../../../release-runtime.js';
import { digest } from '../domain/contracts.js';
import { migrationStatus } from '../store/migrations.js';
import { readPrivate, readTarget } from './target-state.js';
import { maintenanceLeaseForOwner } from './maintenance.js';
import {
  targetBinding,
  targetCommands,
  verifyTargetPaths,
  checkedTargetDatabase,
  verifyInstalledProfiles,
} from './target-host.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { verifyLoadedImages } from './release-artifacts.js';
import { payloadDigest } from './payload.js';
import type { DeploymentSettings } from './deployment-settings.js';
import type { RuntimeTestEffects } from './runtime-test-session.js';

type Container = {
  Id: string;
  Name: string;
  State: { Running: boolean };
  Config: { Labels: Record<string, string>; Env: string[] };
};
export function runtimeTestSchemaCompatible(manifest: ReleaseManifest | undefined, version: number): boolean {
  return (
    !!manifest &&
    Number.isSafeInteger(version) &&
    version >= manifest.postgres.minimum &&
    version <= manifest.postgres.maximum
  );
}
export function selectCosTestContainers(values: Container[], installation: string): string[] {
  const selected: string[] = [];
  for (const value of values) {
    if (
      !value ||
      !/^[a-f0-9]{64}$/.test(value.Id) ||
      value.Config?.Labels?.['nanoclaw-install'] !== installation ||
      !Array.isArray(value.Config.Env)
    )
      throw new Error('unexpected_owned_container');
    const marker = value.Config.Labels['nanoclaw.cos-protocol'],
      protocol = value.Config.Env.includes('NANOCLAW_COS_PROTOCOL=cos-rpc/v1');
    if (marker !== undefined || protocol) {
      if (marker !== 'cos-rpc/v1' || !protocol || !value.Name.startsWith('/nanoclaw-cos-'))
        throw new Error('unexpected_owned_container');
      if (value.State.Running) selected.push(value.Id);
    }
  }
  return selected;
}
/** Operates only CoS workers and database fences. The ordinary host service remains running. */
export function createRuntimeTestEffects(settings: DeploymentSettings, owner: string): RuntimeTestEffects {
  const binding = targetBinding(settings),
    commands = targetCommands(settings);
  let manifest: ReleaseManifest | undefined;
  const ownLease = () => maintenanceLeaseForOwner(settings.stateRoot, binding, owner, 'runtime-disposable');
  const containers = async () => {
    const inspected: Container[] = [];
    for (const id of await commands.ownedContainers()) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('unexpected_owned_container');
      const rows = JSON.parse(await commands.docker(['container', 'inspect', id]));
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('unexpected_owned_container');
      inspected.push(rows[0]);
    }
    return selectCosTestContainers(inspected, getInstallSlug(settings.installationRoot));
  };
  const ordinaryHost = async () => {
    if (!manifest || readTarget(settings.stateRoot, binding).releaseId !== manifest.releaseId)
      throw new Error('runtime_release_changed');
    const observed = await commands.observe(),
      payload = path.join(settings.releaseRoot, manifest.releaseId, 'payload');
    if (
      observed.activeState !== 'active' ||
      observed.subState !== 'running' ||
      observed.pid <= 0 ||
      observed.cwd !== settings.installationRoot
    )
      throw new Error('ordinary_host_unhealthy');
    const processRoot = '/proc/' + observed.pid,
      args = fs
        .readFileSync(processRoot + '/cmdline', 'utf8')
        .split('\0')
        .filter(Boolean);
    if (
      fs.statSync(processRoot).uid !== process.getuid?.() ||
      fs.readlinkSync(processRoot + '/cwd') !== settings.installationRoot ||
      fs.readlinkSync(processRoot + '/exe') !== payload + '/node/bin/node' ||
      args.length !== 2 ||
      args[1] !== payload + '/dist/index.js'
    )
      throw new Error('ordinary_host_unhealthy');
    const db = new Database(path.join(settings.dataRoot, 'v2.db'), { readonly: true, fileMustExist: true });
    try {
      const lease = db.prepare('SELECT pid FROM host_execution_lease WHERE singleton_id=1').get() as
        | { pid: number }
        | undefined;
      if (lease?.pid !== observed.pid) throw new Error('ordinary_host_unhealthy');
    } finally {
      db.close();
    }
  };
  return {
    async verify() {
      verifyTargetPaths(settings, 0);
      const state = readTarget(settings.stateRoot, binding);
      if (!state.releaseId) throw new Error('installed_runtime_test_helper_required');
      const directory = path.join(settings.releaseRoot, state.releaseId),
        file = path.join(directory, 'release.json');
      manifest = validateReleaseManifest(readPrivate(file));
      const receipt = readPrivate<{ status: string; manifestDigest: string }>(
        path.join(settings.stateRoot, 'releases', state.releaseId, 'deployment.json'),
      );
      if (
        manifest.releaseId !== state.releaseId ||
        receipt.status !== 'healthy' ||
        receipt.manifestDigest !== digest(manifest)
      )
        throw new Error('unverified_runtime_release');
      readReleaseAt(path.join(directory, 'payload'), file);
      if ((await payloadDigest(path.join(directory, 'payload'))) !== manifest.hostPayloadDigest)
        throw new Error('release_payload_mismatch');
      verifyInstalledProfiles(settings, manifest);
      await verifyLoadedImages(manifest, commands.inspect);
      await ordinaryHost();
      const client = await checkedTargetDatabase(settings);
      try {
        if (!runtimeTestSchemaCompatible(manifest, await migrationStatus(client)))
          throw new Error('schema_incompatible');
      } finally {
        await client.end();
      }
    },
    async quiesce() {
      ownLease();
      await ordinaryHost();
      for (const id of await containers()) await commands.docker(['stop', '--time', '10', id]);
      const client = await checkedTargetDatabase(settings);
      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          ownLease();
          const activeCoordinators = (await containers()).length;
          if (
            !activeCoordinators &&
            (await client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked
          )
            return { activeCoordinators: 0, activeDatabaseOperations: 0 };
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return { activeCoordinators: (await containers()).length, activeDatabaseOperations: 1 };
      } finally {
        await client.end();
      }
    },
    async compatible() {
      ownLease();
      await ordinaryHost();
      if ((await containers()).length) return false;
      const client = await checkedTargetDatabase(settings);
      try {
        return (
          (await client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked === true &&
          runtimeTestSchemaCompatible(manifest, await migrationStatus(client))
        );
      } finally {
        await client.end();
      }
    },
  };
}
