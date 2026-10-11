import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { artifactHash } from './release-artifacts.js';
import { writeAtomic } from './target-state.js';
import { macDeployCommand } from './mac-deploy-cli.js';

const cwd = process.cwd(),
  roots: string[] = [];
afterEach(() => {
  process.chdir(cwd);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-g02-delivery-admission-'));
  roots.push(root);
  process.chdir(root);
  const state = path.join(root, '.cos-plan-state');
  const manifest = { ...fixtureVaultRelease('G02'), releaseId: 'release-aaaaaaaaaaaa-20261011000000' };
  const archive = path.join(state, 'releases', manifest.releaseId);
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
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
  const original = {
    active_slice: 'S11',
    programme_complete: true,
    actual_goal_tool_completion: { status: 'complete' },
    slices: [
      {
        id: 'S11',
        implementation_status: 'merged',
        review_status: 'human_merged',
        merged_sha: 'b'.repeat(40),
        deployed_source_sha: 'b'.repeat(40),
        merged_source_delivery_status: 'passed',
        pi_smoke_status: 'passed',
      },
    ],
    unknown: { valuableOriginalHistory: true },
  };
  const commit = 'c'.repeat(40),
    tree = 'd'.repeat(40),
    releaseId = 'release-reviewed-g01';
  const predecessor = {
    status: 'complete',
    review: { status: 'human_review_and_merge_verified', reviewed: true, merged: true, mergeCommit: commit },
    current_source: { commit, tree, releaseId },
    deployed_source_sha: commit,
    pi_smoke_status: 'passed',
    merged_release_reconciliation: {
      status: 'passed',
      commit,
      tree,
      releaseId,
      humanReview: 'verified',
      allMandatoryGates: 'passed',
      actualPiAcceptance: 'passed',
    },
    unknown: { valuablePredecessorHistory: true },
  };
  const extension = {
    contract: 'cos-google-mail-storage-execution/v1',
    goal: 'nanoclaw-google-mail-storage',
    plan_revision: 1,
    published_specification_commit: 'e'.repeat(40),
    active_slice: 'G02',
    status: 'in_progress',
    slices: { G01: predecessor, G02: { status: 'in_progress', depends_on: 'G01', unknown: 'preserve' } },
    unknown: { valuableExtensionHistory: true },
  };
  writeAtomic(state, 'deployment-target.json', settings);
  writeAtomic(state, 'execution.json', original);
  writeAtomic(state, 'google-mail-storage-execution.json', extension);
  writeAtomic(archive, 'release.json', manifest);
  writeAtomic(archive, 'plan.json', { targetDigest: digest(settings) });
  writeAtomic(archive, 'local-tests.json', {
    status: 'transferable',
    manifestHash: await artifactHash(path.join(archive, 'release.json')),
    source: manifest.source,
    checks: manifest.checks,
  });
  writeAtomic(archive, 'delivery.json', { status: 'verified_locally', unknown: 'preserve' });
  return { state, archive, manifest, original, extension };
}

it('G02 generates delivery commands only with reviewed matching predecessor acceptance', async () => {
  const f = await fixture();
  await expect(macDeployCommand(['field', f.manifest.releaseId, 'commit'])).resolves.toBe(f.manifest.source.commit);
  await expect(macDeployCommand(['deploy-command', f.manifest.releaseId])).resolves.toContain("'deploy'");
  expect(JSON.parse(fs.readFileSync(path.join(f.state, 'execution.json'), 'utf8'))).toEqual(f.original);
  expect(JSON.parse(fs.readFileSync(path.join(f.state, 'google-mail-storage-execution.json'), 'utf8'))).toEqual(
    f.extension,
  );
});

it.each([
  'missing-ledger',
  'wrong-active-slice',
  'review-withdrawn',
  'predecessor-source-mismatch',
  'original-incomplete',
] as const)('G02 refuses %s before emitting a command or changing delivery state', async (failure) => {
  const f = await fixture();
  if (failure === 'missing-ledger') fs.unlinkSync(path.join(f.state, 'google-mail-storage-execution.json'));
  if (failure === 'wrong-active-slice') f.extension.active_slice = 'G01';
  if (failure === 'review-withdrawn') f.extension.slices.G01.review.reviewed = false;
  if (failure === 'predecessor-source-mismatch')
    f.extension.slices.G01.merged_release_reconciliation.commit = 'f'.repeat(40);
  if (failure === 'original-incomplete') f.original.programme_complete = false;
  if (failure !== 'missing-ledger') writeAtomic(f.state, 'google-mail-storage-execution.json', f.extension);
  writeAtomic(f.state, 'execution.json', f.original);
  const originalBefore = fs.readFileSync(path.join(f.state, 'execution.json'));
  const deliveryBefore = fs.readFileSync(path.join(f.archive, 'delivery.json'));
  await expect(macDeployCommand(['deploy-command', f.manifest.releaseId])).rejects.toThrow();
  await expect(macDeployCommand(['checkpoint', f.manifest.releaseId, 'source_pushed'])).rejects.toThrow();
  expect(fs.readFileSync(path.join(f.archive, 'delivery.json'))).toEqual(deliveryBefore);
  expect(fs.readFileSync(path.join(f.state, 'execution.json'))).toEqual(originalBefore);
});

it('G02 delivery checkpoints preserve completed history and update only its own extension slice', async () => {
  const f = await fixture();
  const originalBefore = fs.readFileSync(path.join(f.state, 'execution.json'));
  await expect(macDeployCommand(['checkpoint', f.manifest.releaseId, 'source_pushed'])).resolves.toBeUndefined();
  const saved = JSON.parse(fs.readFileSync(path.join(f.state, 'google-mail-storage-execution.json'), 'utf8'));
  expect(saved.slices.G01).toEqual(f.extension.slices.G01);
  expect(saved.unknown).toEqual(f.extension.unknown);
  expect(saved.slices.G02).toMatchObject({
    ...f.extension.slices.G02,
    delivery_phase: 'source_pushed',
    source_push_status: 'verified',
  });
  expect(fs.readFileSync(path.join(f.state, 'execution.json'))).toEqual(originalBefore);
});
