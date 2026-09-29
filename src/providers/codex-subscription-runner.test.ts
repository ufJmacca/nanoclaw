import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeAuthLaunch, createSubscriptionNativeCheck } from './codex-subscription-runner.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-auth-'));
  fs.writeFileSync(path.join(directory, 'auth.json'), 'synthetic-token-canary', { mode: 0o600 });
  const server = net.createServer();
  server.listen(path.join(directory, 'auth.sock'));
  await once(server, 'listening');
  fs.chmodSync(path.join(directory, 'auth.sock'), 0o600);
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    input: {
      image: 'sha256:' + 'a'.repeat(64),
      authFile: path.join(directory, 'auth.json'),
      gatewaySocket: path.join(directory, 'auth.sock'),
      model: 'gpt-6-astra',
      mode: 'check' as const,
    },
  };
}

describe('host native subscription checker', () => {
  it('mounts only staged credentials and fixed egress, never the master directory or host environment', async () => {
    const { input, directory } = await fixture();
    const launch = nativeAuthLaunch(input);
    expect(launch.args).toContain('--network=none');
    expect(launch.args).toContain('--read-only');
    expect(launch.args).toContain('--cap-drop=ALL');
    expect(launch.args).toContain('--pull=never');
    expect(launch.args.filter((value) => value.startsWith('type=bind'))).toEqual([
      `type=bind,src=${input.authFile},dst=/home/node/.codex/auth.json`,
      `type=bind,src=${input.gatewaySocket},dst=/run/cos/subscription.sock,readonly`,
    ]);
    expect(launch.args).not.toContain(directory);
    expect(launch.args.join(' ')).not.toContain('synthetic-token-canary');
    expect(launch.args.slice(-4)).toEqual(['bun', '/app/src/codex-auth.ts', 'check', 'gpt-6-astra']);
    expect(() => nativeAuthLaunch({ ...input, image: 'mutable:tag' })).toThrow();
    fs.chmodSync(input.authFile, 0o644);
    expect(() => nativeAuthLaunch(input)).toThrow();
  });
  it('runs under authority, accepts only the exact sanitized result and closes its egress', async () => {
    const { directory, input } = await fixture();
    const authority = vi.fn();
    const run = vi.fn().mockResolvedValue({ stdout: '{"status":"native_check_completed"}\n' });
    const checker = createSubscriptionNativeCheck({
      image: async () => input.image,
      model: input.model,
      assertAuthority: authority,
      run,
    });
    await checker(directory, 'refresh');
    const args = run.mock.calls[0][0] as string[];
    expect(args.at(-2)).toBe('refresh');
    expect(authority.mock.calls.length).toBeGreaterThanOrEqual(2);
    const mount = args.find((x) => x.endsWith('dst=/run/cos/subscription.sock,readonly'))!;
    const socket = mount.split('src=')[1].split(',')[0];
    expect(fs.existsSync(socket)).toBe(false);
  });
  it('fails closed and removes the exact helper container after an uncertain execution', async () => {
    const { directory, input } = await fixture();
    const run = vi.fn().mockRejectedValueOnce(Error('private native output')).mockResolvedValue({ stdout: '' });
    const checker = createSubscriptionNativeCheck({
      image: async () => input.image,
      model: input.model,
      assertAuthority: () => {},
      run,
    });
    await expect(checker(directory, 'refresh')).rejects.toThrow('subscription_native_check_failed');
    const launch = run.mock.calls[0][0] as string[];
    expect(run.mock.calls[1][0]).toEqual(['rm', '--force', launch[launch.indexOf('--name') + 1]]);
  });
  it('refuses lost authority before starting Docker', async () => {
    const { directory, input } = await fixture();
    const run = vi.fn();
    const checker = createSubscriptionNativeCheck({
      image: async () => input.image,
      model: input.model,
      assertAuthority: () => {
        throw Error('lost authority');
      },
      run,
    });
    await expect(checker(directory, 'check')).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('does not try to remove a helper known to have exited when its receipt is invalid', async () => {
    const { directory, input } = await fixture();
    const run = vi.fn().mockResolvedValue({ stdout: 'private unexpected output' });
    const checker = createSubscriptionNativeCheck({
      image: async () => input.image,
      model: input.model,
      assertAuthority: () => {},
      run,
    });
    await expect(checker(directory, 'check')).rejects.toThrow('subscription_native_check_failed');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('reconciles an already removed failed helper, but refuses an unconfirmed survivor', async () => {
    const { directory, input } = await fixture();
    for (const remaining of ['', 'container-id']) {
      const run = vi
        .fn()
        .mockRejectedValueOnce(Error('run failed'))
        .mockRejectedValueOnce(Error('remove failed'))
        .mockResolvedValueOnce({ stdout: remaining });
      const checker = createSubscriptionNativeCheck({
        image: async () => input.image,
        model: input.model,
        assertAuthority: () => {},
        run,
      });
      await expect(checker(directory, 'refresh')).rejects.toThrow(
        remaining ? 'subscription_native_exit_unconfirmed' : 'subscription_native_check_failed',
      );
      const launch = run.mock.calls[0][0] as string[];
      expect(run.mock.calls[2][0]).toEqual([
        'container',
        'ls',
        '-a',
        '--filter',
        `name=^/${launch[launch.indexOf('--name') + 1]}$`,
        '--format',
        '{{.ID}}',
      ]);
    }
  });
});
