import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepareBuildContext, validateMacBuilder } from './build-context.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-build-context-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env: { ...process.env, HUSKY: '0' }, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const files: Record<string, string> = {
    'package.json': '{}',
    'pnpm-lock.yaml': 'fixture-lock',
    'tsconfig.json': '{}',
    'src/index.ts': 'console.log("fixture")',
    'container/agent-runner/src/index.ts': 'fixture runner',
    'container/skills/fixture/SKILL.md': 'fixture skill',
    'container/CLAUDE.md': 'fixture instructions',
    '.env': 'PRIVATE_ENV_CANARY',
    'data/v2.db': 'PRIVATE_STATE_CANARY',
    'container/agent-runner/node_modules/secret': 'DEPENDENCY_CANARY',
    'src/private.key': 'PRIVATE_KEY_CANARY',
  };
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), body);
  }
  git('add', '.');
  git('commit', '-qm', 'fixture');
  return { root, repo, git, commit: git('rev-parse', 'HEAD') };
}
describe('S01-REL03 pinned source-only build context', () => {
  it('exports only allowed committed bytes, excluding secrets, live state and host dependencies', async () => {
    const f = fixture(),
      out = path.join(f.root, 'context');
    fs.writeFileSync(path.join(f.repo, 'src/index.ts'), 'UNCOMMITTED_CANARY');
    const result = await prepareBuildContext(f.repo, f.commit, out);
    expect(fs.readFileSync(path.join(out, 'src/index.ts'), 'utf8')).toBe('console.log("fixture")');
    expect(result.sourceCommit).toBe(f.commit);
    expect(result.sourceTree).toBe(f.git('rev-parse', f.commit + '^{tree}'));
    for (const denied of ['.env', 'data', 'container/agent-runner/node_modules', 'src/private.key'])
      expect(fs.existsSync(path.join(out, denied))).toBe(false);
    expect(result.buildInputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'build-info.json'), 'utf8'))).toMatchObject({
      commit: f.commit,
      workerAssetsDigest: result.workerAssetsDigest,
    });
  });
  it('refuses symlinks and never overwrites an existing context', async () => {
    const f = fixture();
    fs.symlinkSync('/private/credential', path.join(f.repo, 'src/unsafe.ts'));
    f.git('add', '.');
    f.git('commit', '-qm', 'unsafe');
    await expect(prepareBuildContext(f.repo, f.git('rev-parse', 'HEAD'), path.join(f.root, 'context'))).rejects.toThrow(
      'unsafe_build_source',
    );
    await expect(prepareBuildContext(f.repo, f.commit, f.repo)).rejects.toThrow('build_context_exists');
  });
  it('requires an exact source commit and detects worker asset changes', async () => {
    const f = fixture();
    await expect(prepareBuildContext(f.repo, 'HEAD', path.join(f.root, 'invalid'))).rejects.toThrow(
      'pinned_commit_required',
    );
    const before = await prepareBuildContext(f.repo, f.commit, path.join(f.root, 'first'));
    fs.writeFileSync(path.join(f.repo, 'container/CLAUDE.md'), 'changed instructions');
    f.git('add', '.');
    f.git('commit', '-qm', 'changed');
    const after = await prepareBuildContext(f.repo, f.git('rev-parse', 'HEAD'), path.join(f.root, 'second'));
    expect(after.workerAssetsDigest).not.toBe(before.workerAssetsDigest);
  });
});
describe('S01-REL02 Mac-local builder', () => {
  const good = {
    clientPlatform: 'darwin',
    endpoint: 'unix:///var/run/docker.sock',
    operatingSystem: 'Docker Desktop',
    architecture: 'aarch64',
    nodes: [{ endpoint: 'unix:///var/run/docker.sock', platforms: ['linux/arm64'] }],
  };
  it('accepts one local ARM64-capable Docker Desktop node', () => expect(() => validateMacBuilder(good)).not.toThrow());
  it('rejects remote endpoints, Pi builds, multi-node builders and unsupported platforms', () => {
    for (const bad of [
      { ...good, endpoint: 'ssh://nanoclaw-pi' },
      { ...good, clientPlatform: 'linux' },
      { ...good, nodes: [...good.nodes, ...good.nodes] },
      { ...good, nodes: [{ endpoint: 'tcp://fixture:2375', platforms: ['linux/arm64'] }] },
      { ...good, nodes: [{ ...good.nodes[0], platforms: ['linux/amd64'] }] },
    ])
      expect(() => validateMacBuilder(bad)).toThrow('mac_local_builder_required');
  });
});
