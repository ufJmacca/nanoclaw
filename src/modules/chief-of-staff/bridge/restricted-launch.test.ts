import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { restrictedLaunch } from './restricted-launch.js';
import { getInstallSlug } from '../../../install-slug.js';
import { digest } from '../domain/contracts.js';
import { RESEARCH_TEMPLATE, sealResearchWorkOrder } from '../missions/work-order.js';
import { MISSION_DEFAULT_LIMITS } from '../contracts/mission-protocol.js';
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
function research() {
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const order = sealResearchWorkOrder({
    missionId: 'mission-fixture',
    request: {
      question: 'Compare options.',
      goal_id: null,
      project_id: null,
      sources: [{ source_id: 'note', revision_id: 'revision' }],
      acceptance_criteria: [{ id: 'tradeoffs', description: 'Compare.' }],
      limits: { ...MISSION_DEFAULT_LIMITS },
    },
    origin: {
      scopeId: 'scope',
      ownerId: 'owner',
      sessionId: 'parent',
      agentGroupId: 'parent-group',
      ingressId: 'event',
      bindingDigest: 'b'.repeat(64),
      contextGeneration: 'parent-context',
    },
    related: { goal: null, project: null },
    sources: [
      {
        source_id: 'note',
        revision_id: 'revision',
        source_version: 1,
        revision_digest: 'c'.repeat(64),
        title: 'Notes',
        status: 'current',
        chunks: [{ ordinal: 0, start_line: 1, end_line: 1, text: 'mission-A-canary' }],
      },
    ],
    provider: { profile: RESEARCH_TEMPLATE.providerProfile, model: 'fixture-model', policyDigest: 'd'.repeat(64) },
    reviewedTemplateDigest: digest(RESEARCH_TEMPLATE),
    issuedAt: '2026-10-02T01:00:00.000Z',
  });
  const contextDirectory = path.join(root, 'context'),
    providerDirectory = path.join(root, 'provider');
  fs.mkdirSync(contextDirectory, { mode: 0o700 });
  fs.mkdirSync(providerDirectory, { mode: 0o700 });
  for (const [name, value] of Object.entries({
    'work-order.json': order.body,
    'context.json': order.context,
    'template.json': RESEARCH_TEMPLATE,
  }))
    fs.writeFileSync(path.join(contextDirectory, name), JSON.stringify(value), { mode: 0o400 });
  const binding = {
    missionId: order.body.missionId,
    attemptId,
    inputId: 'input-one',
    generation: 1,
    workOrderDigest: order.digest,
    contextDigest: order.body.contextDigest,
    templateDigest: digest(RESEARCH_TEMPLATE),
  };
  fs.writeFileSync(
    config,
    JSON.stringify({
      provider: 'codex',
      model: 'fixture-model',
      runtime: 'codex-subscription/v1',
      profile: 'research',
      contextGeneration: attemptId,
      agentGroupId: 'child',
      assistantName: 'CoS Research',
      groupName: 'CoS Research',
      maxMessagesPerPrompt: 1,
      mcpServers: {},
      mission: binding,
    }),
  );
  return {
    ...input(),
    entry: 'research' as const,
    research: { contextDirectory, binding },
    subscription: { providerDirectory, credentialSocket: socket, turnSocket: socket, contextGeneration: attemptId },
  };
}
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
  it('mounts durable native context and only the fixed credential and attempt sockets for subscription execution', () => {
    const providerDirectory = path.join(root, 'native-context');
    fs.mkdirSync(providerDirectory, { mode: 0o700 });
    const generation = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(config, 'utf8')),
        runtime: 'codex-subscription/v1',
        contextGeneration: generation,
      }),
    );
    const profile = { providerDirectory, credentialSocket: socket, turnSocket: socket, contextGeneration: generation };
    const launch = restrictedLaunch({ ...input(), subscription: profile });
    expect(launch.args).toContain(`type=bind,src=${providerDirectory},dst=/home/node/.codex`);
    expect(launch.args).toContain(`type=bind,src=${socket},dst=/run/cos/subscription.sock,readonly`);
    expect(launch.args).toContain(`type=bind,src=${socket},dst=/run/nanoclaw/codex-credentials.sock,readonly`);
    expect(launch.args).toContain(`type=bind,src=${socket},dst=/run/cos/turn.sock,readonly`);
    expect(() => restrictedLaunch(input())).toThrow('invalid_restricted_config');
    expect(() =>
      restrictedLaunch({ ...input(), subscription: { ...profile, contextGeneration: 'changed' } }),
    ).toThrow();
    fs.chmodSync(providerDirectory, 0o755);
    expect(() => restrictedLaunch({ ...input(), subscription: profile })).toThrow();
  });
  it('launches a pinned baked entry with no network, credentials, Docker socket, global history or checkout overlays', () => {
    const launch = restrictedLaunch(input());
    expect(launch.args).toContain('nanoclaw-install=' + getInstallSlug(process.cwd()));
    for (const flag of [
      '--network=none',
      '--read-only',
      '--pull=never',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
    ])
      expect(launch.args).toContain(flag);
    expect(launch.args).toContain(image);
    expect(launch.args).toContain('nanoclaw.cos-protocol=cos-rpc/v1');
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

describe('S05 specialist launch policy', () => {
  it('mounts only the three exact immutable admitted files with an isolated provider directory', () => {
    const profile = research();
    fs.writeFileSync(path.join(profile.research.contextDirectory, 'sibling-secret'), 'mission-B-canary');
    const launch = restrictedLaunch(profile);
    expect(launch.args).toContain('/app/src/cos-mission-runner.ts');
    expect(launch.args).toContain('NANOCLAW_COS_PROTOCOL=cos-mission-rpc/v1');
    expect(launch.args).toContain('nanoclaw.cos-protocol=cos-mission-rpc/v1');
    for (const name of ['context.json', 'work-order.json', 'template.json'])
      expect(launch.args).toContain(
        `type=bind,src=${profile.research.contextDirectory}/${name},dst=/run/cos/mission/${name},readonly`,
      );
    expect(launch.args.filter((v) => v.startsWith('type=bind'))).toHaveLength(10);
    for (const denied of ['sibling-secret', 'mission-B-canary', '/workspace/global', '/var/run/docker.sock', 'COS_PG'])
      expect(launch.args.join(' ')).not.toContain(denied);
    for (const required of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges'])
      expect(launch.args).toContain(required);
  });
  it('refuses missing native subscription, coordinator fallback and cross-attempt provider/config bindings', () => {
    const profile = research();
    expect(() => restrictedLaunch({ ...profile, subscription: undefined })).toThrow();
    expect(() => restrictedLaunch({ ...profile, entry: 'coordinator' })).toThrow();
    expect(() => restrictedLaunch({ ...profile, research: undefined })).toThrow();
    expect(() =>
      restrictedLaunch({
        ...profile,
        subscription: { ...profile.subscription, contextGeneration: '22222222-2222-4222-8222-222222222222' },
      }),
    ).toThrow();
    expect(() =>
      restrictedLaunch({
        ...profile,
        research: { ...profile.research, binding: { ...profile.research.binding, inputId: 'other-input' } },
      }),
    ).toThrow();
  });
  it('refuses tampered, writable or linked source artifacts before constructing mounts', () => {
    const profile = research(),
      context = path.join(profile.research.contextDirectory, 'context.json');
    fs.chmodSync(context, 0o600);
    expect(() => restrictedLaunch(profile)).toThrow();
    fs.writeFileSync(context, '{"sources":[]}');
    fs.chmodSync(context, 0o400);
    expect(() => restrictedLaunch(profile)).toThrow();
    fs.unlinkSync(context);
    fs.symlinkSync(path.join(profile.research.contextDirectory, 'work-order.json'), context);
    expect(() => restrictedLaunch(profile)).toThrow();
  });
  it('rejects extra configuration, changed model, mutable context inside workspace and provider/context overlap', () => {
    const profile = research(),
      original = JSON.parse(fs.readFileSync(config, 'utf8'));
    for (const patch of [
      { env: { SECRET: 'fixture' } },
      { mcpServers: { arbitrary: {} } },
      { maxMessagesPerPrompt: 10 },
      { model: 'other-model' },
      { profile: 'coordinator' },
    ]) {
      fs.writeFileSync(config, JSON.stringify({ ...original, ...patch }));
      expect(() => restrictedLaunch(profile)).toThrow();
    }
    fs.writeFileSync(config, JSON.stringify(original));
    expect(() =>
      restrictedLaunch({
        ...profile,
        subscription: { ...profile.subscription, providerDirectory: profile.research.contextDirectory },
      }),
    ).toThrow();
    expect(() =>
      restrictedLaunch({ ...profile, subscription: { ...profile.subscription, providerDirectory: session } }),
    ).toThrow();
  });
});
