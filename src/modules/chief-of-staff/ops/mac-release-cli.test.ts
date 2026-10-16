import { expect, it } from 'vitest';
import { macReleaseCommand, releaseCheckImageIds } from './mac-release-cli.js';
import { BACKUP_RELEASE_CHECKS, MAIL_RELEASE_CHECKS } from './release-manifest.js';

const images = [
  { role: 'host' as const, id: 'sha256:' + 'a'.repeat(64) },
  { role: 'agent' as const, id: 'sha256:' + 'b'.repeat(64) },
  { role: 'agent' as const, id: 'sha256:' + 'c'.repeat(64) },
];
it('admits G02 and G03 candidate syntax while refusing historical and future release creation', async () => {
  const args = (slice: string) => [
    'init',
    'release-' + '1'.repeat(12) + '-20261011000000',
    'invalid-commit',
    'refs/heads/codex/fixture',
    slice,
  ];
  await expect(macReleaseCommand(args('G02'))).rejects.toThrow('invalid_candidate_source');
  await expect(macReleaseCommand(args('G03'))).rejects.toThrow('invalid_candidate_source');
  for (const slice of ['S10', 'G04', 'G07'])
    await expect(macReleaseCommand(args(slice))).rejects.toThrow('current_release_slice_required');
});
it.each([
  ...BACKUP_RELEASE_CHECKS,
  ...MAIL_RELEASE_CHECKS.filter((name) => name !== 'mail_evidence'),
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
it.each(['protected_state', 'mail_evidence', 'host_image', 'agent_image', 'image_isolation'])(
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
    for (const name of ['backup_recovery', 'vault_kernel', 'protected_state', 'host_image'])
      expect(() => releaseCheckImageIds(current, name)).toThrow('image_identity_required');
  },
);
