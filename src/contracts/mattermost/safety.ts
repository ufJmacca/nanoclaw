export interface MattermostContractMount {
  readonly type: 'bind' | 'tmpfs' | 'volume';
  readonly source?: string;
  readonly target: string;
}

export interface MattermostContractService {
  readonly name: string;
  readonly privileged?: boolean;
  readonly networkMode?: string;
  readonly ports?: readonly { readonly hostIp?: string; readonly target?: number; readonly published?: string }[];
  readonly mounts?: readonly MattermostContractMount[];
}

export interface MattermostContractNetwork {
  readonly name: string;
  readonly external?: boolean;
  readonly internal?: boolean;
}

export interface MattermostContractSafetyInput {
  readonly callerEnvironment: Readonly<Record<string, string | undefined>>;
  readonly endpoint: string;
  readonly dockerContext: string | undefined;
  readonly dockerHost?: string;
  readonly hostArchitecture: string;
  readonly images: {
    readonly mattermost: string;
    readonly postgres: string;
  };
  readonly services: readonly MattermostContractService[];
  readonly networks: readonly MattermostContractNetwork[];
}

export const MATTERMOST_CONTRACT_IMAGE =
  'mattermost/mattermost-team-edition:11.7.6@sha256:f9f59fd070b33dda9485c9e6d3249f5f0036720efecbd0c76d45f71c29291456';
export const POSTGRES_CONTRACT_IMAGE =
  'postgres:18-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7';

const FORBIDDEN_CALLER_ENVIRONMENT_KEYS = ['MATTERMOST_URL', 'MATTERMOST_BOT_TOKEN', 'MATTERMOST_INSTANCE'] as const;
const OFFICIAL_PINNED_MATTERMOST_IMAGE =
  /^(?:docker\.io\/)?mattermost\/mattermost-team-edition:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[a-f0-9]{64}$/;
const OFFICIAL_PINNED_POSTGRES_IMAGE =
  /^(?:(?:docker\.io\/)?library\/)?postgres:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[a-f0-9]{64}$/;

function isDockerSocketPath(value: string | undefined): boolean {
  return value === 'docker.sock' || value?.endsWith('/docker.sock') === true;
}

function isLocalDockerHost(value: string | undefined): boolean {
  return value === undefined || value === '' || value === 'unix:///var/run/docker.sock';
}

function isDefaultDockerContext(value: string | undefined): boolean {
  return value === undefined || value === '' || value === 'default';
}

export function assertSafeMattermostContractEnvironment(input: MattermostContractSafetyInput): void {
  for (const key of FORBIDDEN_CALLER_ENVIRONMENT_KEYS) {
    if (input.callerEnvironment[key] !== undefined) {
      throw new Error(`Caller-supplied Mattermost configuration is forbidden: ${key}`);
    }
  }

  if (!URL.canParse(input.endpoint)) {
    throw new Error('Mattermost contract endpoint is invalid');
  }
  const endpoint = new URL(input.endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Mattermost contract endpoint must be loopback-only');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('Mattermost contract endpoint must use HTTP');
  }
  if (endpoint.username !== '' || endpoint.password !== '') {
    throw new Error('Mattermost contract endpoint must not contain credentials');
  }

  if (!isDefaultDockerContext(input.dockerContext) || !isDefaultDockerContext(input.callerEnvironment.DOCKER_CONTEXT)) {
    throw new Error('Mattermost contract tests require the local default Docker context');
  }

  if (!isLocalDockerHost(input.dockerHost) || !isLocalDockerHost(input.callerEnvironment.DOCKER_HOST)) {
    throw new Error('Mattermost contract tests require a local Docker daemon');
  }

  if (input.hostArchitecture !== 'amd64' && input.hostArchitecture !== 'x64') {
    throw new Error('Mattermost contract tests require an amd64 host');
  }

  if (!OFFICIAL_PINNED_MATTERMOST_IMAGE.test(input.images.mattermost)) {
    throw new Error('Mattermost contract image must be official and digest-pinned');
  }
  if (input.images.mattermost !== MATTERMOST_CONTRACT_IMAGE) {
    throw new Error('Mattermost contract image must use the approved immutable pin');
  }
  if (!OFFICIAL_PINNED_POSTGRES_IMAGE.test(input.images.postgres)) {
    throw new Error('Postgres contract image must be official and digest-pinned');
  }
  if (input.images.postgres !== POSTGRES_CONTRACT_IMAGE) {
    throw new Error('Postgres contract image must use the approved immutable pin');
  }

  for (const service of input.services) {
    if (service.privileged === true) {
      throw new Error(`Mattermost contract services must not be privileged: ${service.name}`);
    }
    if (service.networkMode === 'host') {
      throw new Error(`Mattermost contract services must not use host networking: ${service.name}`);
    }
    if (service.networkMode !== undefined && service.networkMode !== 'bridge') {
      throw new Error(`Mattermost contract services must use an isolated bridge network: ${service.name}`);
    }
    if ((service.ports ?? []).some((port) => !port.hostIp || !['127.0.0.1', '::1'].includes(port.hostIp))) {
      throw new Error(`Mattermost contract service ports must be loopback-only: ${service.name}`);
    }
    const mounts = service.mounts ?? [];
    if (mounts.some((mount) => isDockerSocketPath(mount.source) || isDockerSocketPath(mount.target))) {
      throw new Error(`Mattermost contract services must not mount the Docker socket: ${service.name}`);
    }
    if (mounts.some((mount) => mount.type === 'bind')) {
      throw new Error(`Mattermost contract services must not use host bind mounts: ${service.name}`);
    }
  }

  for (const network of input.networks) {
    if (network.external === true) {
      throw new Error(`Mattermost contract networks must not be external: ${network.name}`);
    }
    if (network.internal !== true) {
      throw new Error(`Mattermost contract networks must be internal: ${network.name}`);
    }
  }
}
