import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readExtensionRelease, checkpointExtensionRelease } from './extension-release.js';
import { readReleaseExecution, checkpointReleaseExecution } from './mac-release.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('reads the sealed original history when Docker exposes it as root-owned, without changing it', () => {
  const f = fixture(),
    original = fs.readFileSync(f.root + '/execution.json'),
    actual = fs.fstatSync;
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
    const stat = actual(fd);
    if (stat.size === original.length) return Object.assign(stat, { uid: 0 });
    return stat;
  }) as typeof fs.fstatSync);
  expect(readExtensionRelease(f.root, true)).toEqual(f.extension);
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-release-'));
  roots.push(root);
  const source = 'a'.repeat(40);
  const original = {
    active_slice: 'S11',
    programme_complete: true,
    actual_goal_tool_completion: { status: 'complete' },
    slices: [
      {
        id: 'S11',
        implementation_status: 'merged',
        review_status: 'human_merged',
        merged_sha: source,
        deployed_source_sha: source,
        merged_source_delivery_status: 'verified_actual_reviewed_followup_source_and_protected_pi_acceptance',
        pi_smoke_status: 'passed',
      },
    ],
    unknown: { keep: 'original-private-history' },
  };
  const extension = {
    contract: 'cos-google-mail-storage-execution/v1',
    goal: 'nanoclaw-google-mail-storage',
    plan_revision: 1,
    published_specification_commit: 'b'.repeat(40),
    active_slice: 'G01',
    status: 'in_progress',
    slices: { G01: { status: 'in_progress', unknown: 'retain' }, G02: { status: 'not_started', depends_on: 'G01' } },
    unknown: { keep: true },
  };
  const save = () => {
    fs.writeFileSync(root + '/execution.json', JSON.stringify(original), { mode: 0o600 });
    fs.writeFileSync(root + '/google-mail-storage-execution.json', JSON.stringify(extension), { mode: 0o600 });
  };
  save();
  return { root, original, extension, save };
}
it('admits G01 only after completed reviewed original delivery and leaves original bytes unchanged', () => {
  const f = fixture(),
    originalBytes = fs.readFileSync(f.root + '/execution.json');
  expect(readExtensionRelease(f.root, true)).toEqual(f.extension);
  checkpointExtensionRelease(f.root, { release_build_id: 'release-fixture', release_status: 'local_checks_pending' });
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(originalBytes);
  expect(JSON.parse(fs.readFileSync(f.root + '/google-mail-storage-execution.json', 'utf8'))).toMatchObject({
    unknown: f.extension.unknown,
    slices: { G01: { ...f.extension.slices.G01, release_build_id: 'release-fixture' }, G02: f.extension.slices.G02 },
  });
});
it('routes G01 release checkpoints exclusively to the extension ledger', () => {
  const f = fixture(),
    bytes = fs.readFileSync(f.root + '/execution.json');
  expect(readReleaseExecution(f.root, 'G01', true).active_slice).toBe('G01');
  checkpointReleaseExecution(f.root, 'G01', { release_status: 'fixture_pending' });
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(bytes);
  expect(
    JSON.parse(fs.readFileSync(f.root + '/google-mail-storage-execution.json', 'utf8')).slices.G01.release_status,
  ).toBe('fixture_pending');
  expect(() => readReleaseExecution(f.root, 'S10')).toThrow();
});
function completedG01(f: ReturnType<typeof fixture>) {
  const commit = 'c'.repeat(40),
    tree = 'd'.repeat(40),
    releaseId = 'release-reviewed-g01';
  Object.assign(f.extension.slices.G01, {
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
  });
  f.extension.active_slice = 'G02';
  f.extension.slices.G02.status = 'in_progress';
  f.save();
  return f.extension.slices.G01 as Record<string, unknown>;
}
it('admits G02 only after reviewed matching G01 acceptance and checkpoints only G02', () => {
  const f = fixture();
  completedG01(f);
  const original = fs.readFileSync(f.root + '/execution.json'),
    g01 = structuredClone(f.extension.slices.G01);
  expect(readExtensionRelease(f.root, true)).toEqual(f.extension);
  expect(() => readReleaseExecution(f.root, 'G01', true)).toThrow('active_slice_required');
  checkpointExtensionRelease(f.root, { release_status: 'g02_local_checks_pending' });
  const saved = JSON.parse(fs.readFileSync(f.root + '/google-mail-storage-execution.json', 'utf8'));
  expect(saved.slices.G02.release_status).toBe('g02_local_checks_pending');
  expect(saved.slices.G01).toEqual(g01);
  expect(saved.unknown).toEqual(f.extension.unknown);
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
});
it.each([
  'incomplete',
  'unreviewed',
  'unmerged',
  'wrong-source',
  'wrong-tree',
  'wrong-release',
  'gates',
  'health',
  'pi',
  'future',
  'dependency',
  'review-wait',
])('denies G02 %s without updating either ledger', (reason) => {
  const f = fixture(),
    s = completedG01(f);
  const review = s.review as Record<string, unknown>,
    current = s.current_source as Record<string, unknown>;
  const accepted = s.merged_release_reconciliation as Record<string, unknown>;
  if (reason === 'incomplete') s.status = 'in_progress';
  if (reason === 'unreviewed') review.reviewed = false;
  if (reason === 'unmerged') review.merged = false;
  if (reason === 'wrong-source') s.deployed_source_sha = 'e'.repeat(40);
  if (reason === 'wrong-tree') accepted.tree = 'e'.repeat(40);
  if (reason === 'wrong-release') current.releaseId = 'release-other';
  if (reason === 'gates') accepted.allMandatoryGates = 'pending';
  if (reason === 'health') accepted.actualPiAcceptance = 'pending';
  if (reason === 'pi') s.pi_smoke_status = 'failed';
  if (reason === 'future') f.extension.active_slice = 'G03';
  if (reason === 'dependency') f.extension.slices.G02.depends_on = 'S11';
  if (reason === 'review-wait') f.extension.slices.G02.status = 'awaiting_review';
  f.save();
  const original = fs.readFileSync(f.root + '/execution.json'),
    extension = fs.readFileSync(f.root + '/google-mail-storage-execution.json');
  expect(() => readExtensionRelease(f.root, true)).toThrow('extension_release_not_admitted');
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
  expect(fs.readFileSync(f.root + '/google-mail-storage-execution.json')).toEqual(extension);
});
it.each([
  'incomplete',
  'unreviewed',
  'wrong-source',
  'delivery',
  'health',
  'future-slice',
  'review-wait',
  'wrong-contract',
])('denies %s without replacing either ledger', (reason) => {
  const f = fixture();
  if (reason === 'incomplete') f.original.programme_complete = false;
  if (reason === 'unreviewed') f.original.slices[0].review_status = 'awaiting_review';
  if (reason === 'wrong-source') f.original.slices[0].deployed_source_sha = 'c'.repeat(40);
  if (reason === 'delivery') f.original.slices[0].merged_source_delivery_status = 'pending';
  if (reason === 'health') f.original.slices[0].pi_smoke_status = 'pending';
  if (reason === 'future-slice') f.extension.active_slice = 'G02';
  if (reason === 'review-wait') f.extension.slices.G01.status = 'awaiting_review';
  if (reason === 'wrong-contract') f.extension.contract = 'cos-plan-execution/v5';
  f.save();
  const bytes = fs.readFileSync(f.root + '/execution.json');
  expect(() => readExtensionRelease(f.root, true)).toThrow('extension_release_not_admitted');
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(bytes);
});
