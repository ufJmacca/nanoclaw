import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { safeHostEnvironment } from '../../../host-environment.js';
const execute = promisify(execFile);
const rootFiles = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'tsconfig.json']);
function allowed(name: string): boolean {
  const pieces = name.split('/');
  if (
    pieces.some(
      (item) =>
        ['node_modules', '.git', '.ssh', '.codex', '.cos-plan-state', 'data', 'groups', 'logs'].includes(item) ||
        /^\.env(?:\.|$)/.test(item),
    ) ||
    /(?:\.(?:pem|key|p12|pfx)|(?:^|\/)auth\.json|\.keys\.json)$/.test(name)
  )
    return false;
  return (
    rootFiles.has(name) ||
    name.startsWith('src/') ||
    name.startsWith('container/skills/') ||
    name.startsWith('container/agent-runner/src/') ||
    name.startsWith('container/release/') ||
    [
      'container/CLAUDE.md',
      'container/entrypoint.sh',
      'container/Dockerfile',
      'container/agent-runner/package.json',
      'container/agent-runner/bun.lock',
      'container/agent-runner/tsconfig.json',
    ].includes(name)
  );
}
function workerAsset(name: string): boolean {
  return (
    name.startsWith('container/skills/') ||
    name.startsWith('container/agent-runner/src/') ||
    name.startsWith('src/deep-research-workflow/') ||
    name === 'container/CLAUDE.md'
  );
}
export async function prepareBuildContext(
  repository: string,
  commit: string,
  destination: string,
): Promise<{
  sourceCommit: string;
  sourceTree: string;
  buildInputDigest: string;
  workerAssetsDigest: string;
  files: number;
}> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('pinned_commit_required');
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error('build_context_exists');
  const git = async (...args: string[]) =>
    (await execute('git', args, { cwd: repository, env: safeHostEnvironment('docker'), maxBuffer: 16 * 1024 * 1024 }))
      .stdout;
  const resolved = (await git('rev-parse', '--verify', commit + '^{commit}')).trim();
  if (resolved !== commit) throw new Error('pinned_commit_required');
  const sourceTree = (await git('rev-parse', commit + '^{tree}')).trim();
  const records = (await git('ls-tree', '-r', '-z', commit))
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(row);
      if (!match) throw new Error('unsafe_build_source');
      return { mode: match[1], type: match[2], oid: match[3], name: match[4] };
    })
    .filter((entry) => allowed(entry.name));
  if (
    !records.length ||
    records.length > 5000 ||
    records.some(
      (entry) =>
        !['100644', '100755'].includes(entry.mode) ||
        entry.type !== 'blob' ||
        !/^[a-zA-Z0-9_@./-]+$/.test(entry.name) ||
        entry.name.split('/').some((part) => !part || part === '..' || part === '.') ||
        path.isAbsolute(entry.name),
    )
  )
    throw new Error('unsafe_build_source');
  records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const build = createHash('sha256'),
    assets = createHash('sha256');
  let total = 0;
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    for (const entry of records) {
      const { stdout: bytes } = await execute('git', ['cat-file', 'blob', entry.oid], {
        cwd: repository,
        env: safeHostEnvironment('docker'),
        encoding: 'buffer',
        maxBuffer: 8 * 1024 * 1024,
      });
      total += bytes.length;
      if (total > 64 * 1024 * 1024) throw new Error('build_context_too_large');
      const identity =
        JSON.stringify([entry.name, entry.mode, createHash('sha256').update(bytes).digest('hex')]) + '\n';
      build.update(identity);
      if (workerAsset(entry.name)) assets.update(identity);
      const file = path.join(destination, entry.name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
    }
    const workerAssetsDigest = assets.digest('hex');
    const info = JSON.stringify({ commit, tree: sourceTree, workerAssetsDigest }) + '\n';
    fs.writeFileSync(path.join(destination, 'build-info.json'), info, { flag: 'wx', mode: 0o644 });
    build.update(info);
    return {
      sourceCommit: commit,
      sourceTree,
      workerAssetsDigest,
      buildInputDigest: build.digest('hex'),
      files: records.length + 1,
    };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
export function validateMacBuilder(value: {
  clientPlatform: string;
  endpoint: string;
  operatingSystem: string;
  architecture: string;
  nodes: Array<{ endpoint: string; platforms: string[] }>;
}): void {
  const local = (endpoint: string) => /^unix:\/\/\/[a-zA-Z0-9_./-]+\.sock$/.test(endpoint);
  if (
    value.clientPlatform !== 'darwin' ||
    !local(value.endpoint) ||
    value.operatingSystem !== 'Docker Desktop' ||
    !['arm64', 'aarch64'].includes(value.architecture) ||
    value.nodes.length !== 1 ||
    !local(value.nodes[0].endpoint) ||
    !value.nodes[0].platforms.includes('linux/arm64')
  )
    throw new Error('mac_local_builder_required');
}
