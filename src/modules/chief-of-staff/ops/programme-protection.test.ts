import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { initializeTarget, readTarget, readPrivate, writeAtomic } from './target-state.js';
import { beginMaintenance, assertMaintenanceLease, confirmQuiescence } from './maintenance.js';
import {
  completionReferences,
  makeProgrammeProtection,
  protectCompletedProgramme,
  verifyProtectionHelper,
} from './programme-protection.js';
import { payloadDigest } from './payload.js';
import { macProgrammeCommand } from './mac-programme-cli.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const binding = {
  hostFingerprint: 'a'.repeat(64),
  databaseFingerprint: 'b'.repeat(64),
  service: 'fixture.service',
  installationRoot: '/home/pi/install',
  dataRoot: '/home/pi/install/data',
};
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-programme-closure-'));
  roots.push(root);
  const manifest = fixtureRelease('S11');
  manifest.releaseId = 'release-aaaaaaaaaaaa-20261006121509';
  const slices = Array.from({ length: 11 }, (_, n) => ({
    id: 'S' + String(n + 1).padStart(2, '0'),
    implementation_status: 'merged',
    review_status: 'human_merged',
    pr_url: 'https://github.com/ufJmacca/nanoclaw/pull/' + (54 + n),
    merged_sha: n === 10 ? manifest.source.commit : digest('slice-' + n).slice(0, 40),
    local_test_status: 'passed',
    target_image_test_status: 'passed_on_mac_linux_arm64',
    pi_smoke_status: n === 10 ? 'pending' : 'passed',
    merged_source_delivery_status: n === 10 ? 'pending' : 'passed',
    deployed_source_sha: n === 10 ? null : digest('slice-' + n).slice(0, 40),
  }));
  const ledger = {
    slices,
    alignment_corrections: [
      {
        id: 'S01-codex-subscription-runtime',
        status: 'merged_deployed_fixture_verified',
        accepted_merged_source: { commit: slices[0].merged_sha },
        publication: { pr: 54 },
      },
    ],
    unknown: { retain: true },
  };
  const reviews = slices.map((s) => ({
    url: s.pr_url,
    state: 'MERGED',
    baseRefName: 'main',
    mergeCommit: { oid: s.merged_sha },
    mergedAt: '2026-10-06T00:00:00Z',
    mergedBy: { login: 'fixture-owner', is_bot: false },
  }));
  const proof = makeProgrammeProtection(ledger, manifest, digest(binding), reviews, () => true);
  return { root, ledger, manifest, reviews, proof };
}
it('S11-OPS02 closes disposal after all reviewed merge/local gates even when final deployment is pending', async () => {
  const f = fixture();
  initializeTarget(path.join(f.root, 'target'), binding);
  const target = path.join(f.root, 'target'),
    lease = beginMaintenance(target, binding, 'release-failed', 'deployment');
  await confirmQuiescence(target, binding, lease, async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }));
  const result = protectCompletedProgramme(target, binding, f.proof);
  expect(result.lifecycle).toBe('protected');
  expect(result.maintenance).toBe(true);
  expect(result.maintenanceId).toBe(lease.nonce);
  expect(() => assertMaintenanceLease(target, binding, lease)).not.toThrow();
  expect(readPrivate<{ completionDigest: string }>(path.join(target, 'protected.json')).completionDigest).toBe(
    digest(f.proof),
  );
});
it('S11-OPS03/REL04 stale target state, blank/lost Mac ledgers and code changes cannot reopen disposal', () => {
  const f = fixture(),
    target = path.join(f.root, 'target'),
    original = initializeTarget(target, binding);
  protectCompletedProgramme(target, binding, f.proof);
  writeAtomic(target, 'state.json', original);
  expect(readTarget(target, binding).lifecycle).toBe('protected');
  expect(initializeTarget(target, binding).lifecycle).toBe('protected');
  expect(() => beginMaintenance(target, binding, 'stale-ledger', 'runtime-disposable')).toThrow('protected_target');
  expect(completionReferences({ slices: [] }, f.manifest)).toBeNull();
  expect(protectCompletedProgramme(target, binding, f.proof).lifecycle).toBe('protected');
});
it('S11-OPS05 no claimed ledger completion, bot merge, missing review, source mismatch or unrelated target can supply protection evidence', () => {
  const f = fixture();
  expect(
    completionReferences(
      {
        ...f.ledger,
        slices: f.ledger.slices.map((s) => (s.id === 'S11' ? { ...s, implementation_status: 'in_progress' } : s)),
      },
      f.manifest,
    ),
  ).toBeNull();
  for (const reviews of [
    f.reviews.slice(0, 10),
    f.reviews.map((r, i) => (i === 10 ? { ...r, mergedBy: { login: 'bot', is_bot: true } } : r)),
    f.reviews.map((r, i) => (i === 10 ? { ...r, mergeCommit: { oid: '9'.repeat(40) } } : r)),
  ])
    expect(() => makeProgrammeProtection(f.ledger, f.manifest, digest(binding), reviews, () => true)).toThrow(
      'programme_completion_unverified',
    );
  expect(() => makeProgrammeProtection(f.ledger, f.manifest, digest(binding), f.reviews, () => false)).toThrow(
    'programme_completion_unverified',
  );
  const target = path.join(f.root, 'target');
  initializeTarget(target, binding);
  expect(() => protectCompletedProgramme(target, binding, { ...f.proof, bindingDigest: 'c'.repeat(64) })).toThrow(
    'programme_completion_unverified',
  );
  expect(readTarget(target, binding).lifecycle).toBe('implementation_disposable');
});
it('closure invalidates an interrupted disposal lease and lost or altered closure evidence fails closed', async () => {
  const f = fixture(),
    target = path.join(f.root, 'target');
  initializeTarget(target, binding);
  const lease = beginMaintenance(target, binding, 'interrupted-fixture', 'runtime-disposable');
  await confirmQuiescence(target, binding, lease, async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }));
  protectCompletedProgramme(target, binding, f.proof);
  expect(() => assertMaintenanceLease(target, binding, lease)).toThrow('protected_target');
  writeAtomic(target, 'programme-protection.json', { ...f.proof, reviews: [] });
  expect(() => readTarget(target, binding)).toThrow('target_protection_conflict');
  fs.unlinkSync(path.join(target, 'programme-protection.json'));
  expect(() => initializeTarget(target, binding)).toThrow();
});
it('protection uses a previously tested S11 payload without requiring a reachable database or healthy service', async () => {
  const f = fixture(),
    releaseRoot = path.join(f.root, 'releases'),
    stateRoot = path.join(f.root, 'target');
  const archive = path.join(releaseRoot, f.manifest.releaseId),
    payload = path.join(archive, 'payload');
  const helper = path.join(payload, 'dist/modules/chief-of-staff/ops/target-helper.js');
  fs.mkdirSync(path.dirname(helper), { recursive: true, mode: 0o700 });
  fs.writeFileSync(helper, 'fixture prebuilt helper');
  f.manifest.hostPayloadDigest = await payloadDigest(payload);
  writeAtomic(archive, 'release.json', f.manifest);
  const receipt = path.join(stateRoot, 'releases', f.manifest.releaseId);
  fs.mkdirSync(receipt, { recursive: true, mode: 0o700 });
  const record = {
    version: 1,
    releaseId: f.manifest.releaseId,
    manifestDigest: digest(f.manifest),
    bindingDigest: digest(binding),
    status: 'healthy',
    pending: null,
    completed: ['source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate', 'health'],
  };
  writeAtomic(receipt, 'deployment.json', record);
  await expect(verifyProtectionHelper({ releaseRoot, stateRoot }, binding, helper)).resolves.toEqual(f.manifest);
  writeAtomic(receipt, 'deployment.json', { ...record, status: 'in_progress' });
  await expect(verifyProtectionHelper({ releaseRoot, stateRoot }, binding, helper)).rejects.toThrow(
    'programme_completion_unverified',
  );
  writeAtomic(receipt, 'deployment.json', record);
  fs.appendFileSync(helper, ' changed');
  await expect(verifyProtectionHelper({ releaseRoot, stateRoot }, binding, helper)).rejects.toThrow(
    'programme_completion_unverified',
  );
});
it('the Mac coordinator freezes only bounded references and requires fresh GH and host Git evidence before producing a proof', async () => {
  const f = fixture(),
    cwd = process.cwd();
  process.chdir(f.root);
  try {
    const state = path.join(f.root, '.cos-plan-state'),
      archive = path.join(state, 'releases', f.manifest.releaseId);
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    writeAtomic(archive, 'release.json', f.manifest);
    writeAtomic(state, 'execution.json', f.ledger);
    writeAtomic(state, 'deployment-target.json', {
      version: 1,
      target: 'pi',
      sshAlias: 'fixture-pi',
      ...binding,
      userHome: '/home/pi',
      stateRoot: '/home/pi/state',
      releaseRoot: '/home/pi/releases',
      stagingRoot: '/home/pi/staging',
      sourceRoot: '/home/pi/source',
      runtimeEnvironment: '/home/pi/.config/runtime.env',
      migrationEnvironment: '/home/pi/.config/migration.env',
    });
    const refs = await macProgrammeCommand(['references', f.manifest.releaseId]);
    expect(refs?.split('\n')).toHaveLength(11);
    const closure = path.join(state, 'programme-protection', f.manifest.releaseId);
    for (const [i, review] of f.reviews.entries()) writeAtomic(closure, 'review-' + i + '.json', review);
    await expect(macProgrammeCommand(['make', f.manifest.releaseId])).rejects.toThrow();
    fs.writeFileSync(
      path.join(closure, 'ancestry.tsv'),
      f.ledger.slices.map((s, i) => i + '\t' + s.merged_sha + '\t' + f.manifest.source.commit).join('\n') + '\n',
      { mode: 0o600 },
    );
    await expect(macProgrammeCommand(['make', f.manifest.releaseId])).resolves.toEqual('verified');
    const proof = readPrivate(path.join(closure, 'proof.json'));
    expect(digest(proof)).toEqual(digest(f.proof));
    const command = await macProgrammeCommand(['command', f.manifest.releaseId]);
    expect(command).toContain('programme-protect');
    expect(command).not.toMatch(/COS_PG|restart|docker build|git pull/);
    writeAtomic(closure, 'target-result.json', {
      status: 'protected',
      lifecycle: 'protected',
      bindingDigest: digest(binding),
      completionDigest: digest(proof),
      sourceCommit: f.manifest.source.commit,
      sourceTree: f.manifest.source.tree,
      accountActivation: 'not_granted_by_protection',
    });
    await expect(macProgrammeCommand(['verify', f.manifest.releaseId])).resolves.toEqual('protected');
    writeAtomic(state, 'execution.json', { slices: [], alignment_corrections: [] });
    await expect(macProgrammeCommand(['references', f.manifest.releaseId])).resolves.toEqual('');
    await expect(macProgrammeCommand(['make', f.manifest.releaseId])).rejects.toThrow(
      'programme_completion_unverified',
    );
  } finally {
    process.chdir(cwd);
  }
});
