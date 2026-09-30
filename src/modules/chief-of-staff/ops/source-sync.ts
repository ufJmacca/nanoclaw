import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeHostEnvironment } from '../../../host-environment.js';
import type { ReleaseManifest } from './release-manifest.js';
export type GitRunner = (args: string[], cwd: string) => Promise<string>;
const git: GitRunner = async (args, cwd) =>
  (
    await promisify(execFile)('git', args, {
      cwd,
      timeout: 30000,
      maxBuffer: 1048576,
      env: {
        ...safeHostEnvironment('docker'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
      },
    })
  ).stdout.trim();
type SourceRequest = { repository: string; sourceRoot: string; releaseId: string; source: ReleaseManifest['source'] };
/** Run under the target deployment lock. Fetching only prepares provenance; it never activates code. */
export async function syncPinnedSource(request: SourceRequest, execute: GitRunner = git) {
  const { repository, sourceRoot, source, releaseId } = request;
  if (
    source.repository !== 'ufJmacca/nanoclaw' ||
    source.syncContract !== 'cos-source-sync/github-pinned-v1' ||
    !/^[a-f0-9]{40}$/.test(source.commit) ||
    !/^[a-f0-9]{40}$/.test(source.tree) ||
    !/^refs\/(heads|tags)\/[a-zA-Z0-9_/-][a-zA-Z0-9_./-]{0,160}$/.test(source.fetchRef) ||
    source.fetchRef.includes('..') ||
    !/^release-[a-zA-Z0-9_-]{1,120}$/.test(releaseId)
  )
    throw new Error('invalid_source_request');
  for (const directory of [repository, sourceRoot])
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw new Error('unsafe_source_path');
  if (sourceRoot === repository || sourceRoot.startsWith(repository + '/') || repository.startsWith(sourceRoot + '/'))
    throw new Error('unsafe_source_path');
  let ancestor = sourceRoot;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor || fs.realpathSync(repository) !== repository)
    throw new Error('unsafe_source_path');
  const controls = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'protocol.file.allow=never',
    '-c',
    'submodule.recurse=false',
    '-c',
    'credential.helper=',
    '-c',
    'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
  ];
  const run = (args: string[], cwd = repository) => execute([...controls, ...args], cwd);
  const origin = await run(['remote', 'get-url', 'origin']);
  if (
    ![
      'https://github.com/ufJmacca/nanoclaw.git',
      'https://github.com/ufJmacca/nanoclaw',
      'git@github.com:ufJmacca/nanoclaw.git',
    ].includes(origin)
  )
    throw new Error('source_repository_mismatch');
  let filterKeys = '';
  try {
    filterKeys = await run(['config', '--name-only', '--get-regexp', '^filter\\.']);
  } catch (error) {
    const failure = error as { code?: number; status?: number };
    if (failure.code !== 1 && failure.status !== 1) throw error;
  }
  for (const key of filterKeys.split('\n').filter(Boolean)) {
    if (!/^filter\.[a-zA-Z0-9_.-]+\.(clean|smudge|process|required)$/.test(key))
      throw new Error('unsafe_source_git_configuration');
    controls.push('-c', key + '=' + (key.endsWith('.required') ? 'false' : ''));
  }
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const checkout = path.join(sourceRoot, releaseId),
    retention = 'refs/cos/releases/' + releaseId;
  const verifyObject = async () => {
    if (
      (await run(['rev-parse', '--verify', source.commit + '^{commit}'])) !== source.commit ||
      (await run(['rev-parse', '--verify', source.commit + '^{tree}'])) !== source.tree
    )
      throw new Error('source_tree_mismatch');
  };
  const verifyCheckout = async () => {
    if (
      fs.realpathSync(checkout) !== checkout ||
      (await run(['rev-parse', 'HEAD'], checkout)) !== source.commit ||
      (await run(['rev-parse', 'HEAD^{tree}'], checkout)) !== source.tree ||
      (await run(['rev-parse', '--abbrev-ref', 'HEAD'], checkout)) !== 'HEAD' ||
      (await run(['status', '--porcelain', '--untracked-files=all'], checkout)) !== ''
    )
      throw new Error('source_checkout_conflict');
    const common = path.resolve(checkout, await run(['rev-parse', '--git-common-dir'], checkout));
    const installedCommon = path.resolve(repository, await run(['rev-parse', '--git-common-dir']));
    if (fs.realpathSync(common) !== fs.realpathSync(installedCommon)) throw new Error('source_checkout_conflict');
  };
  if (fs.existsSync(checkout)) {
    await verifyObject();
    await verifyCheckout();
  } else {
    await run(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', source.fetchRef]);
    await verifyObject();
  }
  let retained: string | null = null;
  try {
    retained = await run(['show-ref', '--verify', '--hash', retention]);
  } catch (error) {
    const failure = error as { code?: number; status?: number };
    if (![1, 128].includes(failure.code ?? failure.status ?? 0)) throw error;
  }
  if (retained && retained !== source.commit) throw new Error('source_retention_conflict');
  if (!retained) await run(['update-ref', retention, source.commit, '0'.repeat(40)]);
  if (!fs.existsSync(checkout)) await run(['worktree', 'add', '--detach', checkout, source.commit]);
  await verifyCheckout();
  return {
    contract: 'cos-source-sync/github-pinned-v1',
    repository: source.repository,
    commit: source.commit,
    tree: source.tree,
    checkout,
    verifiedAt: new Date().toISOString(),
  };
}
