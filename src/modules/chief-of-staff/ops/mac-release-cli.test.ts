import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { macReleaseCommand, releaseCheckImageIds, assertCleanCandidateSource } from './mac-release-cli.js';
import { BACKUP_RELEASE_CHECKS, MAIL_RELEASE_CHECKS, MAIL_DRAFT_RELEASE_CHECKS } from './release-manifest.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { writeAtomic } from './target-state.js';
import { readStageTimings } from './stage-timing.js';

const roots: string[] = [];
it('distinguishes a changed candidate commit from a dirty checkout without revealing file contents', () => {
  expect(() => assertCleanCandidateSource('a'.repeat(40), 'b'.repeat(40), false)).toThrow('candidate_source_changed');
  expect(() => assertCleanCandidateSource('a'.repeat(40), 'a'.repeat(40), true)).toThrow('candidate_worktree_dirty');
  expect(() => assertCleanCandidateSource('a'.repeat(40), 'b'.repeat(40), true)).toThrow('candidate_source_changed');
  expect(() => assertCleanCandidateSource('a'.repeat(40), 'a'.repeat(40), false)).not.toThrow();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('measures a completed bundle from its validated manifest without requiring the old checkout or a new build', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-complete-bundle-timing-'));
  roots.push(root);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const manifest = { ...fixtureRelease(), releaseId: 'release-aaaaaaaaaaaa-20261020070000' };
  const directory = path.join(root, '.cos-plan-state/releases', manifest.releaseId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeAtomic(directory, 'release.json', manifest);
  const span = await macReleaseCommand([
    'timing',
    manifest.releaseId,
    'start',
    'transfer_images',
    'images.tar.gz-transfer.log',
  ]);
  expect(span).toEqual(expect.any(String));
  await macReleaseCommand(['timing', manifest.releaseId, 'end', span!, '37']);
  expect(readStageTimings(directory)).toMatchObject({
    identity: {
      releaseId: manifest.releaseId,
      sourceCommit: manifest.source.commit,
      sourceTree: manifest.source.tree,
      buildInputDigest: manifest.buildInputDigest,
    },
    spans: [{ exitCode: 37 }],
  });
  expect(fs.existsSync(path.join(directory, 'plan.json'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'))).toEqual(manifest);
  writeAtomic(directory, 'release.json', { ...manifest, checks: {} });
  await expect(
    macReleaseCommand(['timing', manifest.releaseId, 'start', 'transfer_images', 'images.tar.gz-transfer.log']),
  ).rejects.toThrow('release_not_transferable');
  expect(readStageTimings(directory)!.spans).toHaveLength(1);
});

const images = [
  { role: 'host' as const, id: 'sha256:' + 'a'.repeat(64) },
  { role: 'agent' as const, id: 'sha256:' + 'b'.repeat(64) },
  { role: 'agent' as const, id: 'sha256:' + 'c'.repeat(64) },
];
it('admits G02 through G05 candidate syntax while refusing historical and unimplemented future release creation', async () => {
  const args = (slice: string) => [
    'init',
    'release-' + '1'.repeat(12) + '-20261011000000',
    'invalid-commit',
    'refs/heads/codex/fixture',
    slice,
  ];
  await expect(macReleaseCommand(args('G02'))).rejects.toThrow('invalid_candidate_source');
  await expect(macReleaseCommand(args('G03'))).rejects.toThrow('invalid_candidate_source');
  await expect(macReleaseCommand(args('G04'))).rejects.toThrow('invalid_candidate_source');
  await expect(macReleaseCommand(args('G05'))).rejects.toThrow('invalid_candidate_source');
  for (const slice of ['S10', 'G06', 'G07'])
    await expect(macReleaseCommand(args(slice))).rejects.toThrow('current_release_slice_required');
});
it.each([
  ...BACKUP_RELEASE_CHECKS,
  ...MAIL_RELEASE_CHECKS.filter((name) => name !== 'mail_evidence'),
  ...MAIL_DRAFT_RELEASE_CHECKS.filter((name) => name !== 'draft_transport'),
  'vault_helper',
  'vault_kernel',
  'vault_wire',
  'vault_units',
])('binds %s only to the registered immutable host, refusing partial image sets', (name) => {
  expect(releaseCheckImageIds(images, name)).toEqual([images[0].id]);
  expect(() => releaseCheckImageIds([], name)).toThrow('image_identity_required');
  expect(() => releaseCheckImageIds(images.slice(0, 1), name)).toThrow('image_identity_required');
  expect(() =>
    releaseCheckImageIds(
      images.map((image) => ({ ...image, role: 'agent' as const })),
      name,
    ),
  ).toThrow('image_identity_required');
});
it.each(['protected_state', 'mail_evidence', 'draft_transport', 'host_image', 'agent_image', 'image_isolation'])(
  'binds the %s gate to the complete immutable host and worker set',
  (name) => {
    expect(releaseCheckImageIds(images, name)).toEqual(images.map((image) => image.id));
    expect(() => releaseCheckImageIds([], name)).toThrow('image_identity_required');
    expect(() => releaseCheckImageIds(images.slice(0, 2), name)).toThrow('image_identity_required');
  },
);
it('keeps source checks distinct from immutable image evidence', () => {
  for (const name of ['root', 'runner', 'slice', 'demo']) expect(releaseCheckImageIds([], name)).toEqual([]);
});
it.each(['duplicate', 'invalid-id', 'two-hosts'])(
  'refuses %s registrations before issuing any final image check binding',
  (reason) => {
    const current = structuredClone(images);
    if (reason === 'duplicate') current[1].id = current[0].id;
    if (reason === 'invalid-id') current[1].id = 'mutable-image-tag';
    if (reason === 'two-hosts') Object.assign(current[1], { role: 'host' });
    for (const name of [
      'backup_recovery',
      'vault_kernel',
      'protected_state',
      'host_image',
      'draft_policy',
      'draft_transport',
    ])
      expect(() => releaseCheckImageIds(current, name)).toThrow('image_identity_required');
  },
);
