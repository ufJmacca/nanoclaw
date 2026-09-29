import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { restrictedLaunch } from './restricted-launch.js';
let root: string, session: string, config: string, socket: string, server: net.Server;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-launch-'));
  session = path.join(root, 'cos-v1');
  fs.mkdirSync(session, { mode: 0o700 });
  fs.writeFileSync(path.join(session, 'inbound.db'), 'fixture');
  config = path.join(root, 'config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      provider: 'codex',
      model: 'fixture-model',
      agentGroupId: 'fixture-group',
      assistantName: 'CoS',
      groupName: 'CoS',
      maxMessagesPerPrompt: 10,
      mcpServers: {},
    }),
    { mode: 0o600 },
  );
  socket = path.join(root, 'model.sock');
  server = net.createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});
const image = 'sha256:' + 'a'.repeat(64);
function input() {
  return {
    image,
    sessionDirectory: session,
    configurationFile: config,
    gatewaySocket: socket,
    uid: process.getuid!(),
    gid: process.getgid!(),
    entry: 'coordinator' as const,
  };
}
describe('S01 restricted coordinator launch', () => {
  it('launches a pinned baked entry with no network, credentials, Docker socket, global history or checkout overlays', () => {
    const launch = restrictedLaunch(input());
    for (const flag of [
      '--network=none',
      '--read-only',
      '--pull=never',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
    ])
      expect(launch.args).toContain(flag);
    expect(launch.args).toContain(image);
    expect(launch.args).toContain('/app/src/cos-runner.ts');
    expect(launch.args.filter((v) => v.startsWith('type=bind'))).toHaveLength(4);
    const text = launch.args.join(' ');
    for (const forbidden of [
      'host.docker.internal',
      '/var/run/docker.sock',
      '/workspace/global',
      'COS_PG',
      'SSH_AUTH_SOCK',
      '/app/src,',
      '/app/skills,',
    ])
      expect(text).not.toContain(forbidden);
  });
  it('refuses mutable images, inherited history and unsafe mount paths', () => {
    expect(() => restrictedLaunch({ ...input(), image: 'fixture:latest' })).toThrow();
    expect(() => restrictedLaunch({ ...input(), sessionDirectory: root })).toThrow();
    expect(() => restrictedLaunch({ ...input(), configurationFile: config + ',dst=/host' })).toThrow();
    const original = path.join(root, 'original.db');
    fs.renameSync(path.join(session, 'inbound.db'), original);
    fs.symlinkSync(original, path.join(session, 'inbound.db'));
    expect(() => restrictedLaunch(input())).toThrow();
  });
  it('does not accept generic native tools, a provider change or embedded account credentials in its configuration', () => {
    for (const bad of [
      { provider: 'claude' },
      { provider: 'codex', mcpServers: { native: { command: 'bash' } } },
      { provider: 'codex', env: { OPENAI_API_KEY: 'synthetic-secret' } },
    ]) {
      fs.writeFileSync(config, JSON.stringify(bad));
      expect(() => restrictedLaunch(input())).toThrow('invalid_restricted_config');
    }
  });
});
