import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readExtensionRelease, checkpointExtensionRelease } from './extension-release.js';
import { readReleaseExecution, checkpointReleaseExecution } from './mac-release.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
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
