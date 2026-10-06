import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { deploymentSettings } from './deployment-settings.js';
import { readPrivate, readTarget, initializeTarget } from './target-state.js';
import { withDeploymentLock } from './deployment-lock.js';
import type { BindingRequest } from './bind.js';

type TargetArguments =
  | { command: 'status'; settings: string }
  | { command: 'programme-protect'; settings: string; completion: string }
  | { command: 'operations-maintenance'; settings: string; requestId: string; phase: 'hold' | 'release' }
  | { command: 'runtime-test'; settings: string; owner: string }
  | { command: 'rollback'; settings: string; releaseId: string; fromReleaseId: string }
  | {
      command: 'deploy';
      settings: string;
      releaseId: string;
      manifestHash: string;
      binding?: string;
      recoverFrom?: string;
    };
export function parseTargetArguments(args: string[]): TargetArguments {
  const reject = (): never => {
    throw new Error('invalid_target_arguments');
  };
  const [command, ...rest] = args;
  if (
    !['status', 'deploy', 'rollback', 'runtime-test', 'programme-protect', 'operations-maintenance'].includes(
      command,
    ) ||
    rest.length % 2 !== 0
  )
    return reject();
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (
      ![
        '--settings',
        '--release-id',
        '--manifest-sha256',
        '--binding',
        '--from-release-id',
        '--owner',
        '--recover-from',
        '--completion',
        '--request-id',
        '--phase',
      ].includes(rest[i]) ||
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
  if (command === 'programme-protect')
    return Object.keys(values).length === 2 && canonical(values['--completion'])
      ? { command, settings: values['--settings'], completion: values['--completion'] }
      : reject();
  if (command === 'operations-maintenance')
    return Object.keys(values).length === 3 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values['--request-id'] ?? '') &&
      ['hold', 'release'].includes(values['--phase'])
      ? {
          command,
          settings: values['--settings'],
          requestId: values['--request-id'],
          phase: values['--phase'] as 'hold' | 'release',
        }
      : reject();
  if (values['--completion'] || values['--request-id'] || values['--phase']) return reject();
  if (command === 'status')
    return Object.keys(values).length === 1 ? { command, settings: values['--settings'] } : reject();
  if (command === 'runtime-test') {
    if (Object.keys(values).length !== 2 || !/^[a-zA-Z0-9_-]{1,120}$/.test(values['--owner'] ?? '')) return reject();
    return { command, settings: values['--settings'], owner: values['--owner'] };
  }
  if (command === 'rollback') {
    if (
      Object.keys(values).length !== 3 ||
      !/^release-[a-zA-Z0-9_-]{1,120}$/.test(values['--release-id'] ?? '') ||
      !/^release-[a-zA-Z0-9_-]{1,120}$/.test(values['--from-release-id'] ?? '')
    )
      return reject();
    return {
      command,
      settings: values['--settings'],
      releaseId: values['--release-id'],
      fromReleaseId: values['--from-release-id'],
    };
  }
  if (values['--from-release-id'] || values['--owner']) return reject();
  if (
    values['--recover-from'] !== undefined &&
    (!/^release-[a-zA-Z0-9_-]{1,120}$/.test(values['--recover-from']) ||
      values['--recover-from'] === values['--release-id'])
  )
    return reject();
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
    ...(values['--recover-from'] ? { recoverFrom: values['--recover-from'] } : {}),
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
    if (request.command === 'operations-maintenance') {
      const { operationsMaintenance } = await import('./operations-maintenance.js');
      const { createOperationsMaintenanceEffects } = await import('./operations-maintenance-effects.js');
      return operationsMaintenance({
        root: settings.stateRoot,
        binding,
        requestId: request.requestId,
        phase: request.phase,
        effects: createOperationsMaintenanceEffects(settings, fileURLToPath(import.meta.url)),
      });
    }
    if (request.command === 'programme-protect') {
      const { protectCompletedProgramme, validateProgrammeProtection, verifyProtectionHelper } =
        await import('./programme-protection.js');
      const { digest } = await import('../domain/contracts.js');
      const proof = validateProgrammeProtection(readPrivate(request.completion));
      await verifyProtectionHelper(settings, binding, fileURLToPath(import.meta.url));
      const state = protectCompletedProgramme(settings.stateRoot, binding, proof);
      return {
        status: 'protected',
        lifecycle: state.lifecycle,
        maintenance: state.maintenance,
        bindingDigest: digest(binding),
        completionDigest: digest(proof),
        sourceCommit: proof.releaseManifest.source.commit,
        sourceTree: proof.releaseManifest.source.tree,
        accountActivation: 'not_granted_by_protection',
      };
    }
    if (request.command === 'runtime-test') {
      const { serveRuntimeTestSession } = await import('./runtime-test-session.js');
      const { createRuntimeTestEffects } = await import('./runtime-test-effects.js');
      const { runtimeTestMessages, writeRuntimeTestMessage } = await import('./runtime-test-wire.js');
      await serveRuntimeTestSession({
        root: settings.stateRoot,
        binding,
        owner: request.owner,
        effects: createRuntimeTestEffects(settings, request.owner),
        input: runtimeTestMessages(process.stdin),
        send: (message) => writeRuntimeTestMessage(process.stdout, message),
      });
      return { status: 'session_closed' };
    }
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
    if (request.command === 'rollback') {
      const { artifactHash } = await import('./release-artifacts.js');
      const { validateReleaseManifest } = await import('./release-manifest.js');
      const { digest } = await import('../domain/contracts.js');
      const { createTargetEffects } = await import('./target-effects.js');
      const { rollbackRelease } = await import('./rollback.js');
      const manifestFile = path.join(settings.releaseRoot, request.fromReleaseId, 'release.json');
      const manifest = validateReleaseManifest(readPrivate(manifestFile));
      const receiptRoot = path.join(settings.stateRoot, 'releases', request.fromReleaseId);
      const deployed = readPrivate<{ status: string; manifestDigest: string; previousReleaseId: string | null }>(
        path.join(receiptRoot, 'deployment.json'),
      );
      if (
        manifest.releaseId !== request.fromReleaseId ||
        deployed.status !== 'healthy' ||
        deployed.manifestDigest !== digest(manifest) ||
        deployed.previousReleaseId !== request.releaseId
      )
        throw new Error('rollback_not_compatible');
      const bindingFile = path.join(receiptRoot, 'binding-setup.json');
      const effects = createTargetEffects(
        settings,
        manifest,
        await artifactHash(manifestFile),
        fs.existsSync(bindingFile) ? privateBinding(bindingFile) : undefined,
      );
      return rollbackRelease({
        root: settings.stateRoot,
        binding,
        manifest,
        effects,
        previousReleaseId: request.releaseId,
      });
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
    const receipt = await deployRelease({
      root: settings.stateRoot,
      binding,
      manifest: bundle.manifest,
      effects,
      recoverFrom: request.recoverFrom,
    });
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
  process.env.NANOCLAW_LOG_STDERR = 'true';
  targetCommand(process.argv.slice(2))
    .then((result) => {
      if (result.status !== 'session_closed') console.log(JSON.stringify(result));
    })
    .catch((error) => {
      const safe = new Set([
        'invalid_target_arguments',
        'target_deployment_locked',
        'deployment_verification_failed',
        'deployment_recovery_denied',
        'deployment_superseded',
        'deployment_incomplete',
        'deployment_reconciliation_required',
        'deployment_health_failed',
        'deployment_rolled_back',
        'target_state_parent_required',
        'release_not_transferable',
        'release_identity_mismatch',
        'wrong_deployment_target',
        'unsafe_target_credentials',
        'rollback_not_compatible',
        'operator_denial_release_required',
        'rollback_unverified',
        'rollback_receipt_conflict',
        'rollback_source_changed',
        'protected_target',
        'maintenance_owned',
        'runtime_test_history_conflict',
        'runtime_test_protocol_invalid',
        'installed_runtime_test_helper_required',
        'programme_completion_unverified',
        'target_protection_conflict',
        'operations_maintenance_unverified',
        'operations_workers_active',
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
