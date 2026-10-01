import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
  it('keeps an actually killed provider-check process closed on reconstruction', async () => {
    const root = directory(),
      id = randomUUID();
    CalendarAccessFences.initialize(root);
    const module = new URL('./access-fences.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `const {CalendarAccessFences}=await import(${JSON.stringify(module)});await new CalendarAccessFences(process.argv[1]).runCheck('scope',process.argv[2],async()=>{process.stdout.write('ready');await new Promise(()=>{setInterval(()=>{},1000);});});`,
        root,
        id,
      ],
      { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('fixture_ended_before_ready')));
        child.stdout.once('data', (data) =>
          String(data) === 'ready' ? resolve() : reject(new Error('unexpected_fixture_output')),
        );
      });
      child.kill('SIGKILL');
      await exited;
      const restarted = new CalendarAccessFences(root);
      expect(() => restarted.assertOpen('scope', id)).toThrow('calendar_access_check_uncertain');
      await expect(restarted.runCheck('scope', id, async () => {})).rejects.toThrow('calendar_access_check_uncertain');
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });
  it('persists uncertainty before a provider check and removes it only after a settled result', async () => {
    const root = directory(),
      id = randomUUID(),
      fence = CalendarAccessFences.initialize(root);
    expect(
      await fence.runCheck('scope', id, async () => {
        fence.assertOpen('scope', id);
        expect(() => new CalendarAccessFences(root).assertOpen('scope', id)).toThrow('calendar_access_check_uncertain');
        return 'checked';
      }),
    ).toBe('checked');
    expect(() => new CalendarAccessFences(root).assertOpen('scope', id)).not.toThrow();
  });
  it('keeps cached access closed after reconstruction when denial cannot create its file', async () => {
    const root = directory(),
      id = randomUUID(),
      fence = CalendarAccessFences.initialize(root);
    await fence.runCheck('scope', id, async () => {
      const open = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
        if (String(file).endsWith('.json') && flags === 'wx') throw new Error('PRIVATE_PATH_CANARY');
        return open(file, flags, ...args);
      });
      expect(() => fence.deny('scope', id, 'revoked')).toThrow('calendar_access_fence_unavailable');
      expect(() => fence.assertOpen('scope', id)).toThrow('calendar_auth_revoked');
      vi.restoreAllMocks();
    });
    const rebuilt = new CalendarAccessFences(root);
    expect(() => rebuilt.assertOpen('scope', id)).toThrow('calendar_access_check_uncertain');
    await expect(rebuilt.runCheck('scope', id, async () => {})).rejects.toThrow('calendar_access_check_uncertain');
  });
  it('never dispatches a check before its write-ahead record is durable', async () => {
    const root = directory(),
      id = randomUUID(),
      fence = CalendarAccessFences.initialize(root),
      check = vi.fn(async () => {});
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('fixture_sync_failure');
    });
    await expect(fence.runCheck('scope', id, check)).rejects.toThrow('calendar_access_fence_unavailable');
    expect(check).not.toHaveBeenCalled();
    expect(() => new CalendarAccessFences(root).assertOpen('scope', id)).toThrow('calendar_access_check_uncertain');
  });
  it('retains interrupted checks and excludes concurrent owners without stealing their locks', async () => {
    const root = directory(),
      id = randomUUID(),
      fence = CalendarAccessFences.initialize(root);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const running = fence.runCheck('scope', id, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error('PRIVATE_PROVIDER_CANARY');
    });
    await ready;
    const second = new CalendarAccessFences(root),
      check = vi.fn(async () => {});
    await expect(second.runCheck('scope', id, check)).rejects.toThrow('calendar_access_check_busy');
    expect(check).not.toHaveBeenCalled();
    release();
    await expect(running).rejects.toThrow('calendar_access_fence_unavailable');
    expect(() => new CalendarAccessFences(root).assertOpen('scope', id)).toThrow('calendar_access_check_uncertain');
    expect(() => fence.assertOpen('scope', id)).toThrow('calendar_access_check_uncertain');
  });
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
