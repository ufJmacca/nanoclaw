import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeArtifacts, sourceDigest } from './artifacts.js';

describe('S02 host-owned artifact publication', () => {
  let base: string, root: string, staging: string, artifacts: KnowledgeArtifacts;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-knowledge-'));
    root = path.join(base, 'artifacts');
    staging = path.join(base, 'staging');
    fs.mkdirSync(root, { mode: 0o700 });
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.writeFileSync(path.join(staging, 'note.md'), '# Pilot Alpha\nBlocked on supplier approval.', { mode: 0o600 });
    artifacts = new KnowledgeArtifacts(root, staging);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  });
  it('S02-T03/T08: publishes durable checksummed raw bytes before metadata, with idempotent replay and scope separation', () => {
    const a = artifacts.capture('scope-a', 'note.md'),
      b = artifacts.capture('scope-a', 'note.md');
    expect(a).toEqual(b);
    expect(artifacts.read(a.id, a.digest)).toBe(a.text);
    expect(fs.readFileSync(path.join(root, a.id + '.blob'))).toEqual(fs.readFileSync(path.join(staging, 'note.md')));
    expect(artifacts.capture('scope-b', 'note.md').id).not.toBe(a.id);
    fs.writeFileSync(path.join(staging, 'note.md'), '# Pilot Alpha\nSupplier approved.');
    const c = artifacts.capture('scope-a', 'note.md');
    expect(c.id).not.toBe(a.id);
    expect(artifacts.read(a.id, a.digest)).toBe(a.text);
  });
  it('S02-T04: rejects traversal, symlink/hardlink escape, unknown binary format and public staging files', () => {
    fs.writeFileSync(path.join(base, 'outside.md'), 'private canary', { mode: 0o600 });
    fs.symlinkSync(path.join(base, 'outside.md'), path.join(staging, 'link.md'));
    fs.linkSync(path.join(base, 'outside.md'), path.join(staging, 'hard.md'));
    fs.copyFileSync(path.join(staging, 'note.md'), path.join(staging, 'note.pdf'));
    fs.writeFileSync(path.join(staging, 'public.md'), 'wrong permissions', { mode: 0o644 });
    for (const name of ['../outside.md', path.join(base, 'outside.md'), 'link.md', 'hard.md', 'note.pdf', 'public.md'])
      expect(() => artifacts.capture('scope-a', name)).toThrow();
    expect(fs.readdirSync(root).filter((x) => x.endsWith('.blob'))).toHaveLength(0);
  });
  it('S02-T08: reconciles only owned orphan blobs after a grace period, preserving references and unrelated files', () => {
    const a = artifacts.capture('scope-a', 'note.md'),
      b = artifacts.capture('scope-b', 'note.md');
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'keep');
    expect(artifacts.reconcile(new Set([a.id]), 0)).toBe(0);
    expect(artifacts.reconcile(new Set([a.id]), Date.now() + 1000)).toBe(1);
    expect(artifacts.read(a.id, a.digest)).toBe(a.text);
    expect(fs.existsSync(path.join(root, b.id + '.blob'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8')).toBe('keep');
  });
  it('rejects a changed blob rather than returning unchecked cached text', () => {
    const a = artifacts.capture('scope-a', 'note.md');
    fs.writeFileSync(path.join(root, a.id + '.blob'), 'tampered', { mode: 0o600 });
    expect(() => artifacts.read(a.id, a.digest)).toThrow('artifact_integrity');
    expect(() => artifacts.read('../outside', sourceDigest(Buffer.from('tampered')))).toThrow();
  });
  it('S02-T08: interruption at atomic publication leaves recoverable bytes, never a partial complete artifact', () => {
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('injected_crash');
    });
    expect(() => artifacts.capture('scope-a', 'note.md')).toThrow('injected_crash');
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.blob'))).toHaveLength(0);
    const retry = artifacts.capture('scope-a', 'note.md');
    expect(artifacts.read(retry.id, retry.digest)).toBe(retry.text);
    expect(artifacts.reconcile(new Set([retry.id]), Date.now() + 1000)).toBe(1);
  });
  it('refuses symlink roots, nonprivate roots and roots inside a Git checkout', () => {
    fs.symlinkSync(root, path.join(base, 'link'));
    expect(() => new KnowledgeArtifacts(path.join(base, 'link'), staging)).toThrow();
    fs.chmodSync(root, 0o755);
    expect(() => new KnowledgeArtifacts(root, staging)).toThrow();
    fs.chmodSync(root, 0o700);
    fs.mkdirSync(path.join(base, '.git'));
    expect(() => new KnowledgeArtifacts(root, staging)).toThrow();
  });
});
