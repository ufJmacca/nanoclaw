import { expect, it } from 'vitest';
import { RESTIC_ARTIFACT, verifyResticRepositoryIdentity, validateResticArtifactSeal } from './restic-artifact.js';
it('pins the signed Linux ARM64 binary rather than a mutable version or download', () => {
  expect(validateResticArtifactSeal({ ...RESTIC_ARTIFACT })).toEqual(RESTIC_ARTIFACT);
  expect(RESTIC_ARTIFACT).toMatchObject({
    version: '0.19.1',
    platform: 'linux/arm64',
    sha256: '2fb45ac6f9071b6f20eb883953a188f9e7c7cb6bbe43c67a2e47ada4e85ee7f0',
  });
});
it.each(['version', 'platform', 'sha256', 'compressedSha256', 'bytes', 'extra'])(
  'denies a changed artifact %s',
  (reason) => {
    const seal = { ...RESTIC_ARTIFACT } as Record<string, unknown>;
    seal[reason] = 'unverified';
    expect(() => validateResticArtifactSeal(seal)).toThrow(/^backup_artifact_unverified$/);
  },
);
it.each([undefined, null, [], {}, 'private-invalid-artifact'])(
  'rejects a malformed artifact with a fixed error',
  (value) => {
    expect(() => validateResticArtifactSeal(value)).toThrow(/^backup_artifact_unverified$/);
  },
);
const id = 'a'.repeat(64);
const config = () => ({ version: 2, id, chunker_polynomial: '25dcb4b21add63' });
it('requires repository v2 and the previously bound identity', () => {
  expect(verifyResticRepositoryIdentity(JSON.stringify(config()), id)).toEqual({ version: 2, id });
});
it.each(['v1', 'wrong-id', 'missing', 'unsafe', 'extra', 'huge', 'malformed'])(
  'denies repository %s without disclosing returned content',
  (reason) => {
    const value = config();
    if (reason === 'v1') value.version = 1;
    if (reason === 'wrong-id') value.id = 'b'.repeat(64);
    if (reason === 'missing') Object.assign(value, { chunker_polynomial: undefined });
    if (reason === 'unsafe') value.chunker_polynomial = 'PRIVATE_SENTINEL';
    if (reason === 'extra') Object.assign(value, { password: 'PRIVATE_SENTINEL' });
    const text =
      reason === 'huge' ? 'x'.repeat(65537) : reason === 'malformed' ? '{PRIVATE_SENTINEL' : JSON.stringify(value);
    expect(() => verifyResticRepositoryIdentity(text, id)).toThrow(/^backup_repository_unverified$/);
  },
);
