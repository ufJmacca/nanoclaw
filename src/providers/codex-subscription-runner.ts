import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeHostEnvironment } from '../host-environment.js';
import { getInstallSlug } from '../install-slug.js';
import { startSubscriptionEgress } from '../modules/chief-of-staff/bridge/subscription-egress.js';

type Mode = 'check' | 'refresh';
type Input = { image: string; authFile: string; gatewaySocket: string; model: string; mode: Mode };
type Run = (args: string[]) => Promise<{ stdout: string }>;

function ownedPrivate(file: string, socket: boolean) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || /[,\r\n\0]/.test(file) || fs.realpathSync(file) !== file)
    throw new Error('unsafe_subscription_mount');
  const stat = fs.lstatSync(file),
    parent = fs.lstatSync(path.dirname(file));
  if (
    stat.uid !== process.getuid?.() ||
    parent.uid !== stat.uid ||
    (stat.mode & 0o077) !== 0 ||
    (parent.mode & 0o077) !== 0 ||
    (socket ? !stat.isSocket() : !stat.isFile())
  )
    throw new Error('unsafe_subscription_mount');
}

/** A trusted auth process gets one staged file, never the primary login or a session history. */
export function nativeAuthLaunch(input: Input): { name: string; args: string[] } {
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (
    !uid ||
    gid === undefined ||
    !/^sha256:[a-f0-9]{64}$/.test(input.image) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.model) ||
    !['check', 'refresh'].includes(input.mode)
  )
    throw new Error('invalid_subscription_native_profile');
  ownedPrivate(input.authFile, false);
  ownedPrivate(input.gatewaySocket, true);
  const name = 'nanoclaw-auth-' + randomUUID();
  return {
    name,
    args: [
      'run',
      '--rm',
      '--pull=never',
      '--name',
      name,
      '--label',
      'nanoclaw-install=' + getInstallSlug(process.cwd()),
      '--label',
      'nanoclaw.native-auth=codex-subscription/v1',
      '--network=none',
      '--read-only',
      `--user=${uid}:${gid}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      '--memory=512m',
      '--cpus=1',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=32m',
      '--tmpfs',
      `/home/node:rw,nosuid,nodev,size=16m,uid=${uid},gid=${gid}`,
      '--tmpfs',
      `/home/node/.codex:rw,nosuid,nodev,size=16m,uid=${uid},gid=${gid},mode=700`,
      '-e',
      'HOME=/home/node',
      '-e',
      'NANOCLAW_NATIVE_AUTH=codex-subscription/v1',
      '--mount',
      `type=bind,src=${input.authFile},dst=/home/node/.codex/auth.json`,
      '--mount',
      `type=bind,src=${input.gatewaySocket},dst=/run/cos/subscription.sock,readonly`,
      '-w',
      '/tmp',
      '--entrypoint',
      '/usr/bin/tini',
      input.image,
      '--',
      'bun',
      '/app/src/codex-auth.ts',
      input.mode,
      input.model,
    ],
  };
}

const execute = promisify(execFile);
const docker: Run = async (args) =>
  execute('docker', args, {
    env: safeHostEnvironment('docker'),
    encoding: 'utf8',
    timeout: 45000,
    maxBuffer: 16384,
  });

/** Adapter for createSubscriptionAuthStore.nativeCheck; caller selects the verified release image. */
export function createSubscriptionNativeCheck(options: {
  image(): Promise<string>;
  model: string;
  assertAuthority(): void;
  /** Trusted test seam; production invokes only the local Docker engine. */
  run?: Run;
}) {
  return async (directory: string, mode: Mode): Promise<void> => {
    options.assertAuthority();
    const image = await options.image();
    options.assertAuthority();
    const transport = fs.mkdtempSync(path.join(directory, 'transport-'));
    let gateway: Awaited<ReturnType<typeof startSubscriptionEgress>> | undefined;
    let launch: ReturnType<typeof nativeAuthLaunch> | undefined;
    let exited = false;
    const run = options.run ?? docker;
    try {
      const socketPath = path.join(transport, 'auth.sock');
      gateway = await startSubscriptionEgress({
        socketPath,
        role: 'auth',
        authorize: async () => {
          try {
            options.assertAuthority();
            return true;
            // eslint-disable-next-line no-catch-all/no-catch-all -- Every authority error revokes transport without exposing private host details.
          } catch {
            return false;
          }
        },
      });
      launch = nativeAuthLaunch({
        image,
        authFile: path.join(directory, 'auth.json'),
        gatewaySocket: socketPath,
        model: options.model,
        mode,
      });
      options.assertAuthority();
      const result = await run(launch.args);
      exited = true;
      if (result.stdout.trim() !== '{"status":"native_check_completed"}')
        throw new Error('invalid_native_check_receipt');
      options.assertAuthority();
    } catch {
      if (launch && !exited) {
        try {
          await run(['rm', '--force', launch.name]);
        } catch {
          let absent = false;
          try {
            absent =
              (
                await run(['container', 'ls', '-a', '--filter', `name=^/${launch.name}$`, '--format', '{{.ID}}'])
              ).stdout.trim() === '';
            // eslint-disable-next-line no-catch-all/no-catch-all -- Failure to inspect is not evidence that the native writer stopped.
          } catch {
            /* retain uncertainty */
          }
          // eslint-disable-next-line preserve-caught-error -- Docker errors can contain credential paths/output; expose only the stable uncertain-exit result.
          if (!absent) throw new Error('subscription_native_exit_unconfirmed');
        }
      }
      // eslint-disable-next-line preserve-caught-error -- Native errors can contain authentication data; the private store journal records the uncertain phase.
      throw new Error('subscription_native_check_failed');
    } finally {
      await gateway?.close();
      fs.rmSync(transport, { recursive: true, force: true });
    }
  };
}
