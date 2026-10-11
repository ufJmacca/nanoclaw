import { expect, it } from 'vitest';
import { verifyBackupSmbFixtureImages, verifyBackupSmbFixtureEvidence } from './backup-smb-fixture-evidence.js';

const identity = {
  sourceCommit: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  hostImage: 'sha256:' + 'c'.repeat(64),
  serverImage: 'sha256:' + 'd'.repeat(64),
  clientImage: 'sha256:' + 'e'.repeat(64),
};
const inspect = (role: 'server' | 'client') => [
  {
    Id: identity[(role + 'Image') as 'serverImage' | 'clientImage'],
    Os: 'linux',
    Architecture: 'arm64',
    Config: {
      Labels: {
        'org.opencontainers.image.revision': identity.sourceCommit,
        'nanoclaw.source-tree': identity.sourceTree,
        'nanoclaw.release-role': 'backup-smb-' + role + '-fixture',
        'nanoclaw.final-artifact': 'false',
        ...(role === 'client' ? { 'nanoclaw.tested-host': identity.hostImage } : {}),
      },
    },
  },
];
const records = () => [
  {
    serverImage: identity.serverImage,
    clientImage: identity.clientImage,
    testedHost: identity.hostImage,
    sourceCommit: identity.sourceCommit,
    sourceTree: identity.sourceTree,
    internalNetwork: true,
    hostPortsPublished: false,
    hostDataMounted: false,
    ownerCredentialsUsed: false,
  },
  {
    NetworkMode: 'cos-g02-smb-aaaaaaaa-123-network',
    Privileged: false,
    ReadonlyRootfs: true,
    CapAdd: [
      'CAP_CHOWN',
      'CAP_DAC_OVERRIDE',
      'CAP_DAC_READ_SEARCH',
      'CAP_FOWNER',
      'CAP_SETGID',
      'CAP_SETUID',
      'CAP_SYS_ADMIN',
    ],
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
    Tmpfs: {
      '/run/fixture': 'rw,nosuid,nodev,noexec,size=128m,mode=700',
      '/tmp': 'rw,nosuid,nodev,noexec,size=8m,mode=700,uid=1000,gid=1000',
      '/var/lib/nanoclaw-cos': 'rw,nosuid,nodev,noexec,size=8m,mode=711',
    },
  },
  {
    contract: 'cos-g02-signed-smb-fixture/v1',
    status: 'passed',
    cases: 8,
    actualKernelCifs: true,
    protocol: 'SMB2.1',
    signing: 'required',
    dedicatedNonAdminAccount: true,
    unrelatedShareDenied: true,
    actualPinnedRestic: true,
    actualEncryptedRepositoryV2: true,
    actualReadDataCheck: true,
    actualIsolatedRamRestore: true,
    releasedLeaseDenied: true,
    closedUnderlayDenied: true,
    compiledHostCode: true,
    ownerCredentialsUsed: false,
    liveNasAcceptance: false,
    capacityAcceptance: false,
    finalArtifact: false,
  },
  {
    contract: 'cos-g02-smb-ciphertext-inspection/v1',
    status: 'passed',
    snapshotFiles: 1,
    plaintextCanaryAbsent: true,
    deniedShareUnchanged: true,
  },
];
it('registers only the two source-bound ARM64 transport fixtures carrying the selected host', () => {
  expect(
    verifyBackupSmbFixtureImages(
      inspect('server'),
      inspect('client'),
      identity.sourceCommit,
      identity.sourceTree,
      identity.hostImage,
    ),
  ).toEqual({ serverImage: identity.serverImage, clientImage: identity.clientImage });
});
it.each(['source', 'tree', 'role', 'host', 'architecture', 'mutable', 'duplicate', 'extra'])(
  'refuses %s transport image identity drift',
  (change) => {
    const server = inspect('server'),
      client = inspect('client');
    if (change === 'source') server[0].Config.Labels['org.opencontainers.image.revision'] = 'f'.repeat(40);
    if (change === 'tree') client[0].Config.Labels['nanoclaw.source-tree'] = 'f'.repeat(40);
    if (change === 'role') server[0].Config.Labels['nanoclaw.release-role'] = 'host';
    if (change === 'host') client[0].Config.Labels['nanoclaw.tested-host'] = identity.serverImage;
    if (change === 'architecture') client[0].Architecture = 'amd64';
    if (change === 'mutable') client[0].Id = 'candidate:latest';
    if (change === 'duplicate') client[0].Id = server[0].Id;
    if (change === 'extra') server.push(server[0]);
    expect(() =>
      verifyBackupSmbFixtureImages(server, client, identity.sourceCommit, identity.sourceTree, identity.hostImage),
    ).toThrow('backup_smb_fixture_identity_mismatch');
  },
);
it('verifies all eight actual kernel transport cases and independent ciphertext inspection', () => {
  expect(verifyBackupSmbFixtureEvidence(records(), identity)).toEqual({
    status: 'passed',
    cases: 8,
    scope: 'immutable_host_signed_smb_transport',
    liveNasAcceptance: false,
    capacityAcceptance: false,
  });
});
it.each([
  'missing',
  'extra',
  'binding',
  'source',
  'identity',
  'host',
  'unsigned',
  'protocol',
  'skipped',
  'plaintext',
  'denied-share',
  'owner-credentials',
  'live-nas-claim',
  'capacity-claim',
  'privilege',
  'root-write',
  'host-network',
  'host-mount',
  'host-device',
  'extra-capability',
  'swap',
  'ports',
  'wrong-ram',
])('refuses %s transport evidence', (change) => {
  const rows: Record<string, unknown>[] = records(),
    selected = { ...identity };
  if (change === 'missing') rows.pop();
  if (change === 'extra') rows.push(rows[2]);
  if (change === 'binding') rows[0].serverImage = identity.hostImage;
  if (change === 'source') rows[0].sourceTree = 'f'.repeat(40);
  if (change === 'identity') selected.hostImage = 'candidate:latest';
  if (change === 'host') selected.clientImage = identity.hostImage;
  if (change === 'unsigned') rows[2].signing = 'optional';
  if (change === 'protocol') rows[2].protocol = 'SMB3';
  if (change === 'skipped') rows[2].cases = 7;
  if (change === 'plaintext') rows[3].plaintextCanaryAbsent = false;
  if (change === 'denied-share') rows[3].deniedShareUnchanged = false;
  if (change === 'owner-credentials') rows[2].ownerCredentialsUsed = true;
  if (change === 'live-nas-claim') rows[2].liveNasAcceptance = true;
  if (change === 'capacity-claim') rows[2].capacityAcceptance = true;
  if (change === 'privilege') rows[1].Privileged = true;
  if (change === 'root-write') rows[1].ReadonlyRootfs = false;
  if (change === 'host-network') rows[1].NetworkMode = 'host';
  if (change === 'host-mount') rows[1].Mounts = [{ Source: '/private', Target: '/secrets' }];
  if (change === 'host-device') rows[1].Devices = [{ PathOnHost: '/dev/disk3' }];
  if (change === 'extra-capability') rows[1].CapAdd = ['ALL'];
  if (change === 'swap') rows[1].MemorySwap = -1;
  if (change === 'ports') rows[1].PortBindings = { '445/tcp': [{}] };
  if (change === 'wrong-ram') rows[1].Tmpfs = { '/tmp': 'rw,size=1g' };
  expect(() => verifyBackupSmbFixtureEvidence(rows, selected)).toThrow('backup_smb_fixture_evidence_unavailable');
});
