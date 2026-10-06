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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-s10-admission-'));
  roots.push(root);
  const source = 'a'.repeat(40);
  const predecessor = {
    id: 'S09',
    implementation_status: 'merged',
    review_status: 'human_merged',
    merged_sha: source,
    deployed_source_sha: source,
    merged_source_delivery_status: 'passed',
    pi_smoke_status: 'passed',
    ...patch,
  };
  const value = {
    active_slice: 'S10',
    slices: [predecessor, { id: 'S10', implementation_status: 'in_progress' }],
    prior_evidence: { source, retained: true },
    unknown: { preserved: true },
  };
  fs.writeFileSync(path.join(root, 'execution.json'), JSON.stringify(value), { mode: 0o600 });
  return { root, value };
}

it('S10 admission preserves actual human-merged S09 delivery and unknown programme history', () => {
  const { root, value } = ledger();
  expect(readLocalExecution(root, true)).toEqual(value);
  checkpointLocalExecution(root, { phase: 'strategic_review_red_tests' });
  const current = JSON.parse(fs.readFileSync(path.join(root, 'execution.json'), 'utf8'));
  expect(current).toMatchObject({
    prior_evidence: value.prior_evidence,
    unknown: value.unknown,
    slices: [value.slices[0], { id: 'S10', phase: 'strategic_review_red_tests' }],
  });
});

it.each([
  { implementation_status: 'in_progress' },
  { review_status: 'awaiting_review' },
  { merged_sha: undefined },
  { deployed_source_sha: 'b'.repeat(40) },
  { merged_source_delivery_status: 'pending' },
  { pi_smoke_status: 'pending' },
])('S10 cannot bypass a missing predecessor merge or its exact tested Pi delivery: %j', (patch) => {
  const { root } = ledger(patch);
  expect(() => readLocalExecution(root, true)).toThrow();
});
