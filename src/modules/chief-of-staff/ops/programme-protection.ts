import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import {
  readPrivate,
  readTarget,
  withTargetLock,
  writeAtomic,
  type TargetBinding,
  type TargetState,
} from './target-state.js';
import { payloadDigest } from './payload.js';

const SLICES = Array.from({ length: 11 }, (_, i) => 'S' + String(i + 1).padStart(2, '0'));
const ALIGNMENT = 'S01-codex-subscription-runtime';
type Reference = { url: string; commit: string; slices: string[]; alignments: string[] };
type ReviewedReference = Reference & { mergedAt: string; mergedBy: string; ancestorOf: string };
export type ProgrammeProtection = {
  format: 'cos-programme-protection/v1';
  bindingDigest: string;
  releaseManifest: ReleaseManifest;
  reviews: ReviewedReference[];
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const pr = (value: unknown): value is string =>
  typeof value === 'string' && /^https:\/\/github\.com\/ufJmacca\/nanoclaw\/pull\/[1-9][0-9]*$/.test(value);
const passed = (value: unknown) => typeof value === 'string' && /^passed(?:_|$)/.test(value);
function reject(): never {
  throw new Error('programme_completion_unverified');
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) reject();
}

/** A local ledger can nominate evidence; only fresh human-merge observations can verify it. */
export function completionReferences(ledger: unknown, input: unknown): Reference[] | null {
  try {
    const manifest = validateReleaseManifest(input);
    if (
      manifest.slice !== 'S11' ||
      !object(ledger) ||
      !Array.isArray(ledger.slices) ||
      ledger.slices.length !== 11 ||
      !Array.isArray(ledger.alignment_corrections)
    )
      return null;
    const refs = new Map<string, Reference>();
    const add = (url: unknown, commit: unknown, slice?: string, alignment?: string) => {
      if (!pr(url) || !sha(commit)) reject();
      const existing = refs.get(url);
      if (existing && existing.commit !== commit) reject();
      const ref = existing ?? { url, commit, slices: [], alignments: [] };
      if (slice) ref.slices.push(slice);
      if (alignment) ref.alignments.push(alignment);
      refs.set(url, ref);
    };
    for (const id of SLICES) {
      const matches = ledger.slices.filter((s) => object(s) && s.id === id);
      if (matches.length !== 1) return null;
      const slice = matches[0] as Record<string, unknown>;
      if (
        slice.implementation_status !== 'merged' ||
        slice.review_status !== 'human_merged' ||
        !passed(slice.local_test_status) ||
        !passed(slice.target_image_test_status)
      )
        return null;
      if (id === 'S11') {
        if (slice.merged_sha !== manifest.source.commit) return null;
      } else if (
        !passed(slice.pi_smoke_status) ||
        !passed(slice.merged_source_delivery_status) ||
        slice.deployed_source_sha !== slice.merged_sha
      )
        return null;
      add(slice.pr_url, slice.merged_sha, id);
    }
    const corrections = ledger.alignment_corrections;
    if (!corrections.some((a) => object(a) && a.id === ALIGNMENT)) return null;
    for (const alignment of corrections) {
      if (
        !object(alignment) ||
        typeof alignment.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,120}$/.test(alignment.id) ||
        typeof alignment.status !== 'string' ||
        !/^merged_deployed_fixture_verified(?:_|$)/.test(alignment.status) ||
        !object(alignment.accepted_merged_source) ||
        !object(alignment.publication) ||
        !Number.isSafeInteger(alignment.publication.pr) ||
        Number(alignment.publication.pr) < 1
      )
        return null;
      add(
        'https://github.com/ufJmacca/nanoclaw/pull/' + alignment.publication.pr,
        alignment.accepted_merged_source.commit,
        undefined,
        alignment.id,
      );
    }
    return [...refs.values()];
    // eslint-disable-next-line no-catch-all/no-catch-all -- Unverifiable ledger nominations never authorise closure or disposal; no private parse errors are exposed.
  } catch {
    return null;
  }
}

/** Called only by the trusted Mac coordinator with host gh observations and Git ancestry checks. */
export function makeProgrammeProtection(
  ledger: unknown,
  input: unknown,
  bindingDigest: string,
  observations: unknown,
  ancestor: (commit: string, final: string) => boolean,
): ProgrammeProtection {
  const refs = completionReferences(ledger, input);
  if (
    !refs ||
    !/^[a-f0-9]{64}$/.test(bindingDigest) ||
    !Array.isArray(observations) ||
    observations.length !== refs.length
  )
    reject();
  const manifest = validateReleaseManifest(input);
  const reviews = refs.map((ref): ReviewedReference => {
    const candidates = observations.filter((r) => object(r) && r.url === ref.url);
    if (candidates.length !== 1) reject();
    const review = candidates[0] as Record<string, unknown>;
    if (
      review.state !== 'MERGED' ||
      review.baseRefName !== 'main' ||
      !object(review.mergeCommit) ||
      review.mergeCommit.oid !== ref.commit ||
      typeof review.mergedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(review.mergedAt) ||
      !Number.isFinite(Date.parse(review.mergedAt)) ||
      !object(review.mergedBy) ||
      typeof review.mergedBy.login !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(review.mergedBy.login) ||
      review.mergedBy.is_bot !== false ||
      !ancestor(ref.commit, manifest.source.commit)
    )
      reject();
    return { ...ref, mergedAt: review.mergedAt, mergedBy: review.mergedBy.login, ancestorOf: manifest.source.commit };
  });
  return validateProgrammeProtection({
    format: 'cos-programme-protection/v1',
    bindingDigest,
    releaseManifest: manifest,
    reviews,
  });
}

export function validateProgrammeProtection(value: unknown): ProgrammeProtection {
  try {
    if (!object(value)) reject();
    exact(value, ['format', 'bindingDigest', 'releaseManifest', 'reviews']);
    if (
      value.format !== 'cos-programme-protection/v1' ||
      typeof value.bindingDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.bindingDigest) ||
      !Array.isArray(value.reviews) ||
      value.reviews.length < 11 ||
      value.reviews.length > 32
    )
      reject();
    const manifest = validateReleaseManifest(value.releaseManifest);
    if (manifest.slice !== 'S11') reject();
    const slices: string[] = [],
      alignments: string[] = [],
      urls: string[] = [];
    for (const review of value.reviews) {
      if (!object(review)) reject();
      exact(review, ['url', 'commit', 'slices', 'alignments', 'mergedAt', 'mergedBy', 'ancestorOf']);
      if (
        !pr(review.url) ||
        !sha(review.commit) ||
        urls.includes(review.url) ||
        review.ancestorOf !== manifest.source.commit ||
        typeof review.mergedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(review.mergedAt) ||
        !Number.isFinite(Date.parse(review.mergedAt)) ||
        typeof review.mergedBy !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(review.mergedBy) ||
        !Array.isArray(review.slices) ||
        !Array.isArray(review.alignments) ||
        review.slices.length + review.alignments.length < 1 ||
        review.slices.some((s) => typeof s !== 'string' || !SLICES.includes(s)) ||
        review.alignments.some((a) => typeof a !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(a))
      )
        reject();
      if (review.slices.includes('S11') && review.commit !== manifest.source.commit) reject();
      urls.push(review.url);
      slices.push(...review.slices);
      alignments.push(...review.alignments);
    }
    if (
      slices.length !== 11 ||
      SLICES.some((s) => slices.filter((v) => v === s).length !== 1) ||
      !alignments.includes(ALIGNMENT) ||
      new Set(alignments).size !== alignments.length
    )
      reject();
    return value as ProgrammeProtection;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Invalid administrative evidence fails closed with one bounded public code.
  } catch {
    return reject();
  }
}

/** Pi-owned seal survives code changes and Mac-ledger loss. Tightening never grants account/model authority. */
export function protectCompletedProgramme(root: string, binding: TargetBinding, input: unknown): TargetState {
  const proof = validateProgrammeProtection(input),
    completionDigest = digest(proof);
  if (proof.bindingDigest !== digest(binding)) reject();
  return withTargetLock(root, () => {
    const state = readTarget(root, binding),
      proofPath = path.join(root, 'programme-protection.json');
    if (
      fs.lstatSync(proofPath, { throwIfNoEntry: false }) &&
      digest(validateProgrammeProtection(readPrivate(proofPath))) !== completionDigest
    )
      reject();
    const sealPath = path.join(root, 'protected.json');
    if (fs.lstatSync(sealPath, { throwIfNoEntry: false })) {
      const seal = readPrivate<{ completionDigest?: string }>(sealPath);
      if (seal.completionDigest && seal.completionDigest !== completionDigest) reject();
      if (seal.completionDigest === completionDigest) return state;
    }
    // Preserve an existing deployment lease so interrupted migration/health repair remains possible.
    // A runtime-disposable lease becomes unusable as soon as readTarget observes the seal.
    const next = {
      ...state,
      lifecycle: 'protected' as const,
      maintenance: true,
      generation: state.generation + (state.maintenanceId ? 0 : 1),
    };
    writeAtomic(root, 'programme-protection.json', proof);
    writeAtomic(root, 'protected.json', {
      bindingDigest: digest(binding),
      generation: next.generation,
      completionDigest,
    });
    writeAtomic(root, 'state.json', next);
    return next;
  });
}

/** A retained tested helper can tighten protection even during database/service repair. */
export async function verifyProtectionHelper(
  settings: { releaseRoot: string; stateRoot: string },
  binding: TargetBinding,
  invoked: string,
): Promise<ReleaseManifest> {
  try {
    const payload = path.resolve(path.dirname(invoked), '../../../..'),
      archive = path.dirname(payload);
    if (
      path.dirname(archive) !== settings.releaseRoot ||
      invoked !== path.join(payload, 'dist/modules/chief-of-staff/ops/target-helper.js') ||
      fs.realpathSync(invoked) !== invoked
    )
      reject();
    const manifest = validateReleaseManifest(readPrivate(path.join(archive, 'release.json')));
    if (manifest.slice !== 'S11' || manifest.releaseId !== path.basename(archive)) reject();
    const record = readPrivate<Record<string, unknown>>(
      path.join(settings.stateRoot, 'releases', manifest.releaseId, 'deployment.json'),
    );
    const phases = ['source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate', 'health'];
    if (
      record.version !== 1 ||
      record.releaseId !== manifest.releaseId ||
      record.manifestDigest !== digest(manifest) ||
      record.bindingDigest !== digest(binding) ||
      record.status !== 'healthy' ||
      record.pending !== null ||
      digest(record.completed) !== digest(phases) ||
      (await payloadDigest(payload)) !== manifest.hostPayloadDigest
    )
      reject();
    return manifest;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Unverified retained artifacts must not execute lifecycle changes or disclose private paths.
  } catch {
    return reject();
  }
}
