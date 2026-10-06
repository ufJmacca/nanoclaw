import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { artifactHash } from './release-artifacts.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { macDeployCommand } from './mac-deploy-cli.js';

const cwd = process.cwd(),
  roots: string[] = [];
afterEach(() => {
  process.chdir(cwd);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mac-protected-release-'));
  roots.push(root);
  process.chdir(root);
  const manifest = { ...fixtureRelease('S11'), releaseId: 'release-aaaaaaaaaaaa-20261006000000' };
  const settings = {
    version: 1,
    target: 'pi',
    sshAlias: 'fixture-pi',
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
    service: 'nano.service',
    userHome: '/home/fixture',
    installationRoot: '/home/fixture/nano',
    dataRoot: '/home/fixture/nano/data',
    stateRoot: '/home/fixture/state',
    releaseRoot: '/home/fixture/releases',
    stagingRoot: '/home/fixture/staging',
    sourceRoot: '/home/fixture/source',
    runtimeEnvironment: '/home/fixture/.config/runtime.env',
    migrationEnvironment: '/home/fixture/.config/migration.env',
  };
  const binding = {
    hostFingerprint: settings.hostFingerprint,
    databaseFingerprint: settings.databaseFingerprint,
    service: settings.service,
    installationRoot: settings.installationRoot,
    dataRoot: settings.dataRoot,
  };
  const state = path.join(root, '.cos-plan-state'),
    archive = path.join(state, 'releases', manifest.releaseId),
    closure = path.join(state, 'programme-protection', manifest.releaseId);
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  fs.mkdirSync(closure, { recursive: true, mode: 0o700 });
  writeAtomic(state, 'deployment-target.json', settings);
  writeAtomic(archive, 'release.json', manifest);
  const hash = await artifactHash(path.join(archive, 'release.json'));
  writeAtomic(archive, 'local-tests.json', {
    status: 'transferable',
    manifestHash: hash,
    source: manifest.source,
    checks: manifest.checks,
  });
  writeAtomic(archive, 'plan.json', { targetDigest: digest(settings) });
  const observation = {
    fingerprint: settings.hostFingerprint,
    platform: 'linux',
    architecture: 'arm64',
    dockerArchitecture: 'aarch64',
    dockerOS: 'linux',
    service: 'active',
    cwd: settings.installationRoot,
    state: {
      version: 1,
      binding,
      lifecycle: 'protected',
      maintenance: true,
      generation: 4,
      releaseId: manifest.releaseId,
    },
  };
  writeAtomic(archive, 'target-observation.json', observation);
  const completionDigest = '3'.repeat(64),
    verified = {
      status: 'protected',
      completionDigest,
      bindingDigest: digest(binding),
      source: manifest.source,
    },
    sealed = {
      status: 'protected',
      testedHelperReleaseId: manifest.releaseId,
      targetReleaseId: manifest.releaseId,
      completionDigest,
      bindingDigest: digest(binding),
      sourceCommit: manifest.source.commit,
      sourceTree: manifest.source.tree,
    },
    result = {
      status: 'healthy',
      releaseId: manifest.releaseId,
      sourceCommit: manifest.source.commit,
      sourceTree: manifest.source.tree,
      lifecycle: 'protected',
      completionDigest,
      cosResumed: false,
      accountActivation: 'not_granted_by_protected_release',
    };
  writeAtomic(closure, 'verified.json', verified);
  writeAtomic(closure, 'target-result.json', sealed);
  writeAtomic(archive, 'protected-release-result.json', result);
  const priorDelivery = { status: 'healthy', source: manifest.source, healthy: '2026-10-06T01:00:00Z', retained: true };
  writeAtomic(archive, 'delivery.json', priorDelivery);
  const ledger = {
    active_slice: 'S11',
    preserved: { operatorRating: 'useful_with_limitations' },
    slices: [
      {
        id: 'S10',
        implementation_status: 'merged',
        review_status: 'human_merged',
        merged_sha: '4'.repeat(40),
        deployed_source_sha: '4'.repeat(40),
        merged_source_delivery_status: 'passed',
        pi_smoke_status: 'passed',
      },
      { id: 'S11', implementation_status: 'merged', deployment_receipt: 'original-deployment.json' },
    ],
  };
  writeAtomic(state, 'execution.json', ledger);
  return { state, archive, closure, manifest, hash, observation, verified, sealed, result, priorDelivery, ledger };
}

it('selects only the already delivered final helper and records final health separately from its deployment receipt', async () => {
  const f = await fixture();
  const command = await macDeployCommand(['protected-release-command', f.manifest.releaseId]);
  expect(command).toContain('/home/fixture/releases/' + f.manifest.releaseId + '/payload/node/bin/node');
  expect(command).toContain("'protected-release'");
  expect(command).toContain(f.hash);
  expect(command).not.toMatch(/git|scp|migration|COS_PG|docker build/);
  await expect(macDeployCommand(['protected-release-check', f.manifest.releaseId])).resolves.toBeUndefined();
  expect(readPrivate(path.join(f.archive, 'delivery.json'))).toMatchObject({
    ...f.priorDelivery,
    status: 'protected_current_release_healthy',
  });
  expect(readPrivate(path.join(f.state, 'execution.json'))).toMatchObject({
    preserved: f.ledger.preserved,
    slices: [
      f.ledger.slices[0],
      {
        id: 'S11',
        deployment_receipt: 'original-deployment.json',
        protected_finalization_receipt:
          '.cos-plan-state/releases/' + f.manifest.releaseId + '/protected-release-result.json',
      },
    ],
  });
});

it('leaves a new release or an interrupted deployment with a retained older helper on the normal deployment path', async () => {
  const f = await fixture();
  writeAtomic(f.closure, 'target-result.json', { ...f.sealed, testedHelperReleaseId: 'release-retained-older' });
  await expect(macDeployCommand(['protected-release-command', f.manifest.releaseId])).resolves.toBe('');
  writeAtomic(f.closure, 'target-result.json', f.sealed);
  writeAtomic(f.archive, 'target-observation.json', {
    ...f.observation,
    state: { ...f.observation.state, releaseId: 'release-prior' },
  });
  await expect(macDeployCommand(['protected-release-command', f.manifest.releaseId])).resolves.toBe('');
});

it.each(['binding', 'status', 'missing-completion', 'source', 'cos-resumed'] as const)(
  'refuses %s evidence before changing the delivery or ledger',
  async (failure) => {
    const f = await fixture();
    const verified = { ...f.verified },
      result = { ...f.result };
    if (failure === 'binding') verified.bindingDigest = '9'.repeat(64);
    if (failure === 'status') verified.status = 'pending';
    if (failure === 'missing-completion') {
      Reflect.deleteProperty(verified, 'completionDigest');
      Reflect.deleteProperty(result, 'completionDigest');
    }
    if (failure === 'source') verified.source = { ...verified.source, tree: '9'.repeat(40) };
    if (failure === 'cos-resumed') result.cosResumed = true;
    writeAtomic(f.closure, 'verified.json', verified);
    writeAtomic(f.archive, 'protected-release-result.json', result);
    await expect(macDeployCommand(['protected-release-check', f.manifest.releaseId])).rejects.toThrow(
      'protected_release_unverified',
    );
    expect(readPrivate(path.join(f.archive, 'delivery.json'))).toEqual(f.priorDelivery);
    expect(readPrivate(path.join(f.state, 'execution.json'))).toEqual(f.ledger);
  },
);
