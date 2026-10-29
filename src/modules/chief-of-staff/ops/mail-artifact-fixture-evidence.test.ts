import fs from 'node:fs';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  MAIL_STORE_CASES,
  MAIL_CHECKPOINT_CASES,
  MAIL_NATIVE_CASES,
} from '../../../contracts/chief-of-staff/mail-fixture-report.js';
import {
  MAIL_DRAFT_DATABASE_CASES,
  MAIL_DRAFT_NATIVE_CASES,
} from '../../../contracts/chief-of-staff/mail-draft-fixture-report.js';
import {
  MAIL_REVIEW_SCHEMA_RESULTS,
  MAIL_REVIEW_NATIVE_CASES,
} from '../../../contracts/chief-of-staff/mail-review-fixture-report.js';
import {
  verifyMailArtifactFixtureEvidence,
  mailArtifactFixtureCertificate,
  verifyMailReleaseEvidence,
  readMailArtifactFixtureText,
  readMailCredentialFixtureText,
  readMailRecoveryFixtureText,
  verifyMailDraftArtifactFixtureEvidence,
  verifyMailDraftReleaseEvidence,
  readMailDraftArtifactFixtureText,
  readMailDraftCredentialFixtureText,
  readMailDraftRecoveryFixtureText,
  readMailReviewArtifactFixtureText,
  verifyMailReviewReleaseEvidence,
  verifyMailReviewArtifactFixtureEvidence,
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
const volume = 'cos-g04-mail-aaaaaaaa-10000000-0000-4000-8000-000000000001';
function fixture(drafts: boolean | 'review' = false) {
  const review = drafts === 'review';
  const caseVolume = review
      ? volume.replace('g04-mail', 'g06-review')
      : drafts
        ? volume.replace('g04-mail', 'g05-draft')
        : volume,
    caseRoot = '/var/lib/docker/volumes/' + caseVolume + '/_data',
    contract = review ? 'cos-g06-review' : drafts ? 'cos-g05-draft' : 'cos-g04-mail';
  const header = {
    contract: contract + '-artifact-set/v1',
    sourceCommit: identity.sourceCommit,
    sourceTree: identity.sourceTree,
    workerAssetsDigest: identity.workerAssetsDigest,
    hostImage: identity.hostImage,
    workerImages: identity.workerImages,
    fixtureVolume: caseVolume,
    fixtureRoot: caseRoot,
  };
  const runs = [null, ...identity.workerImages].map((worker) => {
    const suite = worker ? 'native' : 'database',
      declarations = [
        { Type: 'bind', Source: identity.certificateFile, Target: '/fixture/ca.pem', ReadOnly: true },
        {
          Type: 'volume',
          Source: caseVolume,
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
          Name: caseVolume,
          Source: caseRoot,
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
      contract: contract + '-container-scope/v1',
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
      contract: contract + '-host-run/v1',
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
    const names: readonly string[] = review
        ? worker
          ? MAIL_REVIEW_NATIVE_CASES
          : []
        : drafts
          ? worker
            ? MAIL_DRAFT_NATIVE_CASES
            : MAIL_DRAFT_DATABASE_CASES
          : worker
            ? MAIL_NATIVE_CASES
            : [...MAIL_STORE_CASES, ...MAIL_CHECKPOINT_CASES],
      count = review && !worker ? 32 : names.length;
    const report = [
      'TAP version 13',
      ...(review && !worker
        ? MAIL_REVIEW_SCHEMA_RESULTS.map(([depth, id, name]) => ' '.repeat(depth) + `ok ${id} - ${name}`)
        : names.map((name, i) => `ok ${i + 1} - ${name}`)),
      ...(review && !worker ? ['        1..21', '    1..9', '1..2'] : [`1..${count}`]),
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
it('requires the distinct G06 sealed database report and both actual worker conversations for all review gates', () => {
  const text = serialize(fixture('review'));
  expect(verifyMailReviewArtifactFixtureEvidence(text, identity)).toMatchObject({
    status: 'passed',
    actualDatabaseCases: 32,
    actualNativeRuns: 2,
  });
  for (const gate of ['mail_review_policy', 'mail_review_schedule', 'mail_review_flow'])
    expect(verifyMailReviewReleaseEvidence(gate, text, identity)).toMatchObject({ status: 'passed' });
  expect(() => verifyMailReviewArtifactFixtureEvidence(serialize(fixture(true)), identity)).toThrow(
    'mail_review_artifact_release_evidence_unavailable',
  );
  expect(() => verifyMailReviewReleaseEvidence('mail_sending', text, identity)).toThrow(
    'mail_review_release_check_unavailable',
  );
});
it.each([
  'source',
  'worker',
  'missing-worker',
  'override',
  'scope',
  'certificate',
  'volume',
  'database-report',
  'native-report',
  'credentials',
  'foreign-mode',
] as const)('rejects %s G06 sealed review evidence', (reason) => {
  const f = fixture('review'),
    run = f.runs[0];
  if (reason === 'source') f.header.sourceCommit = 'f'.repeat(40);
  if (reason === 'worker') f.runs[1].binding.workerImage = identity.hostImage;
  if (reason === 'missing-worker') f.runs.pop();
  if (reason === 'override') f.runs[1].binding.workerSourceOverrides = true;
  if (reason === 'scope') run.scope.host.Privileged = true;
  if (reason === 'certificate') run.scope.host.Mounts[0].Source = '/foreign/ca.pem';
  if (reason === 'volume') run.scope.mounts[1].Source = '/foreign';
  if (reason === 'database-report') run.report = fixture(true).runs[0].report;
  if (reason === 'native-report') f.runs[1].report = fixture(true).runs[1].report;
  if (reason === 'credentials') run.binding.ownerCredentialsUsed = true;
  if (reason === 'foreign-mode') f.header.contract = 'cos-g05-draft-artifact-set/v1';
  expect(() => verifyMailReviewArtifactFixtureEvidence(serialize(f), identity)).toThrow(
    'mail_review_artifact_release_evidence_unavailable',
  );
});
it('keeps the G06 private artifact report distinct from inherited reader and draft reports', () => {
  const f = privateReport(),
    file = f.root + '/mail_review_artifacts.log';
  fs.renameSync(f.file, file);
  expect(readMailReviewArtifactFixtureText(file)).toBe(f.text);
  expect(() => readMailDraftArtifactFixtureText(file)).toThrow();
  expect(() => readMailArtifactFixtureText(file)).toThrow();
  fs.chmodSync(file, 0o644);
  expect(() => readMailReviewArtifactFixtureText(file)).toThrow();
});
it('binds G05 policy, transport and reconciliation to the complete sealed host/two-worker execution', () => {
  const text = serialize(fixture(true));
  expect(verifyMailDraftArtifactFixtureEvidence(text, identity)).toMatchObject({
    status: 'passed',
    actualDatabaseCases: 18,
    actualNativeRuns: 2,
    sourceOverrides: false,
    installedAcceptance: false,
  });
  for (const gate of ['draft_policy', 'draft_transport', 'draft_reconciliation'])
    expect(verifyMailDraftReleaseEvidence(gate, text, identity)).toMatchObject({ status: 'passed' });
  expect(() => verifyMailDraftArtifactFixtureEvidence(serialize(fixture()), identity)).toThrow(
    'mail_draft_artifact_release_evidence_unavailable',
  );
  expect(() => verifyMailArtifactFixtureEvidence(text, identity)).toThrow('mail_artifact_release_evidence_unavailable');
});
it.each([
  'source',
  'worker',
  'missing-worker',
  'override',
  'scope',
  'certificate',
  'volume',
  'database-report',
  'native-report',
  'credentials',
  'foreign-mode',
] as const)('rejects %s as G05 artifact evidence', (reason) => {
  const f = fixture(true),
    run = f.runs[0];
  if (reason === 'source') f.header.sourceCommit = 'f'.repeat(40);
  if (reason === 'worker') f.runs[1].binding.workerImage = identity.hostImage;
  if (reason === 'missing-worker') f.runs.pop();
  if (reason === 'override') f.runs[1].binding.workerSourceOverrides = true;
  if (reason === 'scope') run.scope.host.Privileged = true;
  if (reason === 'certificate') run.scope.host.Mounts[0].Source = '/foreign/ca.pem';
  if (reason === 'volume') run.scope.mounts[1].Source = '/foreign';
  if (reason === 'database-report') run.report = fixture().runs[0].report;
  if (reason === 'native-report') f.runs[1].report = fixture().runs[1].report;
  if (reason === 'credentials') run.binding.ownerCredentialsUsed = true;
  if (reason === 'foreign-mode') f.header.contract = 'cos-g04-mail-artifact-set/v1';
  expect(() => verifyMailDraftArtifactFixtureEvidence(serialize(f), identity)).toThrow(
    'mail_draft_artifact_release_evidence_unavailable',
  );
});
it('requires its own bounded private G05 artifact log filename', () => {
  const f = privateReport(),
    file = f.root + '/draft_artifacts.log';
  fs.renameSync(f.file, file);
  expect(readMailDraftArtifactFixtureText(file)).toBe(f.text);
  expect(() => readMailArtifactFixtureText(file)).toThrow();
  expect(() => readMailDraftArtifactFixtureText(f.root + '/mail_artifacts.log')).toThrow();
});
function privateReport() {
  const root = fs.mkdtempSync(os.tmpdir() + '/cos-mail-evidence-');
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const file = root + '/mail_artifacts.log',
    text = serialize(fixture());
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { root, file, text };
}
it.each([
  ['draft_credentials.log', readMailDraftCredentialFixtureText],
  ['draft_recovery.log', readMailDraftRecoveryFixtureText],
] as const)('keeps %s private and distinct from the reader and artifact reports', (name, read) => {
  const f = privateReport(),
    file = f.root + '/' + name;
  fs.renameSync(f.file, file);
  expect(read(file)).toBe(f.text);
  expect(() => readMailArtifactFixtureText(file)).toThrow();
  expect(() => readMailCredentialFixtureText(file)).toThrow();
  expect(() => readMailRecoveryFixtureText(file)).toThrow();
  fs.linkSync(file, file + '.alias');
  expect(() => read(file)).toThrow();
});
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
it('admits only the distinct private canonical recovery report, refusing a shared or linked replacement', () => {
  const f = privateReport(),
    file = f.root + '/mail_recovery.log';
  fs.renameSync(f.file, file);
  expect(readMailRecoveryFixtureText(file)).toBe(f.text);
  expect(() => readMailCredentialFixtureText(file)).toThrow();
  expect(() => readMailRecoveryFixtureText(f.root + '/mail_credentials.log')).toThrow();
  fs.linkSync(file, file + '.alias');
  expect(() => readMailRecoveryFixtureText(file)).toThrow();
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
it.each(['/Users/fixture/project/.cos-plan-state', '/host_mnt/Users/fixture/project/.cos-plan-state'])(
  'maps an independently registered private state bind for an isolated source workspace: %s',
  (source) => {
    expect(mailArtifactFixtureCertificate([{ Mounts: [
      { Type: 'bind', Source: source, Destination: '/workspace/.cos-plan-state', RW: true },
    ] }], 'release-aaaaaaaaaaaa-20261016000000')).toBe(
      '/Users/fixture/project/.cos-plan-state/release-tests/release-aaaaaaaaaaaa-20261016000000/ca.pem',
    );
  },
);
it('uses the overlaid private-state bind instead of the source workspace path', () => {
  expect(mailArtifactFixtureCertificate([{ Mounts: [
    { Type: 'bind', Source: '/Users/fixture/source', Destination: '/workspace', RW: true },
    { Type: 'bind', Source: '/Users/fixture/primary/.cos-plan-state', Destination: '/workspace/.cos-plan-state', RW: true },
  ] }], 'release-aaaaaaaaaaaa-20261016000000')).toContain('/Users/fixture/primary/.cos-plan-state/');
});
it.each(['duplicate', 'volume', 'readonly', 'relative', 'parent', 'root', 'wrong-directory', 'unknown-host-mount'])(
  'does not fall back to the workspace when its private-state bind is invalid: %s', (reason) => {
    const state = { Type: 'bind', Source: '/Users/fixture/project/.cos-plan-state', Destination: '/workspace/.cos-plan-state', RW: true },
      mounts = [{ Type: 'bind', Source: '/Users/fixture/other', Destination: '/workspace', RW: true }, state];
    if (reason === 'duplicate') mounts.push({ ...state });
    if (reason === 'volume') state.Type = 'volume';
    if (reason === 'readonly') state.RW = false;
    if (reason === 'relative') state.Source = '.cos-plan-state';
    if (reason === 'parent') state.Source = '/Users/fixture/../other/.cos-plan-state';
    if (reason === 'root') state.Source = '/';
    if (reason === 'wrong-directory') state.Source = '/Users/fixture/project/other';
    if (reason === 'unknown-host-mount') state.Source = '/host_mnt/private/fixture/.cos-plan-state';
    expect(() => mailArtifactFixtureCertificate([{ Mounts: mounts }], 'release-aaaaaaaaaaaa-20261016000000'))
      .toThrow('mail_fixture_workspace_unverified');
  },
);
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
    actualDatabaseCases: MAIL_STORE_CASES.length + MAIL_CHECKPOINT_CASES.length,
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
  if (reason === 'missing-case')
    run.report = run.report.replace(
      new RegExp(`^ok ${MAIL_STORE_CASES.length + MAIL_CHECKPOINT_CASES.length} - .*\\n`, 'm'),
      '',
    );
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
