import { describe, expect, it } from 'vitest';

import {
  assertSafeMattermostContractEnvironment,
  MATTERMOST_CONTRACT_IMAGE,
  POSTGRES_CONTRACT_IMAGE,
  type MattermostContractSafetyInput,
} from './safety.js';

const SAFE_INPUT: MattermostContractSafetyInput = {
  callerEnvironment: {},
  endpoint: 'http://127.0.0.1:8065',
  dockerContext: 'default',
  hostArchitecture: 'amd64',
  images: {
    mattermost: MATTERMOST_CONTRACT_IMAGE,
    postgres: POSTGRES_CONTRACT_IMAGE,
  },
  services: [],
  networks: [],
};

describe('Mattermost contract environment safety', () => {
  it.each(['amd64', 'x64'])('accepts the isolated disposable baseline on %s', (hostArchitecture) => {
    expect(() => assertSafeMattermostContractEnvironment({ ...SAFE_INPUT, hostArchitecture })).not.toThrow();
  });

  it('rejects a caller-supplied Mattermost URL', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        callerEnvironment: { MATTERMOST_URL: 'https://mattermost.example.com' },
      }),
    ).toThrow('Caller-supplied Mattermost configuration is forbidden: MATTERMOST_URL');
  });

  it('rejects a caller-supplied Mattermost bot token', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        callerEnvironment: { MATTERMOST_BOT_TOKEN: 'caller-token' },
      }),
    ).toThrow('Caller-supplied Mattermost configuration is forbidden: MATTERMOST_BOT_TOKEN');
  });

  it('rejects a caller-supplied Mattermost instance', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        callerEnvironment: { MATTERMOST_INSTANCE: 'production' },
      }),
    ).toThrow('Caller-supplied Mattermost configuration is forbidden: MATTERMOST_INSTANCE');
  });

  it('rejects a non-loopback Mattermost endpoint', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        endpoint: 'https://mattermost.example.com',
      }),
    ).toThrow('Mattermost contract endpoint must be loopback-only');
  });

  it('rejects a malformed endpoint without reflecting it', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        endpoint: 'not a URL with caller-token',
      }),
    ).toThrow('Mattermost contract endpoint is invalid');
  });

  it('rejects a non-HTTP loopback endpoint', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        endpoint: 'ftp://127.0.0.1:8065',
      }),
    ).toThrow('Mattermost contract endpoint must use HTTP');
  });

  it('rejects credentials embedded in the loopback endpoint', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        endpoint: 'http://contract-admin:caller-token@127.0.0.1:8065',
      }),
    ).toThrow('Mattermost contract endpoint must not contain credentials');
  });

  it('rejects a non-default Docker context', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        dockerContext: 'production-cluster',
      }),
    ).toThrow('Mattermost contract tests require the local default Docker context');
  });

  it('rejects Compose networks that are not internally isolated', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        networks: [{ name: 'contract', internal: false }] as Array<
          MattermostContractSafetyInput['networks'][number] & { internal: boolean }
        >,
      }),
    ).toThrow('Mattermost contract networks must be internal: contract');
  });

  it('rejects host-networked Compose services', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        services: [{ name: 'mattermost', networkMode: 'host' }] as Array<
          MattermostContractSafetyInput['services'][number] & { networkMode: string }
        >,
      }),
    ).toThrow('Mattermost contract services must not use host networking: mattermost');
  });

  it('rejects Compose services that join another container network namespace', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        services: [{ name: 'mattermost', networkMode: 'container:shared-service' }],
      }),
    ).toThrow('Mattermost contract services must use an isolated bridge network: mattermost');
  });

  it('rejects Compose ports published beyond loopback', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        services: [{ name: 'mattermost', ports: [{ hostIp: '0.0.0.0', target: 8065, published: '8065' }] }] as Array<
          MattermostContractSafetyInput['services'][number] & {
            ports: Array<{ hostIp: string; target: number; published: string }>;
          }
        >,
      }),
    ).toThrow('Mattermost contract service ports must be loopback-only: mattermost');
  });

  it('rejects a non-default Docker context inherited from the caller environment', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        callerEnvironment: { DOCKER_CONTEXT: 'production-cluster' },
      }),
    ).toThrow('Mattermost contract tests require the local default Docker context');
  });

  it('rejects a remote Docker host', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        dockerHost: 'tcp://10.0.0.2:2375',
      }),
    ).toThrow('Mattermost contract tests require a local Docker daemon');
  });

  it('rejects a remote Docker host inherited from the caller environment', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        callerEnvironment: { DOCKER_HOST: 'ssh://production.example.com' },
      }),
    ).toThrow('Mattermost contract tests require a local Docker daemon');
  });

  it('rejects an unpinned Mattermost image', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        images: {
          ...SAFE_INPUT.images,
          mattermost: 'mattermost/mattermost-team-edition:11.7.6',
        },
      }),
    ).toThrow('Mattermost contract image must be official and digest-pinned');
  });

  it('rejects a digest-pinned image from an unofficial Mattermost repository', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        images: {
          ...SAFE_INPUT.images,
          mattermost:
            'registry.example.com/mattermost-team-edition:11.7.6@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }),
    ).toThrow('Mattermost contract image must be official and digest-pinned');
  });

  it('rejects an unapproved Mattermost digest', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        images: {
          ...SAFE_INPUT.images,
          mattermost:
            'mattermost/mattermost-team-edition:11.7.6@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }),
    ).toThrow('Mattermost contract image must use the approved immutable pin');
  });

  it('rejects an unpinned Postgres image', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        images: {
          ...SAFE_INPUT.images,
          postgres: 'postgres:18-alpine',
        },
      }),
    ).toThrow('Postgres contract image must be official and digest-pinned');
  });

  it('rejects a digest-pinned image from an unofficial Postgres repository', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        images: {
          ...SAFE_INPUT.images,
          postgres:
            'registry.example.com/postgres:18-alpine@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      }),
    ).toThrow('Postgres contract image must be official and digest-pinned');
  });

  it('rejects an unapproved Postgres digest', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        images: {
          ...SAFE_INPUT.images,
          postgres: 'postgres:18-alpine@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      }),
    ).toThrow('Postgres contract image must use the approved immutable pin');
  });

  it('rejects host bind mounts', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        services: [
          {
            name: 'mattermost',
            mounts: [{ type: 'bind', source: '/tmp/mattermost-data', target: '/mattermost/data' }],
          },
        ],
      }),
    ).toThrow('Mattermost contract services must not use host bind mounts: mattermost');
  });

  it('rejects Docker socket mounts even when their type is mislabeled', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        services: [
          {
            name: 'mattermost',
            mounts: [
              {
                type: 'volume',
                source: 'misclassified-socket',
                target: '/var/run/docker.sock',
              },
            ],
          },
        ],
      }),
    ).toThrow('Mattermost contract services must not mount the Docker socket: mattermost');
  });

  it('rejects privileged services', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        services: [{ name: 'mattermost', privileged: true }],
      }),
    ).toThrow('Mattermost contract services must not be privileged: mattermost');
  });

  it('rejects external Compose networks', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        networks: [{ name: 'production', external: true }],
      }),
    ).toThrow('Mattermost contract networks must not be external: production');
  });

  it('rejects direct local execution on a non-amd64 host', () => {
    expect(() =>
      assertSafeMattermostContractEnvironment({
        ...SAFE_INPUT,
        hostArchitecture: 'arm64',
      }),
    ).toThrow('Mattermost contract tests require an amd64 host');
  });
});
