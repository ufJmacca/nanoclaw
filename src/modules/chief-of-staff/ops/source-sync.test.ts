import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { syncPinnedSource, type GitRunner } from './source-sync.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-source-'));
  roots.push(root);
  const remote = path.join(root, 'remote.git'),
    author = path.join(root, 'author'),
    installed = path.join(root, 'installed');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HUSKY: '0' },
    }).trim();
  git(root, 'init', '--bare', remote);
  git(root, 'clone', remote, author);
  git(author, 'config', 'user.name', 'Fixture');
  git(author, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(author, 'code.txt'), 'tested');
  git(author, 'add', '.');
  git(author, 'commit', '-m', 'tested');
  git(author, 'branch', '-M', 'main');
  git(author, 'push', 'origin', 'main');
  const commit = git(author, 'rev-parse', 'HEAD'),
    tree = git(author, 'rev-parse', 'HEAD^{tree}');
  git(root, 'clone', '-b', 'main', remote, installed);
  git(installed, 'remote', 'set-url', 'origin', 'https://github.com/ufJmacca/nanoclaw.git');
  fs.writeFileSync(path.join(installed, 'code.txt'), 'LIVE_UNCOMMITTED');
  fs.writeFileSync(path.join(installed, 'private.env'), 'PROTECTED');
  const calls: string[][] = [];
  const run: GitRunner = async (args, cwd) => {
    calls.push(args);
    const actual = [...args];
    const index = actual.indexOf('fetch');
    if (index >= 0) {
      actual[actual.indexOf('origin', index)] = remote;
      actual.splice(index, 0, '-c', 'protocol.file.allow=always');
    }
    return git(cwd, ...actual);
  };
  return {
    root,
    installed,
    author,
    git,
    run,
    calls,
    request: {
      repository: installed,
      sourceRoot: path.join(root, 'sources'),
      releaseId: 'release-fixture',
      source: {
        repository: 'ufJmacca/nanoclaw' as const,
        commit,
        tree,
        fetchRef: 'refs/heads/main',
        syncContract: 'cos-source-sync/github-pinned-v1' as const,
      },
    },
  };
}
describe('S01-REL13–18 GitHub-pinned source reference', () => {
  it('does not run checkout hooks or filters and refuses a missing pinned commit', async () => {
    const f = fixture(),
      marker = path.join(f.root, 'UNEXPECTED_HOOK');
    fs.writeFileSync(path.join(f.installed, '.git/hooks/post-checkout'), '#!/bin/sh\ntouch ' + marker + '\n', {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(f.author, '.gitattributes'), 'code.txt filter=untrusted\n');
    f.git(f.author, 'add', '.');
    f.git(f.author, 'commit', '-m', 'filter fixture');
    f.git(f.author, 'push', 'origin', 'main');
    f.git(f.installed, 'config', 'filter.untrusted.smudge', 'sh -c "touch ' + marker + '; cat"');
    f.git(f.installed, 'config', 'filter.untrusted.required', 'true');
    const source = {
      ...f.request.source,
      commit: f.git(f.author, 'rev-parse', 'HEAD'),
      tree: f.git(f.author, 'rev-parse', 'HEAD^{tree}'),
    };
    await syncPinnedSource({ ...f.request, source }, f.run);
    expect(fs.existsSync(marker)).toBe(false);
    await expect(
      syncPinnedSource(
        { ...f.request, releaseId: 'release-missing', source: { ...source, commit: 'f'.repeat(40) } },
        f.run,
      ),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(f.request.sourceRoot, 'release-missing'))).toBe(false);
  });
  it('uses the exact tested commit despite branch movement and preserves dirty live work', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.author, 'code.txt'), 'moving-tip');
    f.git(f.author, 'commit', '-am', 'later');
    f.git(f.author, 'push', 'origin', 'main');
    const receipt = await syncPinnedSource(f.request, f.run);
    expect(f.git(receipt.checkout, 'rev-parse', 'HEAD')).toBe(f.request.source.commit);
    expect(f.git(receipt.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(fs.readFileSync(path.join(f.installed, 'code.txt'), 'utf8')).toBe('LIVE_UNCOMMITTED');
    expect(fs.readFileSync(path.join(f.installed, 'private.env'), 'utf8')).toBe('PROTECTED');
    expect(f.calls.flat()).not.toContain('pull');
    expect(f.calls.flat()).not.toContain('reset');
    expect(
      (
        await syncPinnedSource(f.request, async (args, cwd) => {
          if (args.includes('fetch')) throw new Error('offline');
          return f.run(args, cwd);
        })
      ).commit,
    ).toBe(receipt.commit);
  });
  it('blocks foreign origins, changed trees and dirty retained checkouts without overwriting them', async () => {
    const f = fixture();
    await expect(
      syncPinnedSource({ ...f.request, source: { ...f.request.source, tree: 'f'.repeat(40) } }, f.run),
    ).rejects.toThrow();
    const receipt = await syncPinnedSource(f.request, f.run);
    fs.writeFileSync(path.join(receipt.checkout, 'code.txt'), 'REVIEW_WORK');
    await expect(syncPinnedSource(f.request, f.run)).rejects.toThrow('source_checkout_conflict');
    expect(fs.readFileSync(path.join(receipt.checkout, 'code.txt'), 'utf8')).toBe('REVIEW_WORK');
    f.git(f.installed, 'remote', 'set-url', 'origin', 'https://github.com/foreign/repo.git');
    await expect(syncPinnedSource(f.request, f.run)).rejects.toThrow('source_repository_mismatch');
  });
});
