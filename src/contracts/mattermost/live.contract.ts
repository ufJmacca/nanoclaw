import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { expect, test } from 'vitest';

import {
  MattermostContractApi,
  type MattermostContractBot,
  type MattermostContractChannel,
  type MattermostContractPersonalAccessToken,
  type MattermostContractPost,
  type MattermostContractTeam,
  type MattermostContractUser,
} from './api.js';
import { parseMattermostContractWorkerEventLine } from './worker-protocol.js';

if (process.env.NANOCLAW_MM_CONTRACT_ACTIVE !== '1') {
  throw new Error('Mattermost live contracts must run through the disposable safety harness');
}

const CONTRACT_URL = 'http://127.0.0.1:8065';
const ADMIN_USERNAME = 'nanoclaw-contract-admin';
const ADMIN_PASSWORD = 'Disposable-contract-admin-2026!';
const ADMIN_EMAIL = 'nanoclaw-contract-admin@example.test';

type WorkerEvent = Record<string, unknown>;

interface WorkerWaiter {
  predicate(event: WorkerEvent): boolean;
  resolve(event: WorkerEvent): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ContractChannelState {
  channel_id: string;
  status: string;
  messaging_group_id: string;
  agent_group_id: string;
  wiring_id: string;
  folder: string;
  session: {
    id: string;
    thread_id: string | null;
    status: string;
    container_status: string;
    inboxCount: number;
  } | null;
}

class ContractWorkerClient {
  private readonly events: WorkerEvent[] = [];
  private readonly waiters: WorkerWaiter[] = [];
  private readonly output: readline.Interface;
  private failure: Error | null = null;
  private closing = false;
  private commandSequence = 0;
  readonly exit: Promise<number>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly botToken: string,
  ) {
    this.output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.output.on('line', (line) => {
      try {
        const event = parseMattermostContractWorkerEventLine(line, [botToken]);
        if (event) this.receive(event);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Mattermost contract worker output was invalid'));
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192);
      if (stderr.includes(botToken)) this.fail(new Error('Mattermost contract worker exposed its bot token'));
    });
    this.exit = new Promise((resolve) => {
      child.once('exit', (code) => {
        this.output.close();
        if (!this.closing && !this.failure) this.fail(new Error('Mattermost contract worker exited unexpectedly'));
        resolve(code ?? 1);
      });
      child.once('error', () => this.fail(new Error('Mattermost contract worker could not start')));
    });
  }

  static async start(input: {
    repoRoot: string;
    testRoot: string;
    botToken: string;
    bootstrapSubscriptions: boolean;
    channels: Array<{
      channelId: string;
      name: string;
      baseline: { postId: string; createAt: number };
    }>;
  }): Promise<{ client: ContractWorkerClient; ready: WorkerEvent }> {
    const home = path.join(input.testRoot, 'home');
    fs.mkdirSync(home, { recursive: true });
    const executable = path.join(input.repoRoot, 'node_modules', '.bin', 'tsx');
    const child = spawn(executable, [path.join(input.repoRoot, 'src/contracts/mattermost/worker.ts')], {
      cwd: input.testRoot,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? '',
        NANOCLAW_MM_CONTRACT_WORKER_CONFIG: JSON.stringify({
          botToken: input.botToken,
          bootstrapSubscriptions: input.bootstrapSubscriptions,
          channels: input.channels,
        }),
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new ContractWorkerClient(child, input.botToken);
    const ready = await client.waitFor((event) => event.kind === 'ready', 60_000);
    return { client, ready };
  }

  waitFor(predicate: (event: WorkerEvent) => boolean, timeoutMs = 30_000): Promise<WorkerEvent> {
    if (this.failure) return Promise.reject(this.failure);
    const queuedIndex = this.events.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.events.splice(queuedIndex, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter: WorkerWaiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('Mattermost contract worker event timed out'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  waitForInbound(postId: string): Promise<WorkerEvent> {
    return this.waitFor((event) => event.kind === 'inbound' && event.postId === postId);
  }

  async command(command: Omit<Record<string, unknown>, 'id'>): Promise<Record<string, unknown>> {
    const id = `command-${++this.commandSequence}`;
    const response = this.waitFor(
      (event) => (event.kind === 'command_result' || event.kind === 'command_error') && event.commandId === id,
      60_000,
    );
    this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    const event = await response;
    if (event.kind === 'command_error') {
      throw new Error(typeof event.message === 'string' ? event.message : 'Mattermost contract worker command failed');
    }
    if (!isRecord(event.result)) throw new Error('Mattermost contract worker result was invalid');
    return event.result;
  }

  async snapshot(): Promise<ContractChannelState[]> {
    const result = await this.command({ kind: 'snapshot' });
    if (!Array.isArray(result.channels)) throw new Error('Mattermost contract worker snapshot was invalid');
    return result.channels.map(parseChannelState);
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.child.exitCode === null) {
      await this.command({ kind: 'shutdown' }).catch(() => undefined);
      let timeout: ReturnType<typeof setTimeout>;
      const exitCode = await Promise.race([
        this.exit,
        new Promise<number>(
          (resolve) =>
            (timeout = setTimeout(() => {
              this.child.kill('SIGKILL');
              resolve(1);
            }, 10_000)),
        ),
      ]);
      clearTimeout(timeout!);
      if (exitCode !== 0) throw new Error('Mattermost contract worker did not stop cleanly');
    }
  }

  private receive(event: WorkerEvent): void {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(event));
    if (waiterIndex < 0) {
      this.events.push(event);
      return;
    }
    const [waiter] = this.waiters.splice(waiterIndex, 1);
    clearTimeout(waiter!.timeout);
    waiter!.resolve(event);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} was invalid`);
  return value;
}

function parseChannelState(value: unknown): ContractChannelState {
  if (!isRecord(value)) throw new Error('Mattermost contract channel state was invalid');
  let session: ContractChannelState['session'] = null;
  if (value.session !== null) {
    if (
      !isRecord(value.session) ||
      (value.session.thread_id !== null && typeof value.session.thread_id !== 'string') ||
      typeof value.session.inboxCount !== 'number' ||
      !Number.isSafeInteger(value.session.inboxCount)
    ) {
      throw new Error('Mattermost contract channel session was invalid');
    }
    session = {
      id: requiredString(value.session.id, 'Mattermost contract session identity'),
      thread_id: value.session.thread_id,
      status: requiredString(value.session.status, 'Mattermost contract session status'),
      container_status: requiredString(value.session.container_status, 'Mattermost contract container status'),
      inboxCount: value.session.inboxCount,
    };
  }
  return {
    channel_id: requiredString(value.channel_id, 'Mattermost contract channel identity'),
    status: requiredString(value.status, 'Mattermost contract subscription status'),
    messaging_group_id: requiredString(value.messaging_group_id, 'Mattermost contract messaging identity'),
    agent_group_id: requiredString(value.agent_group_id, 'Mattermost contract agent identity'),
    wiring_id: requiredString(value.wiring_id, 'Mattermost contract wiring identity'),
    folder: requiredString(value.folder, 'Mattermost contract workspace identity'),
    session,
  };
}

function channelState(states: readonly ContractChannelState[], channelId: string): ContractChannelState {
  const state = states.find((candidate) => candidate.channel_id === channelId);
  if (!state) throw new Error('Mattermost contract channel snapshot was incomplete');
  return state;
}

function resultPostId(result: Record<string, unknown>): string {
  return requiredString(result.postId, 'Mattermost contract delivered post identity');
}

function assertOutboundAddress(post: MattermostContractPost, channelId: string, rootId: string): void {
  if (post.channelId !== channelId || post.rootId !== rootId) {
    throw new Error(
      `CONTRACT_ROOT_ID_ASSERTION: expected channel ${channelId} and root ${rootId}; received ${post.channelId} and ${post.rootId}`,
    );
  }
}

test('preserves outbound channel and root_id through isolation, restart, unsubscribe, and bot removal', async () => {
  const repoRoot = process.cwd();
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mm-contract-'));
  const suffix = `${Date.now().toString(36)}${process.pid.toString(36)}`.slice(-14);
  const bootstrapApi = new MattermostContractApi(
    { baseUrl: CONTRACT_URL },
    { requestTimeoutMs: 2_000, maxRequestAttempts: 1 },
  );
  let adminApi: MattermostContractApi | null = null;
  let actorApi: MattermostContractApi | null = null;
  let worker: ContractWorkerClient | null = null;
  let team: MattermostContractTeam | null = null;
  let actor: MattermostContractUser | null = null;
  let bot: MattermostContractBot | null = null;
  let botToken: MattermostContractPersonalAccessToken | null = null;
  const channels: MattermostContractChannel[] = [];

  try {
    await bootstrapApi.waitUntilReady({ maxAttempts: 120, delayMs: 1_000 });
    await bootstrapApi
      .createInitialAdmin({ email: ADMIN_EMAIL, username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes('HTTP 400')) throw error;
      });
    const adminLogin = await bootstrapApi.login({ loginId: ADMIN_USERNAME, password: ADMIN_PASSWORD });
    adminApi = new MattermostContractApi(
      { baseUrl: CONTRACT_URL, adminToken: adminLogin.token },
      { requestTimeoutMs: 5_000 },
    );
    actor = await adminApi.createUser({
      email: `actor-${suffix}@example.test`,
      username: `contract-actor-${suffix}`,
      password: 'Disposable-contract-actor-2026!',
    });
    const actorLogin = await bootstrapApi.login({
      loginId: actor.username,
      password: 'Disposable-contract-actor-2026!',
    });
    actorApi = new MattermostContractApi(
      { baseUrl: CONTRACT_URL, adminToken: actorLogin.token },
      { requestTimeoutMs: 5_000 },
    );
    team = await adminApi.createTeam({
      name: `nanoclaw-${suffix}`,
      displayName: `NanoClaw Contract ${suffix}`,
    });
    const channelA = await adminApi.createChannel({
      teamId: team.id,
      name: `contract-a-${suffix}`,
      displayName: `Contract A ${suffix}`,
    });
    const channelB = await adminApi.createChannel({
      teamId: team.id,
      name: `contract-b-${suffix}`,
      displayName: `Contract B ${suffix}`,
    });
    channels.push(channelA, channelB);
    bot = await adminApi.createBot({
      username: `nanoclaw-bot-${suffix}`,
      displayName: `NanoClaw Bot ${suffix}`,
      description: 'Disposable NanoClaw contract bot',
    });
    botToken = await adminApi.createPersonalAccessToken(bot.userId, `NanoClaw contract ${suffix}`);
    await adminApi.addTeamMember(team.id, actor.id);
    await adminApi.addTeamMember(team.id, bot.userId);
    for (const channel of channels) {
      await adminApi.addChannelMember(channel.id, actor.id);
      await adminApi.addChannelMember(channel.id, bot.userId);
      await expect(adminApi.getChannelMember(channel.id, bot.userId)).resolves.toMatchObject({
        channelId: channel.id,
        userId: bot.userId,
      });
    }

    const baselineA = await actorApi.createPost({ channelId: channelA.id, message: `baseline A ${suffix}` });
    const baselineB = await actorApi.createPost({ channelId: channelB.id, message: `baseline B ${suffix}` });
    const workerConfig = {
      repoRoot,
      testRoot,
      botToken: botToken.token,
      bootstrapSubscriptions: true,
      channels: [
        {
          channelId: channelA.id,
          name: channelA.displayName,
          baseline: { postId: baselineA.id, createAt: baselineA.createAt },
        },
        {
          channelId: channelB.id,
          name: channelB.displayName,
          baseline: { postId: baselineB.id, createAt: baselineB.createAt },
        },
      ],
    };
    const firstWorker = await ContractWorkerClient.start(workerConfig);
    worker = firstWorker.client;
    const firstPid = firstWorker.ready.pid;
    expect(typeof firstPid).toBe('number');

    const rootA = await actorApi.createPost({ channelId: channelA.id, message: `root A ${suffix}` });
    const threadA = await actorApi.createPost({
      channelId: channelA.id,
      rootId: rootA.id,
      message: `thread A ${suffix}`,
    });
    const postB = await actorApi.createPost({ channelId: channelB.id, message: `post B ${suffix}` });
    await Promise.all([
      worker.waitForInbound(rootA.id),
      worker.waitForInbound(threadA.id),
      worker.waitForInbound(postB.id),
    ]);

    const initialSnapshot = await worker.snapshot();
    const initialA = channelState(initialSnapshot, channelA.id);
    const initialB = channelState(initialSnapshot, channelB.id);
    expect(initialA.status).toBe('active');
    expect(initialB.status).toBe('active');
    expect(initialA.agent_group_id).not.toBe(initialB.agent_group_id);
    expect(initialA.messaging_group_id).not.toBe(initialB.messaging_group_id);
    expect(initialA.wiring_id).not.toBe(initialB.wiring_id);
    expect(initialA.folder).not.toBe(initialB.folder);
    expect(initialA.session?.id).not.toBe(initialB.session?.id);
    expect(initialA.session?.thread_id).toBeNull();
    expect(initialB.session?.thread_id).toBeNull();
    expect(initialA.session?.container_status).toBe('stopped');
    expect(initialB.session?.container_status).toBe('stopped');
    expect(initialA.session?.inboxCount).toBe(2);
    expect(initialB.session?.inboxCount).toBe(1);
    expect(`${initialA.agent_group_id}:${initialA.session?.id}`).not.toBe(
      `${initialB.agent_group_id}:${initialB.session?.id}`,
    );
    expect(fs.realpathSync(path.join(testRoot, 'groups', initialA.folder))).not.toBe(
      fs.realpathSync(path.join(testRoot, 'groups', initialB.folder)),
    );
    expect(
      fs.realpathSync(
        path.join(
          testRoot,
          'data',
          'v2-sessions',
          initialA.agent_group_id,
          requiredString(initialA.session?.id, 'Mattermost contract channel A session'),
        ),
      ),
    ).not.toBe(
      fs.realpathSync(
        path.join(
          testRoot,
          'data',
          'v2-sessions',
          initialB.agent_group_id,
          requiredString(initialB.session?.id, 'Mattermost contract channel B session'),
        ),
      ),
    );

    const outboundRoot = process.env.NANOCLAW_MM_CONTRACT_MUTATE_ROOT_ID === '1' ? null : rootA.id;
    const replyAResult = await worker.command({
      kind: 'deliver',
      platformId: `mattermost:contract:${channelA.id}`,
      threadId: outboundRoot,
      text: `reply A ${suffix}`,
    });
    const replyA = await adminApi.getPost(resultPostId(replyAResult));
    assertOutboundAddress(replyA, channelA.id, rootA.id);
    const replyBResult = await worker.command({
      kind: 'deliver',
      platformId: `mattermost:contract:${channelB.id}`,
      threadId: null,
      text: `reply B ${suffix}`,
    });
    const replyB = await adminApi.getPost(resultPostId(replyBResult));
    assertOutboundAddress(replyB, channelB.id, '');

    await worker.shutdown();
    worker = null;
    const restartedWorker = await ContractWorkerClient.start({ ...workerConfig, bootstrapSubscriptions: false });
    worker = restartedWorker.client;
    expect(restartedWorker.ready.pid).not.toBe(firstPid);
    const restartedSnapshot = await worker.snapshot();
    const restartedA = channelState(restartedSnapshot, channelA.id);
    const restartedB = channelState(restartedSnapshot, channelB.id);
    expect(restartedA.status).toBe('active');
    expect(restartedB.status).toBe('active');
    expect(restartedA.agent_group_id).toBe(initialA.agent_group_id);
    expect(restartedB.agent_group_id).toBe(initialB.agent_group_id);
    expect(restartedA.session?.id).toBe(initialA.session?.id);
    expect(restartedB.session?.id).toBe(initialB.session?.id);
    expect(restartedA.session?.container_status).toBe('stopped');
    expect(restartedB.session?.container_status).toBe('stopped');

    const restartA = await actorApi.createPost({ channelId: channelA.id, message: `restart A ${suffix}` });
    const restartB = await actorApi.createPost({ channelId: channelB.id, message: `restart B ${suffix}` });
    await Promise.all([worker.waitForInbound(restartA.id), worker.waitForInbound(restartB.id)]);
    const postRestartSnapshot = await worker.snapshot();
    expect(channelState(postRestartSnapshot, channelA.id).session?.inboxCount).toBe(3);
    expect(channelState(postRestartSnapshot, channelB.id).session?.inboxCount).toBe(2);

    await worker.command({ kind: 'deactivate', channelId: channelA.id });
    const afterDeactivate = await worker.snapshot();
    expect(channelState(afterDeactivate, channelA.id).status).toBe('unsubscribed');
    expect(channelState(afterDeactivate, channelB.id).status).toBe('active');
    const aCountBefore = channelState(afterDeactivate, channelA.id).session?.inboxCount;
    const bCountBefore = channelState(afterDeactivate, channelB.id).session?.inboxCount ?? 0;
    const afterUnsubscribeA = await actorApi.createPost({
      channelId: channelA.id,
      message: `after unsubscribe A ${suffix}`,
    });
    const afterUnsubscribeB = await actorApi.createPost({
      channelId: channelB.id,
      message: `after unsubscribe B ${suffix}`,
    });
    await Promise.all([worker.waitForInbound(afterUnsubscribeA.id), worker.waitForInbound(afterUnsubscribeB.id)]);
    const afterUnsubscribeSnapshot = await worker.snapshot();
    expect(channelState(afterUnsubscribeSnapshot, channelA.id).session?.inboxCount).toBe(aCountBefore);
    expect(channelState(afterUnsubscribeSnapshot, channelB.id).session?.inboxCount).toBe(bCountBefore + 1);
    expect(channelState(afterUnsubscribeSnapshot, channelB.id).status).toBe('active');

    const lifecycle = worker.waitFor(
      (event) => event.kind === 'lifecycle' && event.platformId === `mattermost:contract:${channelB.id}`,
      60_000,
    );
    await adminApi.removeChannelMember(channelB.id, bot.userId);
    await lifecycle;
    const finalSnapshot = await worker.snapshot();
    expect(channelState(finalSnapshot, channelA.id).status).toBe('unsubscribed');
    expect(channelState(finalSnapshot, channelB.id).status).toBe('unsubscribed');
    expect(channelState(finalSnapshot, channelB.id).session?.status).toBe('closed');
    expect(channelState(finalSnapshot, channelB.id).session?.container_status).toBe('stopped');
  } finally {
    await worker?.shutdown().catch(() => undefined);
    if (adminApi) {
      if (botToken) await adminApi.revokePersonalAccessToken(botToken.id).catch(() => undefined);
      if (bot) await adminApi.disableBot(bot.userId).catch(() => undefined);
      for (const channel of channels) await adminApi.deleteChannel(channel.id).catch(() => undefined);
      if (team) await adminApi.deleteTeam(team.id).catch(() => undefined);
      if (actor) await adminApi.deactivateUser(actor.id).catch(() => undefined);
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
