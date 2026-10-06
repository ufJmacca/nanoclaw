import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkpointLocalExecution, readLocalExecution } from './mac-release.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function ledger(patch: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-s11-admission-'));
  roots.push(root);
  const source = 'a'.repeat(40);
  const predecessor = {
    id: 'S10',
    implementation_status: 'merged',
    review_status: 'human_merged',
    merged_sha: source,
    deployed_source_sha: source,
    merged_source_delivery_status: 'passed',
    pi_smoke_status: 'passed',
    ...patch,
  };
  const value = {
    active_slice: 'S11',
    slices: [predecessor, { id: 'S11', implementation_status: 'in_progress' }],
    prior_evidence: { source, retained: true },
    unknown: { preserved: true },
  };
  fs.writeFileSync(path.join(root, 'execution.json'), JSON.stringify(value), { mode: 0o600 });
  return { root, value };
}

it('S11 release admission preserves reviewed S10 acceptance and unrelated programme history', () => {
  const { root, value } = ledger();
  expect(readLocalExecution(root, true)).toEqual(value);
  checkpointLocalExecution(root, { phase: 'operations_red_tests' });
  expect(JSON.parse(fs.readFileSync(path.join(root, 'execution.json'), 'utf8'))).toMatchObject({
    prior_evidence: value.prior_evidence,
    unknown: value.unknown,
    slices: [value.slices[0], { id: 'S11', phase: 'operations_red_tests' }],
  });
});

it.each([
  { implementation_status: 'in_progress' },
  { review_status: 'awaiting_review' },
  { merged_sha: undefined },
  { deployed_source_sha: 'b'.repeat(40) },
  { merged_source_delivery_status: 'pending' },
  { pi_smoke_status: 'pending' },
])('S11 refuses an unmerged or unverified predecessor: %j', (patch) => {
  expect(() => readLocalExecution(ledger(patch).root, true)).toThrow();
});
