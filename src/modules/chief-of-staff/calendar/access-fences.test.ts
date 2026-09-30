import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarAccessFences } from './access-fences.js';
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-calendar-fences-'));
  fs.chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
};

describe('S03 durable host calendar access fence', () => {
  it('retries interrupted durability before acknowledging an existing denial', () => {
    const root = directory(),
      id = randomUUID(),
      fence = CalendarAccessFences.initialize(root);
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('fixture_disk_sync_failure');
    });
    expect(() => fence.deny('scope', id, 'revoked')).toThrow('calendar_access_fence_unavailable');
    fsync.mockClear();
    fence.deny('scope', id, 'revoked');
    expect(fsync).toHaveBeenCalledTimes(2);
    expect(() => new CalendarAccessFences(root).assertOpen('scope', id)).toThrow('calendar_auth_revoked');
  });
  it('retains an access denial across reconstruction and scopes it to the exact binding', () => {
    const root = directory(),
      id = randomUUID(),
      other = randomUUID();
    const fence = CalendarAccessFences.initialize(root);
    fence.assertOpen('scope', id);
    fence.deny('scope', id, 'revoked');
    expect(() => new CalendarAccessFences(root).assertOpen('scope', id)).toThrow('calendar_auth_revoked');
    expect(() => new CalendarAccessFences(root).assertOpen('other', id)).not.toThrow();
    expect(() => new CalendarAccessFences(root).assertOpen('scope', other)).not.toThrow();
  });
  it('never creates a missing runtime journal or silently adopts unrelated files', () => {
    const root = directory();
    expect(() => new CalendarAccessFences(root)).toThrow('calendar_access_fence_unavailable');
    fs.writeFileSync(path.join(root, 'unrelated'), 'keep');
    expect(() => CalendarAccessFences.initialize(root)).toThrow('calendar_access_fence_unavailable');
  });
  it('fails closed for unsafe permissions, symlink roots and repositories', () => {
    const root = directory();
    CalendarAccessFences.initialize(root);
    fs.chmodSync(root, 0o755);
    expect(() => new CalendarAccessFences(root)).toThrow('calendar_access_fence_unavailable');
    fs.chmodSync(root, 0o700);
    const parent = directory(),
      link = path.join(parent, 'link');
    fs.symlinkSync(root, link);
    expect(() => new CalendarAccessFences(link)).toThrow('calendar_access_fence_unavailable');
    const repo = directory();
    fs.mkdirSync(path.join(repo, '.git'));
    expect(() => CalendarAccessFences.initialize(repo)).toThrow('calendar_access_fence_unavailable');
  });
  it('rejects corrupted or public fence files and strips raw filesystem errors', () => {
    const root = directory(),
      id = randomUUID(),
      fence = CalendarAccessFences.initialize(root);
    fence.deny('scope', id, 'expired');
    const name = fs.readdirSync(root).find((n) => n.endsWith('.json'))!;
    expect(name).toMatch(/^[a-f0-9]{64}\.json$/);
    fs.writeFileSync(path.join(root, name), 'PRIVATE_CREDENTIAL_CANARY');
    expect(() => fence.assertOpen('scope', id)).toThrow('calendar_access_fence_unavailable');
    try {
      fence.assertOpen('scope', id);
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_CREDENTIAL_CANARY');
      expect((error as Error).cause).toBeUndefined();
    }
  });
  it('is monotonic and refuses traversal-like identities', () => {
    const root = directory(),
      id = randomUUID(),
      fence = CalendarAccessFences.initialize(root);
    fence.deny('scope', id, 'revoked');
    fence.deny('scope', id, 'expired');
    expect(() => fence.assertOpen('scope', id)).toThrow('calendar_auth_revoked');
    expect(() => fence.deny('../scope', id, 'revoked')).toThrow('calendar_access_fence_unavailable');
    expect(() => fence.assertOpen('scope', '../escape')).toThrow('calendar_access_fence_unavailable');
    expect(() => CalendarAccessFences.initialize(root).assertOpen('scope', id)).toThrow('calendar_auth_revoked');
  });
});
