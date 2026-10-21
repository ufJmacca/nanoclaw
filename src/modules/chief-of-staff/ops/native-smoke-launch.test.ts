import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';

const { docker } = vi.hoisted(() => ({ docker: vi.fn() }));
vi.mock('child_process', () => ({ execSync: (...args: unknown[]) => docker(...args) }));
vi.mock('../../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { cleanupOrphans } from '../../../container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from '../../../config.js';
import { restrictedLaunch, type RestrictedLaunchInput } from '../bridge/restricted-launch.js';
import { nativeSmokeLaunch } from './native-smoke-launch.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.clearAllMocks();
});

async function fixture(): Promise<RestrictedLaunchInput> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-smoke-launch-'));
  cleanup.push(async () => fs.rmSync(root, { recursive: true, force: true }));
  const session = path.join(root, 'cos-v1');
  fs.mkdirSync(session, { mode: 0o700 });
  fs.writeFileSync(path.join(session, 'inbound.db'), '', { mode: 0o600 });
  const configurationFile = path.join(root, 'config.json');
  fs.writeFileSync(
    configurationFile,
    JSON.stringify({
      provider: 'codex',
      model: 'fixture-model',
      agentGroupId: 'fixture-smoke',
      assistantName: 'CoS',
      groupName: 'CoS',
      maxMessagesPerPrompt: 10,
      mcpServers: {},
    }),
    { mode: 0o600 },
  );
  const gatewaySocket = path.join(root, 'model.sock');
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(gatewaySocket, resolve);
  });
  cleanup.push(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );
  return {
    image: 'sha256:' + 'a'.repeat(64),
    sessionDirectory: session,
    configurationFile,
    gatewaySocket,
    uid: process.getuid!(),
    gid: process.getgid!(),
    entry: 'mcp',
  };
}

it('startup cleanup stops an old runtime worker without stopping the active native health probe', async () => {
  const input = await fixture();
  const launch = nativeSmokeLaunch(input);
  const labels = launch.args.filter((arg) => arg.startsWith('nanoclaw-install='));
  expect(labels).toHaveLength(1);
  const containers = [
    { name: 'nanoclaw-old-runtime', label: CONTAINER_INSTALL_LABEL, running: true },
    { name: launch.containerName, label: labels[0], running: true },
  ];
  docker.mockImplementation((command: string) => {
    if (command === `docker ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`)
      return containers
        .filter((item) => item.running && item.label === CONTAINER_INSTALL_LABEL)
        .map((item) => item.name)
        .join('\n');
    const match = /^docker stop -t 1 ([a-zA-Z0-9_.-]+)$/.exec(command);
    const selected = match && containers.find((item) => item.name === match[1]);
    if (!selected) throw Error('unexpected_docker_command');
    selected.running = false;
    return '';
  });

  cleanupOrphans();

  expect(containers[0].running).toBe(false);
  expect(containers[1].running).toBe(true);
  // Probe ownership is the only profile difference: mounts, user, network,
  // resource limits, entry point and environment keep their runtime restrictions.
  const profile = (args: string[]) =>
    args.filter((arg, index) => !arg.startsWith('nanoclaw-install=') && args[index - 1] !== '--name');
  expect(profile(launch.args)).toEqual(profile(restrictedLaunch(input).args));
});

it.each(['coordinator', 'research'] as const)('cannot use probe ownership for a %s worker', async (entry) => {
  const input = await fixture();
  expect(() => nativeSmokeLaunch({ ...input, entry })).toThrow(/^native_smoke_profile_required$/);
});
