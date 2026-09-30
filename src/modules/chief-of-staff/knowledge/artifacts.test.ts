import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
  it('requires an active owner lease and excludes another importer or garbage collector until remote work finishes', async () => {
    const second = new KnowledgeArtifacts(root, staging);
    let stale: unknown;
    await artifacts.exclusive(async (lease) => {
      stale = lease;
      expect(artifacts.capture('scope-a', 'note.md', lease).text).toContain('Pilot Alpha');
      await expect(second.exclusive(async () => undefined)).rejects.toThrow('knowledge_artifacts_busy');
      expect(() => second.capture('scope-a', 'note.md', lease)).toThrow('knowledge_artifacts_lease_required');
      expect(() => artifacts.reconcile(new Set(), Date.now() + 1000, {} as typeof lease)).toThrow(
        'knowledge_artifacts_lease_required',
      );
    });
    expect(() => artifacts.capture('scope-a', 'note.md', stale as never)).toThrow('knowledge_artifacts_lease_required');
    await expect(second.exclusive(async () => 42)).resolves.toBe(42);
  });
  it('releases exclusion after failure without deleting the persistent lock inode', async () => {
    await expect(
      artifacts.exclusive(async () => {
        throw new Error('fixture interrupted');
      }),
    ).rejects.toThrow('fixture interrupted');
    const inode = fs.statSync(path.join(root, '.operation.lock')).ino;
    await expect(new KnowledgeArtifacts(root, staging).exclusive(async () => 42)).resolves.toBe(42);
    expect(fs.statSync(path.join(root, '.operation.lock')).ino).toBe(inode);
  });
  it('S02-T08: a killed publisher releases the kernel lock and leaves complete orphan bytes recoverable', async () => {
    const script = `import {KnowledgeArtifacts} from ${JSON.stringify(new URL('./artifacts.ts', import.meta.url).href)};
      const artifacts=new KnowledgeArtifacts(process.argv[1],process.argv[2]);
      await artifacts.exclusive(async lease=>{artifacts.capture('scope-crash','note.md',lease);process.stdout.write('published\\n');await new Promise(()=>setInterval(()=>{},1000));});`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, root, staging], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const exited = once(child, 'exit');
    try {
      const ready = await Promise.race([
        once(child.stdout, 'data').then(([data]) => String(data)),
        exited.then(() => {
          throw new Error('fixture publisher exited before publication');
        }),
      ]);
      expect(ready).toBe('published\n');
      await expect(artifacts.exclusive(async () => undefined)).rejects.toThrow('knowledge_artifacts_busy');
      child.kill('SIGKILL');
      await exited;
      await artifacts.exclusive(async (lease) => {
        expect(artifacts.reconcile(new Set(), Date.now() + 1000, lease)).toBe(1);
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
  it('S02-T03/T08: publishes durable checksummed raw bytes before metadata, with idempotent replay and scope separation', async () => {
    await artifacts.exclusive(async (lease) => {
      const a = artifacts.capture('scope-a', 'note.md', lease),
        b = artifacts.capture('scope-a', 'note.md', lease);
      expect(a).toEqual(b);
      expect(artifacts.read(a.id, a.digest)).toBe(a.text);
      expect(fs.readFileSync(path.join(root, a.id + '.blob'))).toEqual(fs.readFileSync(path.join(staging, 'note.md')));
      expect(artifacts.capture('scope-b', 'note.md', lease).id).not.toBe(a.id);
      fs.writeFileSync(path.join(staging, 'note.md'), '# Pilot Alpha\nSupplier approved.');
      const c = artifacts.capture('scope-a', 'note.md', lease);
      expect(c.id).not.toBe(a.id);
      expect(artifacts.read(a.id, a.digest)).toBe(a.text);
    });
  });
  it('S02-T04: rejects traversal, symlink/hardlink escape, unknown binary format and public staging files', async () => {
    await artifacts.exclusive(async (lease) => {
      fs.writeFileSync(path.join(base, 'outside.md'), 'private canary', { mode: 0o600 });
      fs.symlinkSync(path.join(base, 'outside.md'), path.join(staging, 'link.md'));
      fs.linkSync(path.join(base, 'outside.md'), path.join(staging, 'hard.md'));
      fs.copyFileSync(path.join(staging, 'note.md'), path.join(staging, 'note.pdf'));
      fs.writeFileSync(path.join(staging, 'public.md'), 'wrong permissions', { mode: 0o644 });
      for (const name of [
        '../outside.md',
        path.join(base, 'outside.md'),
        'link.md',
        'hard.md',
        'note.pdf',
        'public.md',
      ])
        expect(() => artifacts.capture('scope-a', name, lease)).toThrow();
      expect(fs.readdirSync(root).filter((x) => x.endsWith('.blob'))).toHaveLength(0);
    });
  });
  it('S02-T08: reconciles only owned orphan blobs after a grace period, preserving references and unrelated files', async () => {
    await artifacts.exclusive(async (lease) => {
      const a = artifacts.capture('scope-a', 'note.md', lease),
        b = artifacts.capture('scope-b', 'note.md', lease);
      fs.writeFileSync(path.join(root, 'unrelated.txt'), 'keep');
      expect(artifacts.reconcile(new Set([a.id]), 0, lease)).toBe(0);
      expect(artifacts.reconcile(new Set([a.id]), Date.now() + 1000, lease)).toBe(1);
      expect(artifacts.read(a.id, a.digest)).toBe(a.text);
      expect(fs.existsSync(path.join(root, b.id + '.blob'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8')).toBe('keep');
    });
  });
  it('rejects a changed blob rather than returning unchecked cached text', async () => {
    await artifacts.exclusive(async (lease) => {
      const a = artifacts.capture('scope-a', 'note.md', lease);
      fs.writeFileSync(path.join(root, a.id + '.blob'), 'tampered', { mode: 0o600 });
      expect(() => artifacts.read(a.id, a.digest)).toThrow('artifact_integrity');
      expect(() => artifacts.read('../outside', sourceDigest(Buffer.from('tampered')))).toThrow();
    });
  });
  it('S02-T08: interruption at atomic publication leaves recoverable bytes, never a partial complete artifact', async () => {
    await artifacts.exclusive(async (lease) => {
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('injected_crash');
      });
      expect(() => artifacts.capture('scope-a', 'note.md', lease)).toThrow('injected_crash');
      expect(fs.readdirSync(root).filter((name) => name.endsWith('.blob'))).toHaveLength(0);
      const retry = artifacts.capture('scope-a', 'note.md', lease);
      expect(artifacts.read(retry.id, retry.digest)).toBe(retry.text);
      expect(artifacts.reconcile(new Set([retry.id]), Date.now() + 1000, lease)).toBe(1);
    });
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
  it('removes only an owned explicit artifact under its lease and tolerates an already-unlinked retry', async () => {
    await artifacts.exclusive(async (lease) => {
      const captured = artifacts.capture('scope-a', 'note.md', lease);
      expect(() => artifacts.remove(captured.id, {} as typeof lease)).toThrow('knowledge_artifacts_lease_required');
      expect(() => artifacts.remove('../unrelated', lease)).toThrow('invalid_artifact');
      expect(artifacts.remove(captured.id, lease)).toBe(true);
      expect(artifacts.remove(captured.id, lease)).toBe(false);
      fs.symlinkSync(path.join(staging, 'note.md'), path.join(root, captured.id + '.blob'));
      expect(() => artifacts.remove(captured.id, lease)).toThrow();
      expect(fs.existsSync(path.join(staging, 'note.md'))).toBe(true);
    });
  });
  it('inspection publishes nothing and a changed staging file cannot pass its earlier digest check', async () => {
    await artifacts.exclusive(async (lease) => {
      const staged = artifacts.inspect('scope-a', 'note.md', lease);
      expect(fs.readdirSync(root).filter((name) => name.endsWith('.blob'))).toHaveLength(0);
      fs.writeFileSync(path.join(staging, 'note.md'), 'Changed after policy verification.');
      expect(() => artifacts.capture('scope-a', 'note.md', lease, staged.digest)).toThrow('staged_source_changed');
      expect(fs.readdirSync(root).filter((name) => name.endsWith('.blob'))).toHaveLength(0);
    });
  });
  it('publishes bounded generated text in a distinct namespace under the same operation lease', async () => {
    await artifacts.exclusive(async (lease) => {
      const text = 'A synthetic answer with checked citations.';
      const first = artifacts.publishText('answer-fixture', text, lease);
      expect(artifacts.publishText('answer-fixture', text, lease)).toEqual(first);
      expect(artifacts.read(first.id, first.digest)).toBe(text);
      expect(artifacts.publishText('another-answer', text, lease).id).not.toBe(first.id);
      expect(() => artifacts.publishText('../outside', text, lease)).toThrow();
      expect(() => artifacts.publishText('answer-fixture', 'x'.repeat(1048577), lease)).toThrow();
    });
  });
});
