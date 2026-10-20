import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  beginStageTiming,
  finishStageTiming,
  readStageTimings,
  withStageTiming,
  type StageTimingIdentity,
} from './stage-timing.js';

const identity: StageTimingIdentity = {
  releaseId: 'release-aaaaaaaaaaaa-20261020070000',
  sourceCommit: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  buildInputDigest: 'c'.repeat(64),
};
const id = '11111111-1111-4111-8111-111111111111';
const nextId = '22222222-2222-4222-8222-222222222222';
const start = { id, stage: 'health', evidence: 'health.json', at: '2026-10-20T07:00:00.000Z' };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-stage-timing-'));
  roots.push(root);
  return root;
};

it('records UTC start/end, elapsed time, outcome and evidence for the exact candidate', () => {
  const opened = beginStageTiming(undefined, identity, start);
  const closed = finishStageTiming(opened, identity, id, '2026-10-20T07:00:02.250Z', 0);
  expect(closed.spans).toEqual([
    {
      id,
      stage: 'health',
      evidence: 'health.json',
      attempt: 1,
      startedAt: start.at,
      endedAt: '2026-10-20T07:00:02.250Z',
      elapsedMs: 2250,
      exitCode: 0,
    },
  ]);
  expect(opened.spans[0].endedAt).toBeUndefined();
});
it('preserves failed and unfinished attempts when a supported caller starts a later measurement', () => {
  const first = beginStageTiming(undefined, identity, start);
  const failed = finishStageTiming(first, identity, id, '2026-10-20T07:00:01.000Z', 1);
  const second = beginStageTiming(failed, identity, { ...start, id: nextId, at: '2026-10-20T07:01:00.000Z' });
  expect(second.spans[0]).toEqual(failed.spans[0]);
  expect(second.spans[1].attempt).toBe(2);
  expect(second.spans[1].exitCode).toBeUndefined();
  const third = beginStageTiming(second, identity, {
    ...start,
    id: '33333333-3333-4333-8333-333333333333',
    at: '2026-10-20T07:02:00.000Z',
  });
  expect(third.spans[1]).toEqual(second.spans[1]);
  expect(third.spans[2].attempt).toBe(3);
});

it('measures actual successful and false-returning operations without rewriting earlier outcomes', async () => {
  const root = fixture();
  await expect(withStageTiming(root, identity, 'health', 'health.json', async () => false)).resolves.toBe(false);
  const result = { status: 'fixture-passed' };
  await expect(withStageTiming(root, identity, 'health', 'health.json', async () => result)).resolves.toBe(result);
  const spans = readStageTimings(root)!.spans;
  expect(spans.map((s) => [s.attempt, s.exitCode])).toEqual([
    [1, 1],
    [2, 0],
  ]);
  expect(spans.every((s) => s.endedAt && Number.isSafeInteger(s.elapsedMs))).toBe(true);
});
it('records a rejected operation and preserves its original error', async () => {
  const root = fixture(),
    failure = Error('synthetic_operation_failed');
  await expect(
    withStageTiming(root, identity, 'restore_sql', 'restore.json', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(readStageTimings(root)!.spans[0].exitCode).toBe(1);
});
it('preserves the original failure when its diagnostic storage becomes unavailable', async () => {
  const root = fixture(),
    failure = Error('synthetic_operation_failed');
  await expect(
    withStageTiming(root, identity, 'restore_sql', 'restore.json', async () => {
      fs.renameSync(path.join(root, 'stage-timings.json'), path.join(root, 'held.json'));
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'held.json'), 'utf8')).spans[0].endedAt).toBeUndefined();
  expect(fs.existsSync(path.join(root, 'stage-timings.json'))).toBe(false);
});
it('refuses another source or input identity and cannot overwrite a completed measurement', () => {
  const opened = beginStageTiming(undefined, identity, start);
  const closed = finishStageTiming(opened, identity, id, '2026-10-20T07:00:01.000Z', 1);
  expect(() =>
    beginStageTiming(closed, { ...identity, sourceCommit: 'd'.repeat(40) }, { ...start, id: nextId }),
  ).toThrow(/^stage_timing_unverified$/);
  expect(() => finishStageTiming(closed, identity, id, '2026-10-20T07:00:02.000Z', 0)).toThrow(
    /^stage_timing_unverified$/,
  );
  expect(closed.spans[0].exitCode).toBe(1);
});
it('rejects unknown spans, backwards clocks, unsafe evidence names and invalid exit codes', () => {
  const opened = beginStageTiming(undefined, identity, start);
  expect(() => finishStageTiming(opened, identity, nextId, start.at, 0)).toThrow(/^stage_timing_unverified$/);
  expect(() => finishStageTiming(opened, identity, id, '2026-10-20T06:59:59.000Z', 0)).toThrow(
    /^stage_timing_unverified$/,
  );
  expect(() => finishStageTiming(opened, identity, id, start.at, -1)).toThrow(/^stage_timing_unverified$/);
  expect(() => beginStageTiming(undefined, identity, { ...start, evidence: '../private.env' })).toThrow(
    /^stage_timing_unverified$/,
  );
});
