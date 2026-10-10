import path from 'node:path';
import fs from 'node:fs';
import { readPrivate, writeAtomic } from './target-state.js';
/** Completed history may be exposed as root-owned by Docker's Mac filesystem. It is read-only here. */
function completedProgramme<T>(file: string): T {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      ![0, process.getuid?.()].includes(before.uid) ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > 1024 * 1024 ||
      fs.realpathSync(file) !== file
    )
      throw Error('unsafe_completed_programme');
    const bytes = Buffer.alloc(before.size + 1),
      count = fs.readSync(fd, bytes, 0, bytes.length, 0),
      after = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      count !== before.size ||
      after.size !== before.size ||
      after.uid !== before.uid ||
      after.mode !== before.mode ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw Error('completed_programme_changed');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))) as T;
  } finally {
    fs.closeSync(fd);
  }
}
export type ExtensionReleaseState = {
  contract: 'cos-google-mail-storage-execution/v1';
  goal: 'nanoclaw-google-mail-storage';
  plan_revision: 1;
  published_specification_commit: string;
  active_slice: 'G01';
  status: string;
  slices: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};
/** Additive extension admission. It never reopens or rewrites the completed original programme. */
export function readExtensionRelease(root: string, forRelease = false): ExtensionReleaseState {
  try {
    const original = completedProgramme<{
      active_slice: string;
      programme_complete: boolean;
      actual_goal_tool_completion?: { status: string };
      slices: Array<Record<string, unknown>>;
    }>(path.join(root, 'execution.json'));
    const previous = original.slices?.find((slice) => slice.id === 'S11');
    if (
      original.active_slice !== 'S11' ||
      original.programme_complete !== true ||
      original.actual_goal_tool_completion?.status !== 'complete' ||
      !previous ||
      previous.implementation_status !== 'merged' ||
      previous.review_status !== 'human_merged' ||
      typeof previous.merged_sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(previous.merged_sha) ||
      previous.deployed_source_sha !== previous.merged_sha ||
      !['passed', 'verified_actual_reviewed_followup_source_and_protected_pi_acceptance'].includes(
        String(previous.merged_source_delivery_status),
      ) ||
      previous.pi_smoke_status !== 'passed'
    )
      throw Error('original_programme_acceptance_required');
    const ledger = readPrivate<ExtensionReleaseState>(
      path.join(root, 'google-mail-storage-execution.json'),
      1024 * 1024,
    );
    if (
      !ledger ||
      ledger.contract !== 'cos-google-mail-storage-execution/v1' ||
      ledger.goal !== 'nanoclaw-google-mail-storage' ||
      ledger.plan_revision !== 1 ||
      !/^[a-f0-9]{40}$/.test(ledger.published_specification_commit) ||
      ledger.active_slice !== 'G01' ||
      ledger.status !== 'in_progress' ||
      !ledger.slices ||
      typeof ledger.slices !== 'object' ||
      Array.isArray(ledger.slices) ||
      !ledger.slices.G01 ||
      typeof ledger.slices.G01 !== 'object' ||
      Array.isArray(ledger.slices.G01) ||
      (forRelease && !['in_progress', 'alignment_in_progress'].includes(String(ledger.slices.G01.status)))
    )
      throw Error('active_extension_slice_required');
    return ledger;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private ledger paths/history are never included in release errors.
    throw Error('extension_release_not_admitted');
  }
}
export function checkpointExtensionRelease(root: string, patch: Record<string, unknown>): void {
  const ledger = readExtensionRelease(root);
  Object.assign(ledger.slices.G01, patch, { checkpoint_at: new Date().toISOString() });
  writeAtomic(root, 'google-mail-storage-execution.json', ledger);
}
