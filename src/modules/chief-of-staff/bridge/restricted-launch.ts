import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export type RestrictedLaunchInput = {
  image: string;
  sessionDirectory: string;
  configurationFile: string;
  gatewaySocket: string;
  uid: number;
  gid: number;
  entry: 'coordinator' | 'mcp';
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
function restrictedConfiguration(file: string): void {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (fs.fstatSync(fd).size > 4096) throw new Error('invalid_restricted_config');
    const config = JSON.parse(fs.readFileSync(fd, 'utf8'));
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
          ].includes(key),
      )
    )
      throw new Error('invalid_restricted_config');
  } finally {
    fs.closeSync(fd);
  }
}
/** Fixed policy for a host-admitted fresh CoS identity. No provider contribution or group configuration is consulted. */
export function restrictedLaunch(input: RestrictedLaunchInput): { containerName: string; args: string[] } {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(input.image) ||
    !['coordinator', 'mcp'].includes(input.entry) ||
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
  restrictedConfiguration(input.configurationFile);
  const agent = path.join(input.sessionDirectory, 'agent');
  if (!fs.existsSync(agent)) fs.mkdirSync(agent, { mode: 0o700 });
  ownedPath(agent, 'directory');
  const containerName = 'nanoclaw-cos-' + randomUUID();
  return {
    containerName,
    args: [
      'run',
      '--rm',
      '--pull=never',
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
      '-e',
      'HOME=/home/node',
      '-e',
      'NANOCLAW_COS_PROTOCOL=cos-rpc/v1',
      '--mount',
      `type=bind,src=${input.sessionDirectory},dst=/workspace`,
      '--mount',
      `type=bind,src=${inbound},dst=/workspace/inbound.db,readonly`,
      '--mount',
      `type=bind,src=${input.configurationFile},dst=/workspace/agent/container.json,readonly`,
      '--mount',
      `type=bind,src=${input.gatewaySocket},dst=/run/cos/model.sock,readonly`,
      '-w',
      '/workspace/agent',
      '--entrypoint',
      '/usr/bin/tini',
      ...(input.entry === 'mcp' ? ['-i'] : []),
      input.image,
      '--',
      'bun',
      input.entry === 'mcp' ? '/app/src/cos-mcp.ts' : '/app/src/cos-runner.ts',
    ],
  };
}
