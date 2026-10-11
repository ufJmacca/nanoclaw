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
    'vitest.config.ts': 'public test identity selection',
    'src/index.ts': 'console.log("fixture")',
    'container/agent-runner/src/index.ts': 'fixture runner',
    'container/agent-runner/fixtures/cos-subscription-capability.ts': 'offline native protocol fixture',
    'container/agent-runner/fixtures/unadmitted.ts': 'UNADMITTED_FIXTURE_CANARY',
    'container/skills/fixture/SKILL.md': 'fixture skill',
    'container/CLAUDE.md': 'fixture instructions',
    'container/fixtures/vault/Dockerfile.release': 'immutable vault build',
    'container/fixtures/vault/probe-provision.mjs': 'synthetic kernel probe',
    'container/fixtures/vault/probe-backup-credentials.mjs': 'synthetic encrypted credential probe',
    'container/fixtures/vault/probe-backup-journal.mjs': 'synthetic encrypted credential journal probe',
    'container/fixtures/vault/unadmitted.mjs': 'UNADMITTED_VAULT_CANARY',
    'scripts/cos-vault-fixture.sh': 'host-only private pipe orchestration',
    'scripts/cos-vault-keychain.swift': 'trusted keychain code, never key bytes',
    'scripts/cos-backup-keychain.swift': 'trusted backup credential code, never credential material',
    'scripts/cos-backup-keychain-fixture.swift': 'disposable host-native credential entry fixture',
    'scripts/cos-root-unit-fixture.sh': 'isolated root administration source fixture',
    'scripts/cos-source-fixture.sh': 'public source-only Docker fixture driver',
    'scripts/cos-release.sh': 'source-pinned host release coordinator',
    'container/fixtures/backup-smb/Dockerfile.server': 'pinned synthetic SMB server',
    'container/fixtures/backup-smb/Dockerfile.client': 'immutable tested host CIFS client',
    'container/fixtures/backup-smb/server.sh': 'dedicated synthetic account and share',
    'container/fixtures/backup-smb/probe.mjs': 'actual signed kernel mount and encrypted transport',
    'container/fixtures/backup-smb/unadmitted.mjs': 'UNADMITTED_SMB_CANARY',
    'scripts/cos-backup-smb-fixture.sh': 'isolated internal network orchestration',
    'scripts/unadmitted.sh': 'UNADMITTED_SCRIPT_CANARY',
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
  it('keeps the enclosing export private while its public build identity is readable under a private host umask', async () => {
    const f = fixture(),
      out = path.join(f.root, 'private-context'),
      mask = process.umask(0o077);
    try {
      await prepareBuildContext(f.repo, f.commit, out);
      expect(fs.statSync(out).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(out, 'build-info.json')).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(mask);
    }
  });
  it('exports only allowed committed bytes, excluding secrets, live state and host dependencies', async () => {
    const f = fixture(),
      out = path.join(f.root, 'context');
    fs.writeFileSync(path.join(f.repo, 'src/index.ts'), 'UNCOMMITTED_CANARY');
    const result = await prepareBuildContext(f.repo, f.commit, out);
    expect(fs.statSync(path.join(out, 'container/agent-runner/src')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(out, 'container/agent-runner/src/index.ts')).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(path.join(out, 'src/index.ts'), 'utf8')).toBe('console.log("fixture")');
    expect(
      fs.readFileSync(path.join(out, 'container/agent-runner/fixtures/cos-subscription-capability.ts'), 'utf8'),
    ).toBe('offline native protocol fixture');
    expect(fs.existsSync(path.join(out, 'container/agent-runner/fixtures/unadmitted.ts'))).toBe(false);
    expect(result.sourceCommit).toBe(f.commit);
    expect(fs.readFileSync(path.join(out, 'vitest.config.ts'), 'utf8')).toBe('public test identity selection');
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
it('exports only the admitted vault drivers from the same source and binds their bytes into build identity', async () => {
  const f = fixture(),
    first = path.join(f.root, 'vault-first');
  const before = await prepareBuildContext(f.repo, f.commit, first);
  for (const name of [
    'container/fixtures/vault/Dockerfile.release',
    'container/fixtures/vault/probe-provision.mjs',
    'container/fixtures/vault/probe-backup-credentials.mjs',
    'container/fixtures/vault/probe-backup-journal.mjs',
    'scripts/cos-vault-fixture.sh',
    'scripts/cos-vault-keychain.swift',
    'scripts/cos-source-fixture.sh',
    'scripts/cos-release.sh',
  ])
    expect(fs.existsSync(path.join(first, name))).toBe(true);
  for (const name of ['container/fixtures/vault/unadmitted.mjs', 'scripts/unadmitted.sh'])
    expect(fs.existsSync(path.join(first, name))).toBe(false);
  fs.writeFileSync(path.join(f.repo, 'scripts/cos-vault-fixture.sh'), 'changed host orchestration');
  f.git('add', '.');
  f.git('commit', '-qm', 'changed vault driver');
  const after = await prepareBuildContext(f.repo, f.git('rev-parse', 'HEAD'), path.join(f.root, 'vault-second'));
  expect(after.buildInputDigest).not.toBe(before.buildInputDigest);
  expect(after.workerAssetsDigest).toBe(before.workerAssetsDigest);
});
it('exports only the exact signed SMB fixtures and binds committed transport checks into build identity', async () => {
  const f = fixture(),
    out = path.join(f.root, 'smb-first');
  const first = await prepareBuildContext(f.repo, f.commit, out);
  for (const name of [
    'container/fixtures/backup-smb/Dockerfile.server',
    'container/fixtures/backup-smb/Dockerfile.client',
    'container/fixtures/backup-smb/server.sh',
    'container/fixtures/backup-smb/probe.mjs',
    'scripts/cos-backup-smb-fixture.sh',
  ])
    expect(fs.existsSync(path.join(out, name))).toBe(true);
  expect(fs.existsSync(path.join(out, 'container/fixtures/backup-smb/unadmitted.mjs'))).toBe(false);
  fs.writeFileSync(path.join(f.repo, 'container/fixtures/backup-smb/probe.mjs'), 'changed signed transport');
  f.git('add', '.');
  f.git('commit', '-qm', 'changed SMB fixture');
  const second = await prepareBuildContext(f.repo, f.git('rev-parse', 'HEAD'), path.join(f.root, 'smb-second'));
  expect(second.buildInputDigest).not.toBe(first.buildInputDigest);
  expect(second.workerAssetsDigest).toBe(first.workerAssetsDigest);
});
it('binds the host backup credential helper to committed source without changing worker assets', async () => {
  const f = fixture(),
    first = path.join(f.root, 'backup-first');
  fs.writeFileSync(path.join(f.repo, 'scripts/cos-backup-keychain.swift'), 'UNCOMMITTED_CREDENTIAL_DRIVER');
  const before = await prepareBuildContext(f.repo, f.commit, first);
  expect(fs.readFileSync(path.join(first, 'scripts/cos-backup-keychain.swift'), 'utf8')).toBe(
    'trusted backup credential code, never credential material',
  );
  expect(fs.readFileSync(path.join(first, 'scripts/cos-backup-keychain-fixture.swift'), 'utf8')).toBe(
    'disposable host-native credential entry fixture',
  );
  expect(fs.readFileSync(path.join(first, 'scripts/cos-root-unit-fixture.sh'), 'utf8')).toBe(
    'isolated root administration source fixture',
  );
  f.git('add', '.');
  f.git('commit', '-qm', 'changed credential driver');
  const after = await prepareBuildContext(f.repo, f.git('rev-parse', 'HEAD'), path.join(f.root, 'backup-second'));
  expect(after.buildInputDigest).not.toBe(before.buildInputDigest);
  expect(after.workerAssetsDigest).toBe(before.workerAssetsDigest);
});
it.each(['scripts/cos-source-fixture.sh', 'scripts/cos-release.sh'])(
  'binds committed %s bytes without exporting arbitrary scripts or changing worker assets',
  async (script) => {
    const f = fixture(),
      before = await prepareBuildContext(f.repo, f.commit, path.join(f.root, 'first'));
    fs.writeFileSync(path.join(f.repo, script), 'changed public host driver');
    f.git('add', '.');
    f.git('commit', '-qm', 'changed host driver');
    const after = await prepareBuildContext(f.repo, f.git('rev-parse', 'HEAD'), path.join(f.root, 'second'));
    expect(after.buildInputDigest).not.toBe(before.buildInputDigest);
    expect(after.workerAssetsDigest).toBe(before.workerAssetsDigest);
    expect(fs.existsSync(path.join(f.root, 'second/scripts/unadmitted.sh'))).toBe(false);
  },
);
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
