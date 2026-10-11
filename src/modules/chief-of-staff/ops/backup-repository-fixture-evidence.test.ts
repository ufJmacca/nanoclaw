import { expect, it } from 'vitest';
import { BACKUP_REPOSITORY_CASES } from '../../../contracts/chief-of-staff/backup-repository-report.js';
import { verifyBackupRepositoryFixtureEvidence } from './backup-repository-fixture-evidence.js';
const identity = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), hostImage: 'sha256:' + 'c'.repeat(64) };
const fixture = () => ({
  binding: {
    contract: 'cos-g02-backup-repository-host/v1',
    ...identity,
    actualRuntime: true,
    actualPinnedPayload: true,
    actualNativeSqlite: true,
    sourceOverrides: false,
    ownerCredentialsUsed: false,
    databaseCredentialsUsed: false,
    liveNasAcceptance: false,
    vaultAndNasAdmission: 'fixture',
    installedAcceptance: false,
  },
  scope: {
    NetworkMode: 'none',
    Privileged: false,
    ReadonlyRootfs: true,
    CapAdd: null,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    Binds: null,
    Mounts: null,
    Devices: [],
    DeviceRequests: null,
    Links: null,
    VolumesFrom: null,
    PortBindings: {},
    Memory: 768 * 1024 ** 2,
    MemorySwap: 768 * 1024 ** 2,
    PidsLimit: 128,
    Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
    Tmpfs: { '/tmp': 'rw,nosuid,nodev,exec,size=256m,mode=700,uid=1000,gid=1000' },
  },
  report: [
    'TAP version 13',
    ...BACKUP_REPOSITORY_CASES.map((title, index) => `ok ${index + 1} - ${title}`),
    '1..45',
    '# tests 45',
    '# suites 0',
    '# pass 45',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ].join('\n'),
});
const serialize = (value: ReturnType<typeof fixture>) =>
  JSON.stringify(value.binding) + '\n' + JSON.stringify(value.scope) + '\n' + value.report;
it('binds all three repository gates to one complete actual host run without claiming installed acceptance', () => {
  expect(verifyBackupRepositoryFixtureEvidence(serialize(fixture()), identity)).toEqual({
    status: 'passed',
    actualRepositoryCases: 45,
    gates: ['backup_transfer', 'backup_retention', 'backup_recovery'],
    installedAcceptance: false,
  });
});
it.each([
  'host',
  'source',
  'tree',
  'empty-runtime',
  'owner',
  'database',
  'live-nas',
  'installed',
  'network',
  'mount',
  'privilege',
  'swap',
  'capability',
  'ram',
  'ram-noexec',
  'skip',
])('refuses %s repository fixture evidence', (change) => {
  const value = fixture();
  if (change === 'host') value.binding.hostImage = 'candidate:latest';
  if (change === 'source') value.binding.sourceCommit = 'd'.repeat(40);
  if (change === 'tree') value.binding.sourceTree = 'd'.repeat(40);
  if (change === 'empty-runtime') value.binding.actualRuntime = false;
  if (change === 'owner') value.binding.ownerCredentialsUsed = true;
  if (change === 'database') value.binding.databaseCredentialsUsed = true;
  if (change === 'live-nas') value.binding.liveNasAcceptance = true;
  if (change === 'installed') value.binding.installedAcceptance = true;
  if (change === 'network') value.scope.NetworkMode = 'host';
  if (change === 'mount') Object.assign(value.scope, { Binds: ['/private:/secret'] });
  if (change === 'privilege') value.scope.Privileged = true;
  if (change === 'swap') value.scope.MemorySwap = -1;
  if (change === 'capability') Object.assign(value.scope, { CapAdd: ['ALL'] });
  if (change === 'ram') value.scope.Tmpfs['/tmp'] = 'rw,size=1g';
  if (change === 'ram-noexec') value.scope.Tmpfs['/tmp'] = value.scope.Tmpfs['/tmp'].replace(',exec,', ',');
  if (change === 'skip') value.report = value.report.replace('# skipped 0', '# skipped 1');
  expect(() => verifyBackupRepositoryFixtureEvidence(serialize(value), identity)).toThrow(
    'backup_repository_release_evidence_unavailable',
  );
});
