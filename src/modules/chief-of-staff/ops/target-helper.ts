import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deploymentSettings } from './deployment-settings.js';
import { readPrivate, readTarget, initializeTarget } from './target-state.js';
import { withDeploymentLock } from './deployment-lock.js';
import type { BindingRequest } from './bind.js';

type TargetArguments =
  | { command: 'status'; settings: string }
  | { command: 'deploy'; settings: string; releaseId: string; manifestHash: string; binding?: string };
export function parseTargetArguments(args: string[]): TargetArguments {
  const reject = (): never => {
    throw new Error('invalid_target_arguments');
  };
  const [command, ...rest] = args;
  if (!['status', 'deploy'].includes(command) || rest.length % 2 !== 0) return reject();
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (
      !['--settings', '--release-id', '--manifest-sha256', '--binding'].includes(rest[i]) ||
      !rest[i + 1] ||
      values[rest[i]]
    )
      return reject();
    values[rest[i]] = rest[i + 1];
  }
  const canonical = (value: string | undefined) =>
    !!value && /^\/[a-zA-Z0-9_./-]+$/.test(value) && path.resolve(value) === value;
  if (!canonical(values['--settings']) || (values['--binding'] !== undefined && !canonical(values['--binding'])))
    return reject();
  if (command === 'status')
    return Object.keys(values).length === 1 ? { command, settings: values['--settings'] } : reject();
  if (
    !/^release-[a-zA-Z0-9_-]{1,120}$/.test(values['--release-id'] ?? '') ||
    !/^[a-f0-9]{64}$/.test(values['--manifest-sha256'] ?? '')
  )
    return reject();
  return {
    command: 'deploy',
    settings: values['--settings'],
    releaseId: values['--release-id'],
    manifestHash: values['--manifest-sha256'],
    ...(values['--binding'] ? { binding: values['--binding'] } : {}),
  };
}
function privateBinding(file: string): BindingRequest {
  const value = readPrivate<BindingRequest>(file),
    keys = ['scopeId', 'instanceId', 'channelId', 'ownerId', 'botId', 'provider'];
  if (
    !value ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.provider !== 'codex' ||
    keys.some(
      (key) =>
        typeof value[key as keyof BindingRequest] !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(value[key as keyof BindingRequest]),
    )
  )
    throw new Error('invalid_coordinator_binding');
  return value;
}
export async function targetCommand(args: string[]): Promise<Record<string, unknown>> {
  const request = parseTargetArguments(args),
    settings = deploymentSettings(readPrivate(request.settings));
  process.chdir(settings.installationRoot);
  // Import runtime modules only after cwd is fixed; native data roots are resolved at import time.
  const { targetBinding, targetCommands, verifyTargetPaths, checkedTargetDatabase } = await import('./target-host.js');
  verifyTargetPaths(settings, 0);
  const binding = targetBinding(settings);
  const parent = path.dirname(settings.stateRoot);
  if (!fs.existsSync(parent)) throw new Error('target_state_parent_required');
  return withDeploymentLock(settings.stateRoot + '.operation.lock', async () => {
    if (request.command === 'status') {
      const service = await targetCommands(settings).observe();
      if (!fs.lstatSync(settings.stateRoot, { throwIfNoEntry: false }))
        return { status: 'unbound', service: service.activeState };
      const state = readTarget(settings.stateRoot, binding);
      const check = await checkedTargetDatabase(settings);
      let version: number;
      try {
        const { migrationStatus } = await import('../store/migrations.js');
        version = await migrationStatus(check);
      } finally {
        await check.end();
      }
      return {
        status: 'bound',
        service: service.activeState,
        releaseId: state.releaseId,
        lifecycle: state.lifecycle,
        maintenance: state.maintenance,
        leaseActive: !!state.maintenanceId,
        schemaVersion: version,
        modelActivation: 'not_verified',
      };
    }
    const { verifyReleaseBundle } = await import('./release-artifacts.js');
    const bundle = await verifyReleaseBundle(path.join(settings.stagingRoot, request.releaseId), request.manifestHash);
    if (bundle.manifest.releaseId !== request.releaseId) throw new Error('release_identity_mismatch');
    const { createTargetEffects } = await import('./target-effects.js');
    const effects = createTargetEffects(
      settings,
      bundle.manifest,
      request.manifestHash,
      request.binding ? privateBinding(request.binding) : undefined,
    );
    await effects.verify();
    initializeTarget(settings.stateRoot, binding);
    const { deployRelease } = await import('./deployment.js');
    const receipt = await deployRelease({ root: settings.stateRoot, binding, manifest: bundle.manifest, effects });
    return {
      status: receipt.status,
      releaseId: receipt.releaseId,
      sourceCommit: bundle.manifest.source.commit,
      sourceTree: bundle.manifest.source.tree,
      completed: receipt.completed,
      updatedAt: receipt.updatedAt,
      modelActivation: 'not_configured_by_deployment',
    };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  targetCommand(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      const safe = new Set([
        'invalid_target_arguments',
        'target_deployment_locked',
        'deployment_verification_failed',
        'deployment_incomplete',
        'deployment_reconciliation_required',
        'deployment_health_failed',
        'deployment_rolled_back',
        'target_state_parent_required',
        'release_not_transferable',
        'release_identity_mismatch',
        'wrong_deployment_target',
        'unsafe_target_credentials',
      ]);
      console.error(
        JSON.stringify({
          status: 'unavailable',
          code: error instanceof Error && safe.has(error.message) ? error.message : 'target_operation_failed',
        }),
      );
      process.exitCode = 1;
    });
}
