import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initializeTarget, readTarget, protectTarget, withTargetLock, type TargetBinding } from './target-state.js';
let directory: string, root: string;
const binding: TargetBinding = {
  hostFingerprint: 'a'.repeat(64),
  databaseFingerprint: 'b'.repeat(64),
  service: 'nanoclaw-fixture.service',
  installationRoot: '/fixture/nanoclaw',
  dataRoot: '/fixture/nanoclaw/data',
};
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-target-state-'));
  root = path.join(directory, 'target');
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
describe('S01-OPS04 Pi-owned target identity and monotonic lifecycle', () => {
  it('initialises a private bound target once without a separate operational approval', () => {
    const state = initializeTarget(root, binding);
    expect(state).toMatchObject({ binding, lifecycle: 'implementation_disposable', maintenance: true });
    expect(readTarget(root, binding)).toEqual(state);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(initializeTarget(root, binding)).toEqual(state);
  });
  it('rejects a foreign installation or database rather than rebinding it', () => {
    initializeTarget(root, binding);
    expect(() => readTarget(root, { ...binding, databaseFingerprint: 'c'.repeat(64) })).toThrow();
    expect(() => initializeTarget(root, { ...binding, installationRoot: '/foreign' })).toThrow();
  });
  it('protection survives a stale disposable state file and cannot be reopened', () => {
    initializeTarget(root, binding);
    const stale = fs.readFileSync(path.join(root, 'state.json'));
    expect(protectTarget(root, binding).lifecycle).toBe('protected');
    fs.writeFileSync(path.join(root, 'state.json'), stale);
    expect(readTarget(root, binding).lifecycle).toBe('protected');
    expect(initializeTarget(root, binding).lifecycle).toBe('protected');
  });
  it('refuses missing or contradictory target history', () => {
    initializeTarget(root, binding);
    protectTarget(root, binding);
    fs.unlinkSync(path.join(root, 'state.json'));
    expect(() => initializeTarget(root, binding)).toThrow();
    expect(() => readTarget(root, binding)).toThrow();
  });
  it('never steals an existing deployment lock and releases its own lock after failure', () => {
    initializeTarget(root, binding);
    withTargetLock(root, () => {
      expect(() => withTargetLock(root, () => null)).toThrow('target_locked');
    });
    expect(() =>
      withTargetLock(root, () => {
        throw new Error('injected');
      }),
    ).toThrow('injected');
    expect(withTargetLock(root, () => 42)).toBe(42);
  });
  it('rejects symlink roots and insecure state files', () => {
    fs.symlinkSync(directory, root);
    expect(() => initializeTarget(root, binding)).toThrow();
    fs.unlinkSync(root);
    initializeTarget(root, binding);
    fs.chmodSync(path.join(root, 'state.json'), 0o644);
    expect(() => readTarget(root, binding)).toThrow();
  });
});
