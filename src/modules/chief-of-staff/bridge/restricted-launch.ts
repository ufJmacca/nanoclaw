import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getInstallSlug } from '../../../install-slug.js';
import { digest } from '../domain/contracts.js';
import { validMissionRuntimeConfig, type MissionRuntimeBinding } from '../contracts/mission-runtime.js';
import { researchRuntimeFiles } from '../missions/runtime-files.js';
export type RestrictedLaunchInput = {
  image: string;
  sessionDirectory: string;
  configurationFile: string;
  gatewaySocket: string;
  uid: number;
  gid: number;
  entry: 'coordinator' | 'mcp' | 'research';
  subscription?: { providerDirectory: string; credentialSocket: string; turnSocket: string; contextGeneration: string };
  research?: { contextDirectory: string; binding: MissionRuntimeBinding };
};
function ownedPath(file: string, kind: 'directory' | 'file' | 'socket'): void {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || /[,\r\n\0]/.test(file) || fs.realpathSync(file) !== file)
    throw new Error('unsafe_restricted_mount');
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (kind === 'directory' ? !stat.isDirectory() : kind === 'file' ? !stat.isFile() : !stat.isSocket())
  )
    throw new Error('unsafe_restricted_mount');
}
function restrictedConfiguration(
  file: string,
  subscription?: RestrictedLaunchInput['subscription'],
  research?: RestrictedLaunchInput['research'],
): string[] {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (fs.fstatSync(fd).size > 4096) throw new Error('invalid_restricted_config');
    const config = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (research) {
      if (
        !subscription ||
        !validMissionRuntimeConfig(config) ||
        config.contextGeneration !== subscription.contextGeneration ||
        digest(config.mission) !== digest(research.binding)
      )
        throw new Error('invalid_restricted_config');
      return researchRuntimeFiles(research.contextDirectory, research.binding, config.model);
    }
    if (
      !config ||
      Array.isArray(config) ||
      config.provider !== 'codex' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(config.agentGroupId ?? '') ||
      config.assistantName !== 'CoS' ||
      config.groupName !== 'CoS' ||
      config.maxMessagesPerPrompt !== 10 ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(config.model ?? '') ||
      !config.mcpServers ||
      Array.isArray(config.mcpServers) ||
      Object.keys(config.mcpServers).length !== 0 ||
      (subscription
        ? config.runtime !== 'codex-subscription/v1' ||
          config.contextGeneration !== subscription.contextGeneration ||
          !/^[0-9a-f-]{36}$/.test(subscription.contextGeneration)
        : config.runtime !== undefined || config.contextGeneration !== undefined) ||
      Object.keys(config).some(
        (key) =>
          ![
            'provider',
            'agentGroupId',
            'assistantName',
            'groupName',
            'maxMessagesPerPrompt',
            'mcpServers',
            'model',
            'runtime',
            'contextGeneration',
          ].includes(key),
      )
    )
      throw new Error('invalid_restricted_config');
    return [];
  } finally {
    fs.closeSync(fd);
  }
}
/** Fixed policy for a host-admitted fresh CoS identity. No provider contribution or group configuration is consulted. */
export function restrictedLaunch(input: RestrictedLaunchInput): { containerName: string; args: string[] } {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(input.image) ||
    !['coordinator', 'mcp', 'research'].includes(input.entry) ||
    (input.entry === 'research' ? !input.research || !input.subscription : input.research !== undefined) ||
    !Number.isSafeInteger(input.uid) ||
    input.uid <= 0 ||
    !Number.isSafeInteger(input.gid) ||
    input.gid < 0
  )
    throw new Error('invalid_restricted_profile');
  ownedPath(input.sessionDirectory, 'directory');
  if (
    path.basename(input.sessionDirectory) !== 'cos-v1' ||
    (fs.statSync(input.sessionDirectory).mode & 0o777) !== 0o700
  )
    throw new Error('fresh_restricted_state_required');
  const inbound = path.join(input.sessionDirectory, 'inbound.db');
  ownedPath(inbound, 'file');
  ownedPath(input.configurationFile, 'file');
  ownedPath(input.gatewaySocket, 'socket');
  for (const file of [input.configurationFile, input.gatewaySocket])
    if (file.startsWith(input.sessionDirectory + '/')) throw new Error('host_control_must_be_separate');
  if (input.research) {
    const context = input.research.contextDirectory;
    const overlaps = (left: string, right: string) =>
      left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
    if (overlaps(context, input.sessionDirectory) || overlaps(context, input.subscription!.providerDirectory))
      throw new Error('unsafe_restricted_mount');
  }
  const researchFiles = restrictedConfiguration(input.configurationFile, input.subscription, input.research);
  if (input.subscription) {
    if (input.entry !== 'coordinator' && input.entry !== 'research') throw new Error('invalid_restricted_profile');
    const native = input.subscription;
    ownedPath(native.providerDirectory, 'directory');
    if (
      (fs.statSync(native.providerDirectory).mode & 0o777) !== 0o700 ||
      native.providerDirectory === input.sessionDirectory ||
      native.providerDirectory.startsWith(input.sessionDirectory + '/') ||
      input.sessionDirectory.startsWith(native.providerDirectory + '/')
    )
      throw new Error('unsafe_restricted_mount');
    for (const socket of [native.credentialSocket, native.turnSocket]) {
      ownedPath(socket, 'socket');
      if (socket.startsWith(input.sessionDirectory + '/')) throw new Error('host_control_must_be_separate');
    }
  }
  const agent = path.join(input.sessionDirectory, 'agent');
  if (!fs.existsSync(agent)) fs.mkdirSync(agent, { mode: 0o700 });
  ownedPath(agent, 'directory');
  const containerName = 'nanoclaw-cos-' + randomUUID();
  const protocol = input.entry === 'research' ? 'cos-mission-rpc/v1' : 'cos-rpc/v1';
  return {
    containerName,
    args: [
      'run',
      '--rm',
      '--pull=never',
      '--label',
      'nanoclaw-install=' + getInstallSlug(process.cwd()),
      '--label',
      'nanoclaw.cos-protocol=' + protocol,
      '--name',
      containerName,
      '--network=none',
      '--read-only',
      `--user=${input.uid}:${input.gid}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      '--memory=1g',
      '--cpus=1',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=32m',
      '--tmpfs',
      `/home/node:rw,nosuid,nodev,size=64m,uid=${input.uid},gid=${input.gid}`,
      ...(input.subscription && input.entry === 'coordinator'
        ? ['--tmpfs', `/run/cos:rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=${input.uid},gid=${input.gid}`]
        : []),
      '-e',
      'HOME=/home/node',
      '-e',
      'NANOCLAW_COS_PROTOCOL=' + protocol,
      '--mount',
      `type=bind,src=${input.sessionDirectory},dst=/workspace`,
      '--mount',
      `type=bind,src=${inbound},dst=/workspace/inbound.db,readonly`,
      '--mount',
      `type=bind,src=${input.configurationFile},dst=/workspace/agent/container.json,readonly`,
      '--mount',
      `type=bind,src=${input.gatewaySocket},dst=/run/cos/${input.subscription ? 'subscription' : 'model'}.sock,readonly`,
      ...(input.subscription
        ? [
            '--mount',
            `type=bind,src=${input.subscription.providerDirectory},dst=/home/node/.codex`,
            '--mount',
            `type=bind,src=${input.subscription.credentialSocket},dst=/run/nanoclaw/codex-credentials.sock,readonly`,
            '--mount',
            `type=bind,src=${input.subscription.turnSocket},dst=/run/cos/turn.sock,readonly`,
          ]
        : []),
      ...researchFiles.flatMap((file) => [
        '--mount',
        `type=bind,src=${file},dst=/run/cos/mission/${path.basename(file)},readonly`,
      ]),
      '-w',
      '/workspace/agent',
      '--entrypoint',
      '/usr/bin/tini',
      ...(input.entry === 'mcp' ? ['-i'] : []),
      input.image,
      '--',
      'bun',
      input.entry === 'mcp'
        ? '/app/src/cos-mcp.ts'
        : input.entry === 'research'
          ? '/app/src/cos-mission-runner.ts'
          : '/app/src/cos-runner.ts',
    ],
  };
}
