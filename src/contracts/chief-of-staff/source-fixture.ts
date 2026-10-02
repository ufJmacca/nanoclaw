import fs from 'node:fs';
import path from 'node:path';
const absolute = (value: string | undefined): value is string =>
  typeof value === 'string' && value !== '/' && /^\/[a-zA-Z0-9_./-]+$/.test(value) && path.resolve(value) === value;
/** Trusted fixture mapping only. Never forwards the parent's credentials or arbitrary environment. */
export function sourceFixtureEnvironment(sourceRoot: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!absolute(sourceRoot)) throw Error('invalid_fixture_source_root');
  const root = env.COS_FIXTURE_WORK_ROOT,
    host = env.COS_FIXTURE_WORK_HOST_ROOT;
  if (root === undefined && host === undefined) return { COS_FIXTURE_HOST_ROOT: sourceRoot };
  if (!absolute(root) || !absolute(host)) throw Error('invalid_fixture_workspace');
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    fs.realpathSync(root) !== root ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw Error('invalid_fixture_workspace');
  return { COS_FIXTURE_HOST_ROOT: host, COS_FIXTURE_SOURCE_ROOT: sourceRoot, COS_FIXTURE_WORK_ROOT: root };
}
/** Filtered snapshots are produced by prepareBuildContext from the checked Git commit, never agent input. */
export function validatePreparedFixtureSource(
  value: unknown,
  request: { sourceCommit: string; sourceTree: string },
): void {
  const info = value as { commit?: string; tree?: string; workerAssetsDigest?: string } | null;
  if (
    !info ||
    info.commit !== request.sourceCommit ||
    info.tree !== request.sourceTree ||
    !/^[a-f0-9]{64}$/.test(info.workerAssetsDigest ?? '')
  )
    throw Error('fixture_source_changed');
}
