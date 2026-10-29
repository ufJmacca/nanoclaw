import { expect, it } from 'vitest';
import { RESTIC_ARTIFACT } from './restic-artifact.js';
import { verifyBackupJobFixtureImage, verifyBackupJobFixtureEvidence } from './backup-job-fixture-evidence.js';
const sourceCommit = 'a'.repeat(40),
  sourceTree = 'b'.repeat(40),
  hostImage = 'sha256:' + 'c'.repeat(64),
  fixtureImage = 'sha256:' + 'd'.repeat(64);
const identity = { sourceCommit, sourceTree, hostImage, fixtureImage, releaseSlice: 'G02' as const };
const inspection = [
  {
    Id: fixtureImage,
    Os: 'linux',
    Architecture: 'arm64',
    Config: {
      Labels: {
        'org.opencontainers.image.revision': sourceCommit,
        'nanoclaw.source-tree': sourceTree,
        'nanoclaw.tested-host': hostImage,
        'nanoclaw.release-role': 'backup-job-manager-fixture',
        'nanoclaw.final-artifact': 'false',
      } as Record<string, string>,
    },
  },
];
const binding = {
  jobFixtureImage: fixtureImage,
  testedHost: hostImage,
  sourceCommit,
  sourceTree,
  privateCgroupNamespace: true,
  hostDataMounted: false,
  ownerCredentialsUsed: false,
  releaseSlice: 'G02',
};
const scope = {
  Privileged: true,
  NetworkMode: 'none',
  CgroupnsMode: 'private',
  Binds: null,
  PortBindings: {},
  Memory: 1024 ** 3,
  MemorySwap: 1024 ** 3,
  PidsLimit: 256,
  Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
  Tmpfs: { '/run': 'rw,nosuid,nodev,size=64m', '/tmp': 'rw,nosuid,nodev,size=128m' },
};
const probe = {
  contract: 'cos-backup-job-release-fixture/v2',
  status: 'passed',
  cases: 7,
  releaseSlice: 'G02',
  schemaVersion: 18,
  actualG03ToG04Upgrade: false,
  sealedSourceCommit: sourceCommit,
  sealedSourceTree: sourceTree,
  backupArtifact: RESTIC_ARTIFACT,
  actualUserManager: true,
  actualStaticCompiler: true,
  actualEnablementLinks: 2,
  actualTimerActivation: true,
  actualTimerStop: true,
  idempotentFiles: true,
  withdrawnScopeDenied: true,
  compiledProductionInstallerAndAdapter: true,
  actualScheduledEntryFailsClosed: true,
  unrelatedUnitPreserved: true,
  syntheticReleaseAuthority: true,
  installedOwnerCommandAcceptance: false,
  actualScheduledCapture: false,
  actualRemoteUpload: false,
  ownerCredentialsUsed: false,
  finalArtifact: false,
  proofs: 100,
};
it('binds only an immutable host-derived ARM64 job fixture to the registered source and host', () => {
  expect(verifyBackupJobFixtureImage(inspection, sourceCommit, sourceTree, hostImage)).toBe(fixtureImage);
  for (const field of [
    'org.opencontainers.image.revision',
    'nanoclaw.source-tree',
    'nanoclaw.tested-host',
    'nanoclaw.release-role',
    'nanoclaw.final-artifact',
  ]) {
    const changed = structuredClone(inspection);
    changed[0].Config.Labels[field] = 'wrong';
    expect(() => verifyBackupJobFixtureImage(changed, sourceCommit, sourceTree, hostImage)).toThrow(
      'backup_job_fixture_identity_mismatch',
    );
  }
});
it('requires actual manager lifecycle and default-entry refusal without claiming installed authority', () => {
  expect(verifyBackupJobFixtureEvidence([binding, scope, probe], identity)).toEqual({
    status: 'passed',
    cases: 7,
    scope: 'immutable_host_local_user_manager',
    installedAcceptance: false,
  });
});
it.each(['G02', 'G03', 'G04', 'G05', 'G06'] as const)(
  'requires the actual selected %s lifecycle and exact schema in immutable manager evidence',
  (releaseSlice) => {
    const selected = { ...identity, releaseSlice },
      rows = [
        { ...binding, releaseSlice },
        scope,
        {
          ...probe,
          releaseSlice,
          contract:
            releaseSlice === 'G06'
              ? 'cos-backup-job-release-fixture/v4'
              : releaseSlice === 'G05'
                ? 'cos-backup-job-release-fixture/v3'
                : probe.contract,
          schemaVersion: releaseSlice === 'G06' ? 21 : releaseSlice === 'G05' ? 20 : releaseSlice === 'G04' ? 19 : 18,
          actualG03ToG04Upgrade: releaseSlice === 'G04',
          ...(releaseSlice === 'G05' ? { actualG04ToG05Upgrade: true } : {}),
          ...(releaseSlice === 'G06' ? { actualG05ToG06Upgrade: true } : {}),
          cases: ['G04', 'G05', 'G06'].includes(releaseSlice) ? 8 : 7,
        },
      ];
    expect(verifyBackupJobFixtureEvidence(rows, selected)).toMatchObject({
      status: 'passed',
      cases: ['G04', 'G05', 'G06'].includes(releaseSlice) ? 8 : 7,
    });
    for (const change of [
      { releaseSlice: 'G02' },
      { schemaVersion: 18 },
      releaseSlice === 'G06'
        ? { actualG05ToG06Upgrade: false }
        : releaseSlice === 'G05'
          ? { actualG04ToG05Upgrade: false }
          : { actualG03ToG04Upgrade: false },
      { cases: 7 },
    ])
      if (['G04', 'G05', 'G06'].includes(releaseSlice)) {
        expect(() => verifyBackupJobFixtureEvidence([rows[0], scope, { ...rows[2], ...change }], selected)).toThrow(
          'backup_job_fixture_evidence_unavailable',
        );
      }
    expect(() =>
      verifyBackupJobFixtureEvidence([{ ...binding, releaseSlice: 'foreign' }, scope, rows[2]], selected),
    ).toThrow();
  },
);
it.each([
  'actualUserManager',
  'actualStaticCompiler',
  'actualTimerActivation',
  'actualTimerStop',
  'idempotentFiles',
  'withdrawnScopeDenied',
  'compiledProductionInstallerAndAdapter',
  'actualScheduledEntryFailsClosed',
  'unrelatedUnitPreserved',
])('refuses missing %s coverage', (field) => {
  expect(() => verifyBackupJobFixtureEvidence([binding, scope, { ...probe, [field]: false }], identity)).toThrow(
    'backup_job_fixture_evidence_unavailable',
  );
});
it.each([
  'source',
  'tree',
  'host',
  'fixture',
  'host-mount',
  'external-network',
  'shared-cgroup',
  'swap',
  'core',
  'duplicate',
  'secret-field',
  'installed-claim',
])('refuses %s evidence', (reason) => {
  let records: unknown[] = [structuredClone(binding), structuredClone(scope), structuredClone(probe)];
  if (reason === 'source') Object.assign(records[0]!, { sourceCommit: 'e'.repeat(40) });
  if (reason === 'tree') Object.assign(records[2]!, { sealedSourceTree: 'f'.repeat(40) });
  if (reason === 'host') Object.assign(records[0]!, { testedHost: 'sha256:' + 'e'.repeat(64) });
  if (reason === 'fixture') Object.assign(records[0]!, { jobFixtureImage: 'mutable-tag' });
  if (reason === 'host-mount') Object.assign(records[1]!, { Binds: ['/private:/private'] });
  if (reason === 'external-network') Object.assign(records[1]!, { NetworkMode: 'bridge' });
  if (reason === 'shared-cgroup') Object.assign(records[1]!, { CgroupnsMode: 'host' });
  if (reason === 'swap') Object.assign(records[1]!, { MemorySwap: -1 });
  if (reason === 'core') Object.assign(records[1]!, { Ulimits: [] });
  if (reason === 'duplicate') records = [...records, probe];
  if (reason === 'secret-field') Object.assign(records[2]!, { password: 'must-reject' });
  if (reason === 'installed-claim') Object.assign(records[2]!, { installedOwnerCommandAcceptance: true });
  expect(() => verifyBackupJobFixtureEvidence(records, identity)).toThrow('backup_job_fixture_evidence_unavailable');
});
