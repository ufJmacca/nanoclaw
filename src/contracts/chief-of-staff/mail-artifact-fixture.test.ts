import { expect, it } from 'vitest';
import { parseMailArtifactFixtureArguments, runMailArtifactFixture } from './mail-artifact-fixture.js';
const args = (suite = 'database') => [
  suite,
  'sha256:' + 'a'.repeat(64),
  suite === 'native' ? 'sha256:' + 'b'.repeat(64) : '-',
  'c'.repeat(40),
  'd'.repeat(40),
  'e'.repeat(64),
];
it.each(['database', 'native'])('admits only fixed %s suite and immutable artifact identities', (suite) => {
  expect(parseMailArtifactFixtureArguments(args(suite))).toEqual({
    suite,
    hostImage: args()[1],
    workerImage: suite === 'native' ? args(suite)[2] : null,
    sourceCommit: args()[3],
    sourceTree: args()[4],
    workerAssetsDigest: args()[5],
  });
});
it.each(['database', 'native'])('admits G05 %s only through the separate fixed compiled fixture profile', (suite) => {
  expect(parseMailArtifactFixtureArguments([...args(suite), 'G05'])).toMatchObject({ suite, slice: 'G05' });
  expect(() => parseMailArtifactFixtureArguments([...args(suite), 'G06'])).toThrow('mail_artifact_fixture_arguments');
});
it.each(['suite', 'host', 'worker', 'same-image', 'commit', 'tree', 'assets', 'extra', 'missing'])(
  'rejects unbound %s before running any fixture',
  (reason) => {
    const values = args('native');
    if (reason === 'suite') values[0] = 'all';
    if (reason === 'host') values[1] = 'mutable:latest';
    if (reason === 'worker') values[2] = '-';
    if (reason === 'same-image') values[2] = values[1];
    if (reason === 'commit') values[3] = 'HEAD';
    if (reason === 'tree') values[4] = '../foreign';
    if (reason === 'assets') values[5] = 'not-bound';
    if (reason === 'extra') values.push('--source', '/workspace');
    if (reason === 'missing') values.pop();
    expect(() => parseMailArtifactFixtureArguments(values)).toThrow('mail_artifact_fixture_arguments');
  },
);
it('does not admit a worker image to a database-only suite', () => {
  const values = args();
  values[2] = 'sha256:' + 'b'.repeat(64);
  expect(() => parseMailArtifactFixtureArguments(values)).toThrow('mail_artifact_fixture_arguments');
});
it('refuses to manufacture immutable evidence from the source checkout', async () => {
  await expect(runMailArtifactFixture(args())).rejects.toThrow('mail_fixture_requires_immutable_host');
});
