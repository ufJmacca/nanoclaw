import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-source-publication-'));
  roots.push(root);
  const repository = path.join(root, 'work'),
    remote = path.join(root, 'remote.git');
  fs.mkdirSync(repository);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repository, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', remote);
  git('init', '-b', 'candidate');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'url.' + remote + '.insteadOf', 'https://github.com/ufJmacca/nanoclaw.git');
  git('remote', 'add', 'origin', 'https://github.com/ufJmacca/nanoclaw.git');
  const commit = () => {
    git('commit', '--allow-empty', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const first = commit();
  const publish = (source = first) =>
    execFileSync('bash', [path.resolve('scripts/cos-push-source.sh'), source, 'refs/heads/candidate'], {
      cwd: repository,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const tip = () => git('ls-remote', 'origin', 'refs/heads/candidate').split(/\s/)[0];
  return { git, first, commit, publish, tip, repository };
}

it('publishes the exact tested source to an absent branch and can retry it', () => {
  const f = fixture();
  f.publish();
  f.publish();
  expect(f.tip()).toBe(f.first);
});
it('preserves a newer branch and dirty local files when retrying a tested ancestor', () => {
  const f = fixture();
  const newer = f.commit();
  f.git('push', 'origin', 'HEAD:refs/heads/candidate');
  f.git('checkout', '--detach', f.first);
  fs.writeFileSync(path.join(f.repository, 'local.txt'), 'preserve me');
  f.publish();
  expect(f.tip()).toBe(newer);
  expect(f.git('rev-parse', 'HEAD')).toBe(f.first);
  expect(fs.readFileSync(path.join(f.repository, 'local.txt'), 'utf8')).toBe('preserve me');
});
it('advances an older remote branch with the exact tested commit', () => {
  const f = fixture();
  f.git('push', 'origin', 'HEAD:refs/heads/candidate');
  const newer = f.commit();
  f.publish(newer);
  expect(f.tip()).toBe(newer);
});
it('refuses a divergent branch without replacing its contents', () => {
  const f = fixture();
  const remote = f.commit();
  f.git('push', 'origin', 'HEAD:refs/heads/candidate');
  f.git('checkout', '--detach', f.first);
  f.git('commit', '--allow-empty', '-m', 'different');
  expect(() => f.publish(f.git('rev-parse', 'HEAD'))).toThrow();
  expect(f.tip()).toBe(remote);
});
it('refuses a moving source name or absent commit before trying a push', () => {
  const f = fixture();
  expect(() => f.publish('HEAD')).toThrow();
  expect(() => f.publish('0'.repeat(40))).toThrow();
  expect(f.tip()).toBe('');
});
