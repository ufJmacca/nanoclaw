import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { digest } from '../domain/contracts.js';
import { deploymentSettings, shellArgument, type DeploymentSettings } from './deployment-settings.js';
import { validateTargetObservation } from './mac-deploy.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { RUNTIME_ENVIRONMENT_KEYS, selectRuntimeEnvironment } from './mac-release.js';
import { readEnvFile } from '../../../env.js';
import { safeHostEnvironment } from '../../../host-environment.js';
import { validateRuntimeFixtureRequest } from '../../../contracts/chief-of-staff/runtime-fixture-driver.js';

export function runtimeFixtureTarget(settings: DeploymentSettings, observation: unknown, owner: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(owner)) throw new Error('invalid_runtime_fixture_owner');
  const state = validateTargetObservation(settings, observation);
  if (!state?.releaseId || state.lifecycle !== 'implementation_disposable')
    throw new Error('runtime_fixture_installed_disposable_target_required');
  const payload = path.join(settings.releaseRoot, state.releaseId, 'payload');
  return {
    bindingDigest: digest(state.binding),
    command: [
      payload + '/node/bin/node',
      payload + '/dist/modules/chief-of-staff/ops/target-helper.js',
      'runtime-test',
      '--settings',
      path.join(settings.stagingRoot, state.releaseId, 'target.json'),
      '--owner',
      owner,
    ]
      .map(shellArgument)
      .join(' '),
  };
}

export function macRuntimeFixtureCommand(args: string[]): string | void {
  const [operation, owner, ...values] = args;
  if (operation === 'certificate' && args.length === 1) {
    const file = readEnvFile(['COS_PGSSLROOTCERT']).COS_PGSSLROOTCERT;
    if (!file || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw new Error('runtime_certificate_required');
    return file;
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(owner ?? '')) throw new Error('invalid_runtime_fixture_owner');
  const root = path.resolve('.cos-plan-state/runtime-tests', owner),
    stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    fs.realpathSync(root) !== root ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_runtime_fixture_directory');
  const settings = deploymentSettings(readPrivate(path.resolve('.cos-plan-state/deployment-target.json')));
  const target = runtimeFixtureTarget(settings, readPrivate(path.join(root, 'target-observation.json')), owner);
  if (operation === 'command' && !values.length) return target.command;
  if (operation !== 'prepare' || values.length !== 6) throw new Error('invalid_runtime_fixture_command');
  const [execution, mode, hostRoot, hostImage, workerImage, runnerVolume] = values;
  const git = (args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', env: safeHostEnvironment('docker') }).trim();
  if (git(['status', '--porcelain'])) throw new Error('clean_candidate_required');
  const request = validateRuntimeFixtureRequest({
    version: 1,
    owner,
    execution,
    mode,
    hostRoot,
    hostImage,
    workerImage,
    runnerVolume,
    sourceCommit: git(['rev-parse', 'HEAD']),
    sourceTree: git(['rev-parse', 'HEAD^{tree}']),
    databaseFingerprint: settings.databaseFingerprint,
    bindingDigest: target.bindingDigest,
  });
  const requestFile = path.join(root, 'request.json');
  if (fs.existsSync(requestFile) && digest(readPrivate(requestFile)) !== digest(request))
    throw new Error('runtime_fixture_request_conflict');
  // JSON preserves literal credentials. Only this chosen profile is made available to the trusted fixture driver.
  const selected = selectRuntimeEnvironment(readEnvFile(RUNTIME_ENVIRONMENT_KEYS), path.join(root, 'ca.pem'));
  writeAtomic(root, 'runtime.json', selected);
  writeAtomic(root, 'request.json', request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = macRuntimeFixtureCommand(process.argv.slice(2));
    if (result !== undefined) process.stdout.write(result + '\n');
  } catch {
    process.stderr.write('{"status":"blocked","code":"runtime_fixture_setup_failed"}\n');
    process.exitCode = 1;
  }
}
