import { describe, it, expect } from 'vitest';
import {
  REQUIRED_RELEASE_CHECKS,
  validateReleaseManifest,
  supportsReleaseSchema,
  type ReleaseManifest,
} from './release-manifest.js';
import { INITIAL_CHECKSUM, MIGRATIONS } from '../store/migrations.js';
import { digest } from '../domain/contracts.js';
import type { VaultRootArtifactSeal } from './vault-root-artifact.js';
const sha = 'a'.repeat(40),
  tree = 'b'.repeat(40),
  image = 'sha256:' + 'c'.repeat(64),
  agent = 'sha256:' + 'd'.repeat(64);
function vaultManifest() {
  const seal: VaultRootArtifactSeal = {
    contract: 'cos-vault-root-artifact/v1',
    sourceCommit: sha,
    sourceTree: tree,
    runtime: { name: 'node', version: '22.23.2', architecture: 'arm64' },
    files: {
      'gateway.mjs': { bytes: 100, sha256: '4'.repeat(64) },
      node: { bytes: 122159120, sha256: '5'.repeat(64) },
    },
  };
  const checks: ReleaseManifest['checks'] = Object.fromEntries(
    ['vault_helper', 'vault_kernel', 'vault_units', 'vault_wire', 'protected_state'].map((name) => [
      name,
      {
        status: 'passed' as const,
        at: '2026-10-08T00:00:00Z',
        sourceCommit: sha,
        imageIds: name === 'protected_state' ? [image, agent] : [image],
      },
    ]),
  );
  return {
    ...manifest(),
    slice: 'G01',
    postgres: { minimum: 18, maximum: 18 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })),
    previousReleaseIds: ['release-reviewed-s11'],
    vaultArtifact: { digest: digest(seal), seal },
    checks: { ...manifest().checks, ...checks },
  };
}
it('G01 requires its sealed helper and additional immutable vault gates while preserving schema18', () => {
  const value = vaultManifest();
  expect(validateReleaseManifest(value)).toEqual(value);
  expect(supportsReleaseSchema(validateReleaseManifest(value), 18, 22)).toBe(true);
  expect(supportsReleaseSchema(validateReleaseManifest(value), 17, 22)).toBe(false);
});
it.each(['vault_helper', 'vault_kernel', 'vault_units', 'vault_wire', 'protected_state'])(
  'G01 refuses a missing, failed or foreign-image %s gate',
  (name) => {
    const value = vaultManifest();
    value.checks[name].status = 'failed';
    expect(() => validateReleaseManifest(value)).toThrow('release_not_transferable');
    value.checks[name].status = 'passed';
    value.checks[name].imageIds = [agent];
    expect(() => validateReleaseManifest(value)).toThrow('release_not_transferable');
    delete value.checks[name];
    expect(() => validateReleaseManifest(value)).toThrow('release_not_transferable');
  },
);
it.each([
  'no-seal',
  'digest',
  'source',
  'tree',
  'runtime',
  'extra-file',
  'predecessor',
  'old-checks-only',
  'native-schema',
])('G01 refuses %s without reopening original programme release authority', (reason) => {
  const value = vaultManifest();
  if (reason === 'no-seal') Object.assign(value, { vaultArtifact: undefined });
  if (reason === 'digest') value.vaultArtifact.digest = '0'.repeat(64);
  if (reason === 'source') value.vaultArtifact.seal.sourceCommit = '0'.repeat(40);
  if (reason === 'tree') value.vaultArtifact.seal.sourceTree = '0'.repeat(40);
  if (reason === 'runtime') value.vaultArtifact.seal.runtime.version = '24.0.0';
  if (reason === 'extra-file')
    Object.assign(value.vaultArtifact.seal.files, { 'private.env': { bytes: 10, sha256: '0'.repeat(64) } });
  if (reason === 'predecessor') value.previousReleaseIds = [];
  if (reason === 'old-checks-only') value.checks = manifest().checks;
  if (reason === 'native-schema') value.sqlite = { minimum: 21, maximum: 22 };
  if (!['no-seal', 'digest'].includes(reason)) value.vaultArtifact.digest = digest(value.vaultArtifact.seal);
  expect(() => validateReleaseManifest(value)).toThrow('release_not_transferable');
});
it('S10 binds the review migration without manufacturing schema16 rollback compatibility', () => {
  const current = {
    ...manifest(),
    slice: 'S10',
    postgres: { minimum: 18, maximum: 18 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: MIGRATIONS.slice(0, 18).map(({ version, checksum }) => ({ version, checksum })),
  };
  expect(validateReleaseManifest(current)).toEqual(current);
  expect(supportsReleaseSchema(validateReleaseManifest(current), 16)).toBe(false);
  for (const patch of [
    { slice: 'S12' },
    { postgres: { minimum: 16, maximum: 18 } },
    { postgres: { minimum: 17, maximum: 18 } },
    { migrations: current.migrations.map((m) => (m.version === 18 ? { ...m, checksum: '0'.repeat(64) } : m)) },
  ])
    expect(() => validateReleaseManifest({ ...current, ...patch })).toThrow('release_not_transferable');
});
it('S11 operations preserves schema18 compatibility and every exact reviewed migration', () => {
  const current = {
    ...manifest(),
    slice: 'S11',
    postgres: { minimum: 18, maximum: 18 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })),
  };
  expect(validateReleaseManifest(current)).toEqual(current);
  expect(supportsReleaseSchema(validateReleaseManifest(current), 18)).toBe(true);
  for (const patch of [
    { postgres: { minimum: 16, maximum: 18 } },
    { migrations: current.migrations.slice(0, 17) },
    { slice: 'S12' },
  ])
    expect(() => validateReleaseManifest({ ...current, ...patch })).toThrow('release_not_transferable');
});
it('S06 binds thirteen exact migrations without declaring historical rollback compatibility', () => {
  const current = {
    ...manifest(),
    slice: 'S06',
    postgres: { minimum: 13, maximum: 13 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: MIGRATIONS.slice(0, 13).map(({ version, checksum }) => ({ version, checksum })),
  };
  expect(validateReleaseManifest(current)).toEqual(current);
  for (const patch of [
    { slice: 'S07' },
    { slice: 'S05' },
    { postgres: { minimum: 9, maximum: 13 } },
    { postgres: { minimum: 13, maximum: 14 } },
    { migrations: current.migrations.slice(0, 12) },
    ...current.migrations.slice(9).map((_, index) => ({
      migrations: current.migrations.map((m, i) => (i === index + 9 ? { ...m, checksum: '0'.repeat(64) } : m)),
    })),
  ])
    expect(() => validateReleaseManifest({ ...current, ...patch })).toThrow('release_not_transferable');
});
it('S05 pins all nine migrations without widening historical releases or admitting future slices', () => {
  const current = {
    ...manifest(),
    slice: 'S05',
    postgres: { minimum: 9, maximum: 9 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: MIGRATIONS.slice(0, 9).map(({ version, checksum }) => ({ version, checksum })),
  };
  expect(validateReleaseManifest(current)).toEqual(current);
  for (const patch of [
    { slice: 'S04' },
    { slice: 'S06' },
    { slice: ['S05'] },
    { postgres: { minimum: 6, maximum: 9 } },
    { postgres: { minimum: 9, maximum: 10 } },
    { migrations: current.migrations.slice(0, 8) },
    { migrations: MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })) },
    ...current.migrations.map((_, index) => ({
      migrations: current.migrations.map((m, i) => (i === index ? { ...m, checksum: '0'.repeat(64) } : m)),
    })),
  ])
    expect(() => validateReleaseManifest({ ...current, ...patch })).toThrow('release_not_transferable');
});
it('S04 requires six exact pinned migrations and rejects earlier schema or later slice claims', () => {
  const current = {
    ...manifest(),
    slice: 'S04',
    postgres: { minimum: 6, maximum: 6 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: MIGRATIONS.slice(0, 6).map(({ version, checksum }) => ({ version, checksum })),
  };
  expect(validateReleaseManifest(current)).toEqual(current);
  for (const patch of [
    { postgres: { minimum: 3, maximum: 6 } },
    { postgres: { minimum: 6, maximum: 7 } },
    { migrations: current.migrations.slice(0, 5) },
    { migrations: MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })) },
    { slice: 'S03' },
    { slice: 'S05' },
    ...current.migrations.map((_, index) => ({
      migrations: current.migrations.map((m, i) => (i === index ? { ...m, checksum: '0'.repeat(64) } : m)),
    })),
  ])
    expect(() => validateReleaseManifest({ ...current, ...patch })).toThrow('release_not_transferable');
});
function manifest(): ReleaseManifest {
  return {
    contract: 'cos-release/v1',
    releaseId: 'release-fixture',
    slice: 'S01',
    platform: 'linux/arm64',
    source: {
      repository: 'ufJmacca/nanoclaw',
      commit: sha,
      tree,
      fetchRef: 'refs/heads/cos/s01-first-use-and-priorities',
      syncContract: 'cos-source-sync/github-pinned-v1',
    },
    buildInputDigest: 'e'.repeat(64),
    hostPayloadDigest: 'f'.repeat(64),
    workerAssetsDigest: '1'.repeat(64),
    rpc: 'cos-rpc/v1',
    postgres: { minimum: 1, maximum: 1 },
    sqlite: { minimum: 21, maximum: 21 },
    migrations: [{ version: 1, checksum: INITIAL_CHECKSUM }],
    previousReleaseIds: [],
    images: [
      {
        role: 'host',
        profile: 'host',
        tag: 'nanoclaw-cos-host:fixture',
        id: image,
        configurationId: 'sha256:' + '2'.repeat(64),
      },
      {
        role: 'agent',
        profile: 'codex',
        tag: 'nanoclaw-cos-agent:fixture',
        id: agent,
        configurationId: 'sha256:' + '3'.repeat(64),
      },
    ],
    checks: Object.fromEntries(
      REQUIRED_RELEASE_CHECKS.map((check) => [
        check,
        {
          status: 'passed',
          at: '2026-09-29T12:00:00Z',
          sourceCommit: sha,
          imageIds: check.includes('image') ? [image, agent] : [],
        },
      ]),
    ),
  };
}
describe('S01-REL01 source and final-image evidence gate', () => {
  it('recognizes the new native schema while retaining immutable older receipt identities', () => {
    expect(validateReleaseManifest(manifest()).sqlite).toEqual({ minimum: 21, maximum: 21 });
    const current = { ...manifest(), sqlite: { minimum: 22, maximum: 22 } };
    expect(validateReleaseManifest(current).sqlite).toEqual(current.sqlite);
    for (const sqlite of [
      { minimum: 22, maximum: 21 },
      { minimum: 22, maximum: 23 },
    ])
      expect(() => validateReleaseManifest({ ...manifest(), sqlite })).toThrow();
  });
  it('records configuration digests separately and requires explicit schema/migration compatibility', () => {
    for (const key of ['configurationId']) {
      const value = manifest();
      delete (value.images[0] as unknown as Record<string, unknown>)[key];
      expect(() => validateReleaseManifest(value)).toThrow();
    }
    for (const patch of [
      { sqlite: { minimum: 1, maximum: 20 } },
      { migrations: [] },
      { previousReleaseIds: ['../foreign'] },
    ])
      expect(() => validateReleaseManifest({ ...manifest(), ...patch })).toThrow();
  });
  it('accepts only complete evidence for one exact source and final image pair', () =>
    expect(validateReleaseManifest(manifest())).toEqual(manifest()));
  it.each(REQUIRED_RELEASE_CHECKS)('refuses a failed or missing mandatory %s check', (check) => {
    const value = manifest();
    value.checks[check].status = 'failed';
    expect(() => validateReleaseManifest(value)).toThrow('release_not_transferable');
    delete value.checks[check];
    expect(() => validateReleaseManifest(value)).toThrow('release_not_transferable');
  });
  it('S01-REL05 rejects evidence for other image identities', () => {
    const value = manifest();
    value.checks.agent_image.imageIds = [image];
    expect(() => validateReleaseManifest(value)).toThrow();
  });
  it('S01-REL13 rejects moving source references and a changed tested commit', () => {
    const value = manifest();
    value.source.commit = 'main';
    expect(() => validateReleaseManifest(value)).toThrow();
    value.source.commit = sha;
    value.checks.slice.sourceCommit = '1'.repeat(40);
    expect(() => validateReleaseManifest(value)).toThrow();
  });
  it('S01-REL08 rejects foreign repositories, traversal and a different platform', () => {
    for (const value of [
      { ...manifest(), releaseId: '../active' },
      { ...manifest(), platform: 'linux/amd64' },
      { ...manifest(), source: { ...manifest().source, repository: 'foreign/repo' } },
    ])
      expect(() => validateReleaseManifest(value)).toThrow();
  });
  it('does not accept mutable application tags or duplicate profile identities', () => {
    const value = manifest();
    value.images[0].tag = 'nanoclaw:latest';
    expect(() => validateReleaseManifest(value)).toThrow();
    value.images[0].tag = 'nanoclaw:fixture';
    value.images.push(value.images[1]);
    expect(() => validateReleaseManifest(value)).toThrow();
  });
});

it('S02 requires the exact knowledge migration and schema 2 while historical S01 receipts remain readable', async () => {
  const { KNOWLEDGE_CHECKSUM } = await import('../store/knowledge-schema.js');
  const current = {
    ...manifest(),
    slice: 'S02',
    postgres: { minimum: 2, maximum: 2 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: [
      { version: 1, checksum: INITIAL_CHECKSUM },
      { version: 2, checksum: KNOWLEDGE_CHECKSUM },
    ],
  };
  expect(validateReleaseManifest(current)).toEqual(current);
  expect(validateReleaseManifest(manifest()).slice).toBe('S01');
  for (const patch of [
    { postgres: { minimum: 1, maximum: 2 } },
    { postgres: { minimum: 2, maximum: 3 } },
    { sqlite: { minimum: 21, maximum: 22 } },
    { migrations: current.migrations.slice(0, 1) },
    { migrations: [...current.migrations].reverse() },
    { migrations: [current.migrations[0], { version: 2, checksum: 'a'.repeat(64) }] },
    { slice: 'S03' },
    { slice: ['S02'] },
  ])
    expect(() => validateReleaseManifest({ ...current, ...patch })).toThrow('release_not_transferable');
  expect(() => validateReleaseManifest({ ...current, slice: 'S01' })).toThrow();
});
it('S03 requires all three pinned migrations and schema 3 without changing historical receipts', async () => {
  const { KNOWLEDGE_CHECKSUM } = await import('../store/knowledge-schema.js');
  const { CALENDAR_CHECKSUM } = await import('../store/calendar-schema.js');
  const current = {
    ...manifest(),
    slice: 'S03',
    postgres: { minimum: 3, maximum: 3 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: [
      { version: 1, checksum: INITIAL_CHECKSUM },
      { version: 2, checksum: KNOWLEDGE_CHECKSUM },
      { version: 3, checksum: CALENDAR_CHECKSUM },
    ],
  };
  expect(validateReleaseManifest(current)).toEqual(current);
  for (const patch of [
    { postgres: { minimum: 2, maximum: 3 } },
    { postgres: { minimum: 3, maximum: 4 } },
    { migrations: current.migrations.slice(0, 2) },
    { migrations: [...current.migrations].reverse() },
    { migrations: [current.migrations[0], current.migrations[1], { version: 3, checksum: '0'.repeat(64) }] },
    { migrations: [current.migrations[0], { version: 2, checksum: '0'.repeat(64) }, current.migrations[2]] },
    { slice: 'S02' },
    { slice: 'S04' },
  ])
    expect(() => validateReleaseManifest({ ...current, ...patch })).toThrow('release_not_transferable');
  expect(validateReleaseManifest(manifest()).slice).toBe('S01');
});

it('S07 pins fourteen migrations and cannot promise S06 schema rollback compatibility', () => {
  const current = {
    ...manifest(),
    slice: 'S07',
    postgres: { minimum: 14, maximum: 14 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: MIGRATIONS.slice(0, 14).map(({ version, checksum }) => ({ version, checksum })),
  };
  expect(validateReleaseManifest(current)).toEqual(current);
  for (const patch of [
    { slice: 'S08' },
    { slice: 'S06' },
    { postgres: { minimum: 13, maximum: 14 } },
    { migrations: current.migrations.slice(0, 13) },
    { migrations: current.migrations.map((m) => (m.version === 14 ? { ...m, checksum: '0'.repeat(64) } : m)) },
  ])
    expect(() => validateReleaseManifest({ ...current, ...patch })).toThrow('release_not_transferable');
});
it('S08 pins fifteen migrations and rejects older rollback schemas or missing mandate accounting', () => {
  const current = {
    ...manifest(),
    slice: 'S08',
    postgres: { minimum: 15, maximum: 15 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: MIGRATIONS.slice(0, 15).map(({ version, checksum }) => ({ version, checksum })),
  };
  expect(validateReleaseManifest(current)).toEqual(current);
  for (const patch of [
    { slice: 'S07' },
    { postgres: { minimum: 14, maximum: 15 } },
    { migrations: current.migrations.slice(0, 14) },
    { migrations: current.migrations.map((m) => (m.version === 15 ? { ...m, checksum: '0'.repeat(64) } : m)) },
  ])
    expect(() => validateReleaseManifest({ ...current, ...patch })).toThrow('release_not_transferable');
});
it('S09 pins sixteen migrations and never widens S08 recovery compatibility', () => {
  const current = {
    ...manifest(),
    slice: 'S09',
    postgres: { minimum: 16, maximum: 16 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: MIGRATIONS.slice(0, 16).map(({ version, checksum }) => ({ version, checksum })),
  };
  const accepted = validateReleaseManifest(current);
  expect(supportsReleaseSchema(accepted, 16, 22)).toBe(true);
  expect(supportsReleaseSchema(accepted, 15, 22)).toBe(false);
  expect(supportsReleaseSchema(accepted, 17, 22)).toBe(false);
  const prior = validateReleaseManifest({
    ...current,
    slice: 'S08',
    postgres: { minimum: 15, maximum: 15 },
    migrations: current.migrations.slice(0, 15),
  });
  expect(supportsReleaseSchema(prior, 16, 22)).toBe(false);
  for (const patch of [
    { slice: 'S08' },
    { slice: 'S10' },
    { postgres: { minimum: 15, maximum: 16 } },
    { postgres: { minimum: 16, maximum: 17 } },
    { migrations: current.migrations.slice(0, 15) },
    { migrations: current.migrations.map((m) => (m.version === 16 ? { ...m, checksum: '0'.repeat(64) } : m)) },
  ])
    expect(() => validateReleaseManifest({ ...current, ...patch })).toThrow('release_not_transferable');
});
