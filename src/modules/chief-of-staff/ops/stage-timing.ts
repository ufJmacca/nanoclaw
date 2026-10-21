import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPrivate, writeAtomic } from './target-state.js';

export type StageTimingIdentity = {
  releaseId: string;
  sourceCommit: string;
  sourceTree: string;
  buildInputDigest: string;
};
export type StageTimingSpan = {
  id: string;
  stage: string;
  evidence: string;
  attempt: number;
  startedAt: string;
  endedAt?: string;
  elapsedMs?: number;
  exitCode?: number;
};
export type StageTimingDocument = {
  contract: 'cos-stage-timing/v1';
  identity: StageTimingIdentity;
  spans: StageTimingSpan[];
};
const unverified = (): never => {
  throw Error('stage_timing_unverified');
};
function timestamp(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) unverified();
  return time;
}
function validate(previous: StageTimingDocument, identity: StageTimingIdentity): void {
  if (
    !/^release-[a-zA-Z0-9_-]{1,120}$/.test(identity.releaseId) ||
    ![identity.sourceCommit, identity.sourceTree].every((s) => /^[a-f0-9]{40}$/.test(s)) ||
    !/^[a-f0-9]{64}$/.test(identity.buildInputDigest) ||
    previous.contract !== 'cos-stage-timing/v1' ||
    JSON.stringify(previous.identity) !== JSON.stringify(identity) ||
    !Array.isArray(previous.spans) ||
    previous.spans.length > 512
  )
    unverified();
  const ids = new Set<string>(),
    attempts = new Map<string, number>();
  for (const span of previous.spans) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(span.id) ||
      ids.has(span.id) ||
      !/^[a-z][a-z0-9_-]{0,79}$/.test(span.stage) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(span.evidence) ||
      span.evidence.includes('..') ||
      span.attempt !== (attempts.get(span.stage) ?? 0) + 1
    )
      unverified();
    ids.add(span.id);
    attempts.set(span.stage, span.attempt);
    const started = timestamp(span.startedAt);
    if (span.endedAt === undefined) {
      if (span.elapsedMs !== undefined || span.exitCode !== undefined) unverified();
    } else if (
      timestamp(span.endedAt) < started ||
      span.elapsedMs !== timestamp(span.endedAt) - started ||
      !Number.isSafeInteger(span.exitCode) ||
      span.exitCode! < 0 ||
      span.exitCode! > 255
    )
      unverified();
  }
}
/** Measurements are supplemental diagnostics, never release or remote authority. */
export function beginStageTiming(
  previous: StageTimingDocument | undefined,
  identity: StageTimingIdentity,
  span: { id: string; stage: string; evidence: string; at: string },
): StageTimingDocument {
  const base = previous ?? { contract: 'cos-stage-timing/v1', identity, spans: [] };
  validate(base, identity);
  if (base.spans.length >= 512 || base.spans.some((s) => s.id === span.id)) unverified();
  const next: StageTimingDocument = {
    contract: base.contract,
    identity: { ...identity },
    spans: [
      ...base.spans.map((s) => ({ ...s })),
      {
        id: span.id,
        stage: span.stage,
        evidence: span.evidence,
        attempt: base.spans.filter((s) => s.stage === span.stage).length + 1,
        startedAt: span.at,
      },
    ],
  };
  validate(next, identity);
  return next;
}
export function finishStageTiming(
  previous: StageTimingDocument,
  identity: StageTimingIdentity,
  id: string,
  at: string,
  exitCode: number,
): StageTimingDocument {
  validate(previous, identity);
  const selected = previous.spans.find((s) => s.id === id);
  if (!selected || selected.endedAt !== undefined) unverified();
  const next = {
    ...previous,
    identity: { ...identity },
    spans: previous.spans.map((s) =>
      s.id === id ? { ...s, endedAt: at, elapsedMs: timestamp(at) - timestamp(s.startedAt), exitCode } : { ...s },
    ),
  };
  validate(next, identity);
  return next;
}
export function readStageTimings(root: string): StageTimingDocument | undefined {
  const file = path.join(root, 'stage-timings.json');
  return fs.lstatSync(file, { throwIfNoEntry: false }) ? readPrivate<StageTimingDocument>(file, 262144) : undefined;
}
/** Caller holds its existing operation lock. An unfinished span stays visible after interruption. */
export async function withStageTiming<T>(
  root: string,
  identity: StageTimingIdentity,
  stage: string,
  evidence: string,
  operation: () => Promise<T>,
): Promise<T> {
  const id = randomUUID();
  writeAtomic(
    root,
    'stage-timings.json',
    beginStageTiming(readStageTimings(root), identity, { id, stage, evidence, at: new Date().toISOString() }),
  );
  const finish = (exitCode: number) => {
    const previous = readStageTimings(root) ?? unverified();
    writeAtomic(
      root,
      'stage-timings.json',
      finishStageTiming(previous, identity, id, new Date().toISOString(), exitCode),
    );
  };
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    // Preserve the original operation failure even if diagnostic storage also failed.
    try {
      finish(1);
    } catch {
      /* The original unfinished span remains unconfirmed. */
    }
    throw error;
  }
  finish(result === false ? 1 : 0);
  return result;
}
