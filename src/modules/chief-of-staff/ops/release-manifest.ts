import { INITIAL_CHECKSUM } from '../store/migrations.js';
export const REQUIRED_RELEASE_CHECKS = [
  'root',
  'runner',
  'slice',
  'demo',
  'host_image',
  'agent_image',
  'image_isolation',
] as const;
export type ReleaseManifest = {
  contract: 'cos-release/v1';
  releaseId: string;
  slice: 'S01';
  platform: 'linux/arm64';
  source: {
    repository: 'ufJmacca/nanoclaw';
    commit: string;
    tree: string;
    fetchRef: string;
    syncContract: 'cos-source-sync/github-pinned-v1';
  };
  buildInputDigest: string;
  hostPayloadDigest: string;
  workerAssetsDigest: string;
  rpc: 'cos-rpc/v1';
  postgres: { minimum: number; maximum: number };
  sqlite: { minimum: number; maximum: number };
  migrations: Array<{ version: number; checksum: string }>;
  previousReleaseIds: string[];
  // id is the immutable local engine reference; containerd uses a manifest digest.
  // configurationId is independently hashed from the saved configuration JSON.
  images: Array<{ role: 'host' | 'agent'; profile: string; tag: string; id: string; configurationId: string }>;
  checks: Record<string, { status: 'passed' | 'failed'; at: string; sourceCommit: string; imageIds: string[] }>;
};
export function validateReleaseManifest(value: unknown): ReleaseManifest {
  const reject = (): never => {
    throw new Error('release_not_transferable');
  };
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const matches = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value);
  if (
    !object(value) ||
    value.contract !== 'cos-release/v1' ||
    value.slice !== 'S01' ||
    value.platform !== 'linux/arm64' ||
    value.rpc !== 'cos-rpc/v1' ||
    !matches(value.releaseId, /^release-[a-zA-Z0-9_-]{1,120}$/) ||
    !matches(value.buildInputDigest, /^[a-f0-9]{64}$/) ||
    !matches(value.hostPayloadDigest, /^[a-f0-9]{64}$/) ||
    !matches(value.workerAssetsDigest, /^[a-f0-9]{64}$/)
  )
    return reject();
  const source = value.source;
  if (
    !object(source) ||
    source.repository !== 'ufJmacca/nanoclaw' ||
    source.syncContract !== 'cos-source-sync/github-pinned-v1' ||
    !matches(source.commit, /^[a-f0-9]{40}$/) ||
    !matches(source.tree, /^[a-f0-9]{40}$/) ||
    !matches(source.fetchRef, /^refs\/(heads|tags)\/[a-zA-Z0-9_/-][a-zA-Z0-9_./-]{0,160}$/) ||
    String(source.fetchRef).includes('..')
  )
    return reject();
  const postgres = value.postgres;
  if (
    !object(postgres) ||
    !Number.isSafeInteger(postgres.minimum) ||
    !Number.isSafeInteger(postgres.maximum) ||
    postgres.minimum !== 1 ||
    postgres.maximum !== 1 ||
    !object(value.sqlite) ||
    value.sqlite.minimum !== 21 ||
    value.sqlite.maximum !== 21 ||
    !Array.isArray(value.migrations) ||
    value.migrations.length !== 1 ||
    !object(value.migrations[0]) ||
    value.migrations[0].version !== 1 ||
    value.migrations[0].checksum !== INITIAL_CHECKSUM ||
    !Array.isArray(value.previousReleaseIds) ||
    value.previousReleaseIds.length > 20 ||
    new Set(value.previousReleaseIds).size !== value.previousReleaseIds.length ||
    value.previousReleaseIds.some((id) => !matches(id, /^release-[a-zA-Z0-9_-]{1,120}$/) || id === value.releaseId)
  )
    return reject();
  if (!Array.isArray(value.images) || value.images.length < 2 || value.images.length > 20) return reject();
  const profiles = new Set<string>(),
    images = new Set<string>();
  let hosts = 0;
  for (const image of value.images) {
    if (
      !object(image) ||
      !['host', 'agent'].includes(String(image.role)) ||
      !matches(image.profile, /^[a-zA-Z0-9_-]{1,64}$/) ||
      !matches(image.id, /^sha256:[a-f0-9]{64}$/) ||
      !matches(image.configurationId, /^sha256:[a-f0-9]{64}$/) ||
      !matches(image.tag, /^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/) ||
      String(image.tag).endsWith(':latest')
    )
      return reject();
    const profile = image.role + ':' + image.profile;
    if (profiles.has(profile) || images.has(String(image.id))) return reject();
    profiles.add(profile);
    images.add(String(image.id));
    if (image.role === 'host') hosts++;
  }
  if (hosts !== 1 || !object(value.checks)) return reject();
  for (const name of REQUIRED_RELEASE_CHECKS) {
    const check = value.checks[name];
    if (
      !object(check) ||
      check.status !== 'passed' ||
      check.sourceCommit !== source.commit ||
      typeof check.at !== 'string' ||
      !Number.isFinite(Date.parse(check.at)) ||
      !Array.isArray(check.imageIds) ||
      check.imageIds.some((id) => !images.has(id))
    )
      return reject();
    if (
      name.includes('image') &&
      (check.imageIds.length !== images.size || new Set(check.imageIds).size !== images.size)
    )
      return reject();
  }
  return value as ReleaseManifest;
}
