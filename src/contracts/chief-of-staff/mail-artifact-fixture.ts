import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { safeHostEnvironment } from '../../host-environment.js';
import { selectedFixtureEnvironment } from './fixture-database.js';
import { verifyMailFixtureReport } from './mail-fixture-report.js';
import { verifyVaultMemory } from '../../modules/chief-of-staff/ops/vault-memory.js';
import { stopFixtureWorkers } from './fixture-workers.js';
type Selection = {
  suite: 'database' | 'native';
  hostImage: string;
  workerImage: string | null;
  sourceCommit: string;
  sourceTree: string;
  workerAssetsDigest: string;
};
export function parseMailArtifactFixtureArguments(args: string[]): Selection {
  const [suite, hostImage, workerImage, sourceCommit, sourceTree, workerAssetsDigest] = args,
    image = /^sha256:[a-f0-9]{64}$/;
  if (
    args.length !== 6 ||
    !['database', 'native'].includes(suite) ||
    !image.test(hostImage) ||
    (suite === 'database' ? workerImage !== '-' : !image.test(workerImage) || workerImage === hostImage) ||
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    !/^[a-f0-9]{40}$/.test(sourceTree) ||
    !/^[a-f0-9]{64}$/.test(workerAssetsDigest)
  )
    throw Error('mail_artifact_fixture_arguments');
  return {
    suite: suite as Selection['suite'],
    hostImage,
    workerImage: suite === 'native' ? workerImage : null,
    sourceCommit,
    sourceTree,
    workerAssetsDigest,
  };
}
/** This entry cannot run against checkout overrides or an owner profile. The
 * Mac driver independently observes the actual immutable image/container scope.
 * Its report is a fixture, with no live account or installed acceptance claim. */
export async function runMailArtifactFixture(args: string[]): Promise<void> {
  const selected = parseMailArtifactFixtureArguments(args),
    entry = '/release/dist/contracts/chief-of-staff/mail-artifact-fixture.js';
  if (
    fileURLToPath(import.meta.url) !== entry ||
    fs.realpathSync(entry) !== entry ||
    process.cwd() !== '/release' ||
    process.platform !== 'linux' ||
    process.arch !== 'arm64' ||
    process.version !== 'v22.23.2' ||
    process.getuid?.() !== 1000
  )
    throw Error('mail_fixture_requires_immutable_host');
  if (
    process.env.COS_FIXTURE_DATABASE_PROFILE !== 'test' ||
    process.env.COS_FIXTURE_RUNNER_VOLUME ||
    process.env.COS_FIXTURE_SOURCE_ROOT ||
    process.env.COS_FIXTURE_WORK_ROOT ||
    Object.keys(process.env).some((key) =>
      /^(?:COS_PG|COS_RUNTIME_|COS_GOOGLE_|COS_BACKUP_PASSWORD$|OPENAI_API_KEY$|MATTERMOST_BOT_TOKEN$)/.test(key),
    )
  )
    throw Error('mail_fixture_profile_unverified');
  const env = selectedFixtureEnvironment(process.env, true),
    source = JSON.parse(fs.readFileSync('/release/build-info.json', 'utf8'));
  if (
    env.COS_TEST_PGSSLMODE !== 'verify-full' ||
    env.COS_TEST_PGSSLROOTCERT !== '/fixture/ca.pem' ||
    source.commit !== selected.sourceCommit ||
    source.tree !== selected.sourceTree ||
    source.workerAssetsDigest !== selected.workerAssetsDigest
  )
    throw Error('mail_fixture_source_unverified');
  const fixtureRoot = process.env.COS_FIXTURE_HOST_ROOT,
    fixtureImage = process.env.COS_FIXTURE_IMAGE;
  if (
    selected.suite === 'native'
      ? !fixtureRoot ||
        !/^\/var\/lib\/docker\/volumes\/cos-g04-mail-[a-f0-9-]+\/_data$/.test(fixtureRoot) ||
        fixtureImage !== selected.workerImage
      : fixtureRoot !== undefined || fixtureImage !== undefined
  )
    throw Error('mail_fixture_worker_unverified');
  verifyVaultMemory();
  const db = new Database(':memory:');
  try {
    if ((db.prepare('SELECT 1 AS n').get() as { n: number }).n !== 1) throw Error('mail_fixture_sqlite_unavailable');
  } finally {
    db.close();
  }
  console.log(
    JSON.stringify({
      contract: 'cos-g04-mail-host-run/v1',
      ...selected,
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
    }),
  );
  const files =
    selected.suite === 'database'
      ? ['mail-store.integration', 'mail-checkpoint.integration']
      : ['mail-flow.integration'];
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      '--test-concurrency=1',
      ...files.map((name) => '/release/dist/contracts/chief-of-staff/' + name + '.js'),
    ],
    {
      env: {
        ...safeHostEnvironment('docker'),
        ...env,
        ...(selected.suite === 'native'
          ? {
              COS_FIXTURE_HOST_ROOT: fixtureRoot,
              COS_FIXTURE_IMAGE: fixtureImage,
            }
          : {}),
      },
      encoding: 'utf8',
      maxBuffer: 1024 ** 2,
      timeout: 600000,
    },
  );
  if (selected.suite === 'native') await stopFixtureWorkers(fixtureRoot!, fixtureImage!, undefined, 'cos-rpc/v1');
  verifyVaultMemory();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error || result.signal || result.status !== 0) throw Error('mail_fixture_process_failed');
  verifyMailFixtureReport(result.stdout, selected.suite);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runMailArtifactFixture(process.argv.slice(2)).catch(() => {
    console.error(JSON.stringify({ status: 'unavailable', code: 'mail_artifact_fixture_unverified' }));
    process.exitCode = 1;
  });
