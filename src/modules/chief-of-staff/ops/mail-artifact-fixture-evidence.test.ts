import fs from 'node:fs';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  MAIL_STORE_CASES,
  MAIL_CHECKPOINT_CASES,
  MAIL_NATIVE_CASES,
} from '../../../contracts/chief-of-staff/mail-fixture-report.js';
import {
  verifyMailArtifactFixtureEvidence,
  mailArtifactFixtureCertificate,
  verifyMailReleaseEvidence,
  readMailArtifactFixtureText,
  readMailCredentialFixtureText,
} from './mail-artifact-fixture-evidence.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const identity = {
  sourceCommit: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  workerAssetsDigest: 'c'.repeat(64),
  hostImage: 'sha256:' + 'd'.repeat(64),
  workerImages: ['sha256:' + 'e'.repeat(64), 'sha256:' + 'f'.repeat(64)],
  certificateFile: '/private/mail-test/ca.pem',
};
const volume = 'cos-g04-mail-aaaaaaaa-10000000-0000-4000-8000-000000000001',
  fixtureRoot = '/var/lib/docker/volumes/' + volume + '/_data';
function fixture() {
  const header = {
    contract: 'cos-g04-mail-artifact-set/v1',
    sourceCommit: identity.sourceCommit,
    sourceTree: identity.sourceTree,
    workerAssetsDigest: identity.workerAssetsDigest,
    hostImage: identity.hostImage,
    workerImages: identity.workerImages,
    fixtureVolume: volume,
    fixtureRoot,
  };
  const runs = [null, ...identity.workerImages].map((worker) => {
    const suite = worker ? 'native' : 'database',
      declarations = [
        { Type: 'bind', Source: identity.certificateFile, Target: '/fixture/ca.pem', ReadOnly: true },
        {
          Type: 'volume',
          Source: volume,
          Target: '/release/.cos-plan-state',
          VolumeOptions: { Subpath: '.cos-plan-state', DriverConfig: {} },
        },
        ...(worker
          ? [{ Type: 'bind', Source: '/run/host-services/docker.proxy.sock', Target: '/var/run/docker.sock' }]
          : []),
      ],
      mounts = [
        {
          Type: 'bind',
          Source: identity.certificateFile,
          Destination: '/fixture/ca.pem',
          RW: false,
          Propagation: 'rprivate',
        },
        {
          Type: 'volume',
          Name: volume,
          Source: fixtureRoot,
          Destination: '/release/.cos-plan-state',
          Driver: 'local',
          RW: true,
          Propagation: '',
        },
        ...(worker
          ? [
              {
                Type: 'bind',
                Source: '/run/host-services/docker.proxy.sock',
                Destination: '/var/run/docker.sock',
                RW: true,
                Propagation: 'rprivate',
              },
            ]
          : []),
      ];
    const scope = {
      contract: 'cos-g04-mail-container-scope/v1',
      image: identity.hostImage,
      user: '1000:1000',
      workingDirectory: '/release',
      host: {
        NetworkMode: 'bridge',
        Privileged: false,
        ReadonlyRootfs: true,
        CapAdd: null,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Binds: null,
        Mounts: declarations,
        Devices: [],
        DeviceRequests: null,
        DeviceCgroupRules: null,
        Links: null,
        VolumesFrom: null,
        PortBindings: {},
        PublishAllPorts: false,
        Memory: 1024 ** 3,
        MemorySwap: 1024 ** 3,
        PidsLimit: 256,
        GroupAdd: worker ? ['0'] : null,
        Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=128m,mode=700,uid=1000,gid=1000' },
        IpcMode: 'private',
        PidMode: '',
        UTSMode: '',
        UsernsMode: '',
        CgroupnsMode: 'private',
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      },
      mounts,
    };
    const binding = {
      contract: 'cos-g04-mail-host-run/v1',
      suite,
      hostImage: identity.hostImage,
      workerImage: worker,
      sourceCommit: identity.sourceCommit,
      sourceTree: identity.sourceTree,
      workerAssetsDigest: identity.workerAssetsDigest,
      actualRuntime: true,
      actualNativeSqlite: true,
      actualMemoryProtection: true,
      compiledProductionPayload: true,
      databaseProfile: 'test',
      databaseTls: 'verify-full',
      sourceOverrides: false,
      workerSourceOverrides: false,
      ownerCredentialsUsed: false,
      liveAccountAcceptance: false,
      installedAcceptance: false,
      storageAdmission: 'fixture',
    };
    const names: readonly string[] = worker ? MAIL_NATIVE_CASES : [...MAIL_STORE_CASES, ...MAIL_CHECKPOINT_CASES],
      count = names.length;
    const report = [
      'TAP version 13',
      ...names.map((name, i) => `ok ${i + 1} - ${name}`),
      `1..${count}`,
      `# tests ${count}`,
      '# suites 0',
      `# pass ${count}`,
      '# fail 0',
      '# cancelled 0',
      '# skipped 0',
      '# todo 0',
    ].join('\n');
    return { scope, binding, report };
  });
  return { header, runs };
}
const serialize = (f: ReturnType<typeof fixture>) =>
  [
    JSON.stringify(f.header),
    ...f.runs.flatMap((run) => [JSON.stringify(run.scope), JSON.stringify(run.binding), run.report]),
  ].join('\n');
function privateReport() {
  const root = fs.mkdtempSync(os.tmpdir() + '/cos-mail-evidence-');
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const file = root + '/mail_artifacts.log',
    text = serialize(fixture());
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { root, file, text };
}
it('reads only the private canonical bounded report used by the release coordinator', () => {
  const f = privateReport();
  expect(readMailArtifactFixtureText(f.file)).toBe(f.text);
});
it('keeps canonical credential and database report names separate under the same private file protections', () => {
  const f = privateReport(),
    credentials = f.root + '/mail_credentials.log';
  fs.renameSync(f.file, credentials);
  expect(readMailCredentialFixtureText(credentials)).toBe(f.text);
  expect(() => readMailArtifactFixtureText(credentials)).toThrow();
  expect(() => readMailCredentialFixtureText(f.root + '/mail_artifacts.log')).toThrow();
});
it.each(['symlink', 'hardlink', 'permissions', 'parent-permissions', 'invalid-utf8'])(
  'refuses %s credential report storage before the kernel consumer runs',
  (reason) => {
    const f = privateReport(),
      file = f.root + '/mail_credentials.log';
    fs.renameSync(f.file, file);
    if (reason === 'symlink') {
      fs.renameSync(file, file + '.held');
      fs.symlinkSync(file + '.held', file);
    }
    if (reason === 'hardlink') fs.linkSync(file, file + '.alias');
    if (reason === 'permissions') fs.chmodSync(file, 0o644);
    if (reason === 'parent-permissions') fs.chmodSync(f.root, 0o755);
    if (reason === 'invalid-utf8') fs.writeFileSync(file, Buffer.from([255]));
    expect(() => readMailCredentialFixtureText(file)).toThrow('mail_artifact_release_evidence_unavailable');
  },
);
it.each([
  'symlink',
  'hardlink',
  'permissions',
  'parent-permissions',
  'name',
  'missing',
  'empty',
  'oversize',
  'invalid-utf8',
])('refuses %s artifact report storage before accepting its data', (reason) => {
  const f = privateReport();
  let file = f.file;
  if (reason === 'symlink') {
    fs.renameSync(file, file + '.held');
    fs.symlinkSync(file + '.held', file);
  }
  if (reason === 'hardlink') fs.linkSync(file, file + '.alias');
  if (reason === 'permissions') fs.chmodSync(file, 0o644);
  if (reason === 'parent-permissions') fs.chmodSync(f.root, 0o755);
  if (reason === 'name') {
    fs.renameSync(file, f.root + '/other.log');
    file = f.root + '/other.log';
  }
  if (reason === 'missing') fs.unlinkSync(file);
  if (reason === 'empty') fs.truncateSync(file, 0);
  if (reason === 'oversize') fs.truncateSync(file, 2 * 1024 ** 2 + 1);
  if (reason === 'invalid-utf8') fs.writeFileSync(file, Buffer.from([255]));
  expect(() => readMailArtifactFixtureText(file)).toThrow('mail_artifact_release_evidence_unavailable');
});
it('maps the registered Mac workspace to this release CA without reading inspection environment values', () => {
  const rid = 'release-aaaaaaaaaaaa-20261016000000';
  expect(
    mailArtifactFixtureCertificate(
      [{ Mounts: [{ Type: 'bind', Source: '/Users/fixture/project', Destination: '/workspace', RW: true }] }],
      rid,
    ),
  ).toBe('/Users/fixture/project/.cos-plan-state/release-tests/' + rid + '/ca.pem');
});
it('maps the observed Docker Desktop host_mnt Users prefix to the same Mac certificate path', () => {
  expect(
    mailArtifactFixtureCertificate(
      [{ Mounts: [{ Type: 'bind', Source: '/host_mnt/Users/fixture/project', Destination: '/workspace', RW: true }] }],
      'release-aaaaaaaaaaaa-20261016000000',
    ),
  ).toBe('/Users/fixture/project/.cos-plan-state/release-tests/release-aaaaaaaaaaaa-20261016000000/ca.pem');
});
it.each([
  'missing',
  'duplicate',
  'volume',
  'readonly',
  'relative',
  'parent',
  'root',
  'release',
  'extra-inspection',
  'unknown-host-mount',
])('refuses %s Mac workspace mapping instead of substituting a different CA', (reason) => {
  const mount = { Type: 'bind', Source: '/Users/fixture/project', Destination: '/workspace', RW: true },
    inspected = [{ Mounts: [mount] }];
  if (reason === 'missing') inspected[0].Mounts = [];
  if (reason === 'duplicate') inspected[0].Mounts.push({ ...mount });
  if (reason === 'volume') mount.Type = 'volume';
  if (reason === 'readonly') mount.RW = false;
  if (reason === 'relative') mount.Source = 'relative';
  if (reason === 'parent') mount.Source = '/Users/fixture/../foreign';
  if (reason === 'root') mount.Source = '/';
  if (reason === 'unknown-host-mount') mount.Source = '/host_mnt/private/foreign';
  if (reason === 'extra-inspection') inspected.push({ Mounts: [] });
  expect(() =>
    mailArtifactFixtureCertificate(
      inspected,
      reason === 'release' ? '../foreign' : 'release-aaaaaaaaaaaa-20261016000000',
    ),
  ).toThrow('mail_fixture_workspace_unverified');
});
it.each(['mail_capture', 'mail_evidence', 'mail_retention'])('requires complete artifact proof for %s', (gate) => {
  expect(verifyMailReleaseEvidence(gate, serialize(fixture()), identity)).toMatchObject({
    status: 'passed',
    actualNativeRuns: 2,
  });
  expect(() => verifyMailReleaseEvidence(gate, 'status 0', identity)).toThrow(
    'mail_artifact_release_evidence_unavailable',
  );
});
it.each(['mail_credentials', 'mail_recovery'])(
  'does not substitute artifact database reports for mandatory kernel proof in %s',
  (gate) => {
    expect(() => verifyMailReleaseEvidence(gate, serialize(fixture()), identity)).toThrow(
      'mail_kernel_release_evidence_required',
    );
  },
);
it('rejects unsupported mail checks before interpreting their report', () => {
  expect(() => verifyMailReleaseEvidence('mail_sending', 'status 0', identity)).toThrow(
    'mail_release_check_unavailable',
  );
});
it('requires the complete immutable host database run and both actual worker conversations', () => {
  expect(verifyMailArtifactFixtureEvidence(serialize(fixture()), identity)).toEqual({
    status: 'passed',
    actualDatabaseCases: 45,
    actualNativeRuns: 2,
    sourceOverrides: false,
    installedAcceptance: false,
  });
});
it.each([
  'source',
  'tree',
  'assets',
  'host',
  'workers',
  'volume',
  'root',
  'extra-header',
  'missing-run',
  'duplicate-worker',
  'missing-case',
  'skipped',
  'different-suite',
  'source-override',
  'worker-override',
  'runtime-profile',
  'tls',
  'live',
  'memory-proof',
  'payload-proof',
  'binding-host',
  'binding-source',
  'root-user',
  'workdir',
  'actual-image',
  'privileged',
  'network',
  'cap-add',
  'cap-drop',
  'security',
  'swap',
  'core',
  'tmpfs',
  'pids',
  'host-pid',
  'host-ipc',
  'host-uts',
  'host-userns',
  'host-cgroupns',
  'extra-bind',
  'extra-mount',
  'extra-volume',
  'changed-cert',
  'writable-cert',
  'changed-volume',
  'changed-subpath',
  'volume-driver',
  'actual-volume',
  'socket-source',
  'socket-in-database',
  'group',
  'devices',
  'ports',
  'restart',
  'empty',
  'oversize',
  'non-text',
])('refuses %s artifact evidence', (reason) => {
  const f = fixture(),
    run = f.runs[0],
    native = f.runs[1],
    h = run.scope.host;
  if (reason === 'source') f.header.sourceCommit = '1'.repeat(40);
  if (reason === 'tree') f.header.sourceTree = '1'.repeat(40);
  if (reason === 'assets') f.header.workerAssetsDigest = '1'.repeat(64);
  if (reason === 'host') f.header.hostImage = identity.workerImages[0];
  if (reason === 'workers') f.header.workerImages = [...f.header.workerImages].reverse();
  if (reason === 'volume') f.header.fixtureVolume = 'other-volume';
  if (reason === 'root') f.header.fixtureRoot = '/protected';
  if (reason === 'extra-header') Object.assign(f.header, { ownerApproval: true });
  if (reason === 'missing-run') f.runs.pop();
  if (reason === 'duplicate-worker') f.runs[2].binding.workerImage = native.binding.workerImage;
  if (reason === 'missing-case') run.report = run.report.replace(/^ok 45 - .*\n/m, '');
  if (reason === 'skipped') native.report += '\n# skipped 1';
  if (reason === 'different-suite') run.binding.suite = 'all';
  if (reason === 'source-override') run.binding.sourceOverrides = true;
  if (reason === 'worker-override') run.binding.workerSourceOverrides = true;
  if (reason === 'runtime-profile') run.binding.databaseProfile = 'runtime-disposable';
  if (reason === 'tls') run.binding.databaseTls = 'disable';
  if (reason === 'live') run.binding.liveAccountAcceptance = true;
  if (reason === 'memory-proof') run.binding.actualMemoryProtection = false;
  if (reason === 'payload-proof') run.binding.compiledProductionPayload = false;
  if (reason === 'binding-host') run.binding.hostImage = identity.workerImages[0];
  if (reason === 'binding-source') run.binding.sourceCommit = '1'.repeat(40);
  if (reason === 'root-user') run.scope.user = '0:0';
  if (reason === 'workdir') run.scope.workingDirectory = '/workspace';
  if (reason === 'actual-image') run.scope.image = identity.workerImages[0];
  if (reason === 'privileged') h.Privileged = true;
  if (reason === 'network') h.NetworkMode = 'host';
  if (reason === 'cap-add') Object.assign(h, { CapAdd: ['SYS_ADMIN'] });
  if (reason === 'cap-drop') h.CapDrop = [];
  if (reason === 'security') h.SecurityOpt = [];
  if (reason === 'swap') h.MemorySwap *= 2;
  if (reason === 'core') h.Ulimits[0].Hard = -1;
  if (reason === 'tmpfs') h.Tmpfs['/tmp'] = 'rw';
  if (reason === 'pids') h.PidsLimit = -1;
  if (reason === 'host-pid') h.PidMode = 'host';
  if (reason === 'host-ipc') h.IpcMode = 'host';
  if (reason === 'host-uts') h.UTSMode = 'host';
  if (reason === 'host-userns') h.UsernsMode = 'host';
  if (reason === 'host-cgroupns') h.CgroupnsMode = 'host';
  if (reason === 'extra-bind') Object.assign(h, { Binds: ['/protected:/workspace'] });
  if (reason === 'extra-mount')
    run.scope.mounts.push({ ...run.scope.mounts[0], Source: '/protected', Destination: '/workspace' });
  if (reason === 'extra-volume') h.Mounts.push({ ...h.Mounts[0], Source: 'foreign', Target: '/workspace' });
  if (reason === 'changed-cert') h.Mounts[0].Source = '/private/foreign/ca.pem';
  if (reason === 'writable-cert') h.Mounts[0].ReadOnly = false;
  if (reason === 'changed-volume') h.Mounts[1].Source = 'foreign';
  if (reason === 'changed-subpath') h.Mounts[1].VolumeOptions!.Subpath = '.';
  if (reason === 'volume-driver') Object.assign(h.Mounts[1].VolumeOptions!.DriverConfig, { Name: 'remote' });
  if (reason === 'actual-volume') run.scope.mounts[1].Source = '/protected';
  if (reason === 'socket-source') native.scope.host.Mounts[2].Source = '/protected/socket';
  if (reason === 'socket-in-database') h.Mounts.push(native.scope.host.Mounts[2]);
  if (reason === 'group') h.GroupAdd = ['0'];
  if (reason === 'devices') Object.assign(h, { Devices: [{ PathOnHost: '/dev/sda' }] });
  if (reason === 'ports') Object.assign(h.PortBindings, { '80/tcp': [{ HostPort: '80' }] });
  if (reason === 'restart') h.RestartPolicy.Name = 'always';
  let text = serialize(f);
  if (reason === 'empty') text = '';
  if (reason === 'oversize') text += 'x'.repeat(2 * 1024 ** 2);
  if (reason === 'non-text') text = undefined as never;
  expect(() => verifyMailArtifactFixtureEvidence(text, identity)).toThrow('mail_artifact_release_evidence_unavailable');
});
