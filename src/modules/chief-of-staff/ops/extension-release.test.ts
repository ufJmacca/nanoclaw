import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readExtensionRelease, checkpointExtensionRelease } from './extension-release.js';
import { readReleaseExecution, checkpointReleaseExecution } from './mac-release.js';
import { readPrivate } from './target-state.js';
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
it('routes G02 release admission and checkpoints only to its reviewed extension ledger', () => {
  const f = fixture();
  completedG01(f);
  const original = fs.readFileSync(f.root + '/execution.json'),
    g01 = structuredClone(f.extension.slices.G01);
  expect(readReleaseExecution(f.root, 'G02', true)).toEqual(f.extension);
  checkpointReleaseExecution(f.root, 'G02', { release_status: 'g02_fixture_pending' });
  const saved = JSON.parse(fs.readFileSync(f.root + '/google-mail-storage-execution.json', 'utf8'));
  expect(saved.slices.G02.release_status).toBe('g02_fixture_pending');
  expect(saved.slices.G01).toEqual(g01);
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
});
function completedG02(f: ReturnType<typeof fixture>) {
  completedG01(f);
  const commit = 'e'.repeat(40),
    tree = 'f'.repeat(40),
    releaseId = 'release-reviewed-g02';
  const predecessor = Object.assign(f.extension.slices.G02, {
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
    actual_G02_isolated_restore: { status: 'backup_test_restore_verified' },
    actual_merged_remote_checkpoint: {
      status: 'backup_uploaded',
      maintenance: { status: 'verified' },
      state: { pending: 0, held: 0 },
      credentials: { pending: 0, held: 0 },
    },
  });
  Object.assign(f.extension.slices, { G03: { status: 'in_progress', depends_on: 'G02', unknown: 'retain-g03' } });
  f.extension.active_slice = 'G03';
  f.save();
  return predecessor;
}
it('admits G03 after reviewed matching G02 delivery, encrypted backup and isolated restore acceptance', () => {
  const f = fixture();
  completedG02(f);
  const original = fs.readFileSync(f.root + '/execution.json'),
    predecessor = structuredClone(f.extension.slices.G02);
  expect(readExtensionRelease(f.root, true)).toEqual(f.extension);
  expect(readReleaseExecution(f.root, 'G03', true)).toEqual(f.extension);
  checkpointReleaseExecution(f.root, 'G03', { release_status: 'g03_fixture_pending' });
  const saved = JSON.parse(fs.readFileSync(f.root + '/google-mail-storage-execution.json', 'utf8'));
  expect(saved.slices.G03).toMatchObject({ unknown: 'retain-g03', release_status: 'g03_fixture_pending' });
  expect(saved.slices.G02).toEqual(predecessor);
  expect(saved.unknown).toEqual(f.extension.unknown);
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
});
it.each(['review', 'source', 'delivery', 'health', 'restore', 'upload', 'integrity', 'pending', 'held'])(
  'refuses G03 while G02 %s acceptance is incomplete and preserves both ledgers',
  (boundary) => {
    const f = fixture(),
      predecessor = completedG02(f);
    if (boundary === 'review') predecessor.review.reviewed = false;
    if (boundary === 'source') predecessor.current_source.commit = '0'.repeat(40);
    if (boundary === 'delivery') predecessor.merged_release_reconciliation.actualPiAcceptance = 'pending';
    if (boundary === 'health') predecessor.pi_smoke_status = 'pending';
    if (boundary === 'restore') predecessor.actual_G02_isolated_restore.status = 'pending';
    if (boundary === 'upload') predecessor.actual_merged_remote_checkpoint.status = 'backup_upload_failed';
    if (boundary === 'integrity') predecessor.actual_merged_remote_checkpoint.maintenance.status = 'failed';
    if (boundary === 'pending') predecessor.actual_merged_remote_checkpoint.state.pending = 1;
    if (boundary === 'held') predecessor.actual_merged_remote_checkpoint.credentials.held = 1;
    f.save();
    const original = fs.readFileSync(f.root + '/execution.json'),
      extension = fs.readFileSync(f.root + '/google-mail-storage-execution.json');
    expect(() => readExtensionRelease(f.root, true)).toThrow('extension_release_not_admitted');
    expect(() => checkpointReleaseExecution(f.root, 'G03', { release_status: 'must_not_write' })).toThrow();
    expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
    expect(fs.readFileSync(f.root + '/google-mail-storage-execution.json')).toEqual(extension);
  },
);
it('retains additive private programme history above the target receipt ceiling', () => {
  const f = fixture();
  completedG01(f);
  Object.assign(f.extension.unknown, { history: 'x'.repeat(1024 * 1024) });
  f.save();
  const original = fs.readFileSync(f.root + '/execution.json'),
    g01 = structuredClone(f.extension.slices.G01);
  expect(readExtensionRelease(f.root, true)).toEqual(f.extension);
  checkpointExtensionRelease(f.root, { release_status: 'large_history_retained' });
  const saved = JSON.parse(fs.readFileSync(f.root + '/google-mail-storage-execution.json', 'utf8'));
  expect(saved.unknown).toEqual(f.extension.unknown);
  expect(saved.slices.G01).toEqual(g01);
  expect(saved.slices.G02.release_status).toBe('large_history_retained');
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
  expect(() => readPrivate(f.root + '/google-mail-storage-execution.json', 8 * 1024 * 1024)).toThrow(
    'unsafe_target_state',
  );
});
it('accepts the bounded programme ceiling and refuses growth before the atomic checkpoint', () => {
  const f = fixture();
  Object.assign(f.extension.unknown, { history: '' });
  const base = Buffer.byteLength(JSON.stringify(f.extension));
  Object.assign(f.extension.unknown, { history: 'x'.repeat(8 * 1024 * 1024 - base) });
  f.save();
  const file = f.root + '/google-mail-storage-execution.json',
    bytes = fs.readFileSync(file);
  expect(bytes.length).toBe(8 * 1024 * 1024);
  expect(readExtensionRelease(f.root, true)).toEqual(f.extension);
  expect(() => checkpointExtensionRelease(f.root, { release_status: 'must_not_grow' })).toThrow(
    'extension_release_not_admitted',
  );
  expect(fs.readFileSync(file).equals(bytes)).toBe(true);
});
it('refuses an oversized checkpoint before changing either programme ledger', () => {
  const f = fixture(),
    original = fs.readFileSync(f.root + '/execution.json'),
    extension = fs.readFileSync(f.root + '/google-mail-storage-execution.json');
  expect(() => checkpointExtensionRelease(f.root, { oversized: 'x'.repeat(8 * 1024 * 1024) })).toThrow(
    'extension_release_not_admitted',
  );
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
  expect(fs.readFileSync(f.root + '/google-mail-storage-execution.json')).toEqual(extension);
});
it.each(['mode', 'special-mode', 'hardlink', 'symlink', 'root-mode', 'oversized', 'invalid-utf8'])(
  'refuses a private extension ledger with unsafe %s evidence without updating history',
  (reason) => {
    const f = fixture(),
      file = f.root + '/google-mail-storage-execution.json',
      original = fs.readFileSync(f.root + '/execution.json');
    if (reason === 'mode') fs.chmodSync(file, 0o644);
    if (reason === 'special-mode') fs.chmodSync(file, 0o4600);
    if (reason === 'hardlink') fs.linkSync(file, f.root + '/linked.json');
    if (reason === 'symlink') {
      fs.renameSync(file, f.root + '/actual.json');
      fs.symlinkSync(f.root + '/actual.json', file);
    }
    if (reason === 'root-mode') fs.chmodSync(f.root, 0o755);
    if (reason === 'oversized') fs.writeFileSync(file, 'x'.repeat(8 * 1024 * 1024 + 1));
    if (reason === 'invalid-utf8') {
      const bytes = fs.readFileSync(file),
        marker = bytes.indexOf(Buffer.from('retain'));
      bytes[marker] = 0xff;
      fs.writeFileSync(file, bytes);
    }
    const bytes = fs.readFileSync(file);
    expect(() => readExtensionRelease(f.root, true)).toThrow('extension_release_not_admitted');
    expect(() => checkpointExtensionRelease(f.root, { release_status: 'must_not_write' })).toThrow(
      'extension_release_not_admitted',
    );
    expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  },
);
it('refuses a programme file replaced during its bounded read', () => {
  const f = fixture(),
    file = f.root + '/google-mail-storage-execution.json',
    original = fs.readFileSync(f.root + '/execution.json'),
    extension = fs.readFileSync(file),
    actual = fs.readSync;
  vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(actual, fs, args);
    if (count === extension.length) {
      fs.renameSync(file, f.root + '/retained.json');
      fs.writeFileSync(file, extension, { mode: 0o600 });
    }
    return count;
  }) as typeof fs.readSync);
  expect(() => readExtensionRelease(f.root, true)).toThrow('extension_release_not_admitted');
  expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
  expect(fs.readFileSync(file)).toEqual(extension);
});
it.each(['truncate', 'append', 'same-size-edit', 'mode', 'owner', 'hardlink'])(
  'refuses programme %s withdrawal during its bounded read',
  (reason) => {
    const f = fixture(),
      file = f.root + '/google-mail-storage-execution.json',
      original = fs.readFileSync(f.root + '/execution.json'),
      extension = fs.readFileSync(file),
      actualRead = fs.readSync,
      actualStat = fs.fstatSync,
      actualPathStat = fs.lstatSync,
      initial = fs.lstatSync(file);
    let withdrawn = false;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(actualRead, fs, args);
      if (!withdrawn && count === extension.length) {
        withdrawn = true;
        if (reason === 'truncate') fs.truncateSync(file, extension.length - 1);
        if (reason === 'append') fs.appendFileSync(file, ' ');
        if (reason === 'same-size-edit') fs.writeFileSync(file, Buffer.alloc(extension.length, 0x20));
        if (reason === 'mode') fs.chmodSync(file, 0o644);
        if (reason === 'hardlink') fs.linkSync(file, f.root + '/linked.json');
      }
      return count;
    }) as typeof fs.readSync);
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = actualStat(fd);
      if (reason === 'same-size-edit' && stat.ino === initial.ino)
        Object.assign(stat, { mtimeMs: initial.mtimeMs, ctimeMs: initial.ctimeMs });
      return withdrawn && reason === 'owner' && stat.size === extension.length
        ? Object.assign(stat, { uid: stat.uid + 1 })
        : stat;
    }) as typeof fs.fstatSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = Reflect.apply(actualPathStat, fs, args);
      if (reason === 'same-size-edit' && stat?.ino === initial.ino)
        Object.assign(stat, { mtimeMs: initial.mtimeMs, ctimeMs: initial.ctimeMs });
      return stat;
    }) as typeof fs.lstatSync);
    expect(() => readExtensionRelease(f.root, true)).toThrow('extension_release_not_admitted');
    expect(withdrawn).toBe(true);
    expect(fs.readFileSync(f.root + '/execution.json')).toEqual(original);
  },
);
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
  if (reason === 'future') f.extension.active_slice = 'G04';
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
