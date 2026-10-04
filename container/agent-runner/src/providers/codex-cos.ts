/** Native CoS profile of the shared NanoClaw Codex transport and turn pump. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSubscriptionCredentialClient } from './codex-credential-client.js';
import { createSubscriptionTurnClient } from './codex-turn-client.js';
import { stopSubscriptionAppServer, subscriptionProcessEnvironment } from './codex-subscription-check.js';
import { subscriptionConfig, subscriptionThreadParams } from './codex-subscription-policy.js';
import { cosDynamicTools, createCosToolDispatch } from './codex-cos-tools.js';
import { createMandateToolBridge } from './codex-mandate-bridge.js';
import {
  missionDynamicToolsForSchema,
  createMissionToolDispatch,
  type MissionResultSchema,
} from './codex-mission-tools.js';
import {
  initializeCodexAppServer,
  spawnCodexAppServer,
  sendCodexRequest,
  sendCodexResponse,
  rejectCodexRequest,
  killCodexAppServer,
  type AppServer,
  type JsonRpcServerRequest,
} from './codex-app-server.js';
import { runOneTurn } from './codex.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './types.js';

const PREFIX = 'cos-codex-subscription-v1:';
const MISSION_PREFIX = 'cos-mission-codex-subscription-v1:';
const CONTEXT_ERROR = 'cos_context_recovery_required';
function decode(prefix: string, continuation?: string) {
  if (continuation === undefined) return undefined;
  if (!continuation.startsWith(prefix) || !/^[a-zA-Z0-9_-]{1,128}$/.test(continuation.slice(prefix.length)))
    throw new Error(CONTEXT_ERROR);
  return continuation.slice(prefix.length);
}
function writeConfig(config: string) {
  const directory = '/home/node/.codex';
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    fs.realpathSync(directory) !== directory ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error('cos_provider_state_unavailable');
  const temporary = path.join(directory, '.config-' + randomUUID());
  try {
    fs.writeFileSync(temporary, config, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, path.join(directory, 'config.toml'));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
const runtime = {
  spawn: spawnCodexAppServer,
  stop: stopSubscriptionAppServer,
  credentials: createSubscriptionCredentialClient,
  attempts: createSubscriptionTurnClient,
  writeConfig,
  mandateBridge: createMandateToolBridge,
};

export class CosCodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private readonly config: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly specialist: boolean;
  private readonly prefix: string;
  constructor(
    private readonly options: {
      model: string;
      proxyUrl: string;
      profile?: 'coordinator' | 'research';
      missionResultSchema?: MissionResultSchema;
    },
    private readonly dependencies = runtime,
  ) {
    if (options.profile !== undefined && options.profile !== 'coordinator' && options.profile !== 'research')
      throw new Error('cos_provider_profile_unavailable');
    this.specialist = options.profile === 'research';
    if (options.missionResultSchema !== undefined && !this.specialist)
      throw new Error('cos_provider_profile_unavailable');
    if (this.specialist) missionDynamicToolsForSchema(options.missionResultSchema ?? 'cos-research-result/v1');
    this.prefix = this.specialist ? MISSION_PREFIX : PREFIX;
    this.config = subscriptionConfig(options.model);
    this.environment = subscriptionProcessEnvironment(options.proxyUrl);
  }
  // Generic poll-loop recovery must never erase a CoS conversation implicitly.
  isSessionInvalid(_error: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const cancellation = new AbortController();
    const queue = [input.prompt];
    let ended = false,
      wake: (() => void) | undefined,
      server: AppServer | undefined;
    const dispatch = this.specialist
      ? createMissionToolDispatch(undefined, this.options.missionResultSchema ?? 'cos-research-result/v1')
      : createCosToolDispatch();
    const cancelled = () => cancellation.signal.aborted;
    const self = this;
    async function* events(): AsyncGenerator<ProviderEvent> {
      let threadId: string | undefined;
      let bridge: Awaited<ReturnType<typeof createMandateToolBridge>> | undefined;
      const credentials = self.dependencies.credentials({ signal: cancellation.signal });
      const attempts = self.dependencies.attempts({ signal: cancellation.signal });
      try {
        if (cancelled()) return;
        try {
          threadId = decode(self.prefix, input.continuation);
        } catch {
          yield {
            type: 'error',
            message: 'CoS conversation recovery is required.',
            retryable: false,
            classification: CONTEXT_ERROR,
          };
          yield {
            type: 'result',
            text: 'The saved CoS conversation needs explicit recovery. No new conversation was started.',
          };
          return;
        }
        if (!self.specialist) bridge = await self.dependencies.mandateBridge(dispatch);
        while (!cancelled()) {
          if (!queue.length) {
            if (ended) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
            continue;
          }
          const prompt = queue.shift()!;
          let contextFailure = false;
          try {
            if (input.cwd !== '/workspace/agent' || Buffer.byteLength(prompt) > 65536)
              throw new Error('cos_input_unavailable');
            await attempts.begin();
            await credentials.prepare();
            if (cancelled()) return;
            self.dependencies.writeConfig(self.config + (bridge ? '\n' + bridge.configuration : ''));
            const current = self.dependencies.spawn([], { environment: self.environment, diagnostic: () => {} });
            server = current;
            const requestHandler = (request: JsonRpcServerRequest) => {
              if (cancelled() || server !== current) return;
              if (request.method !== 'item/tool/call') {
                rejectCodexRequest(current, request.id);
                return;
              }
              void dispatch.handle(request).then((result) => {
                if (!cancelled() && server === current) sendCodexResponse(current, request.id, result);
              });
            };
            current.serverRequestHandlers.push(requestHandler);
            await initializeCodexAppServer(current);
            if (cancelled()) return;
            const params = subscriptionThreadParams(self.options.model, input.systemContext?.instructions ?? '');
            const resumed = await sendCodexRequest(current, threadId ? 'thread/resume' : 'thread/start', {
              ...params,
              ...(threadId
                ? { threadId }
                : {
                    dynamicTools: self.specialist
                      ? missionDynamicToolsForSchema(self.options.missionResultSchema ?? 'cos-research-result/v1')
                      : cosDynamicTools,
                  }),
            });
            const returnedId = (resumed.result as { thread?: { id?: string } } | undefined)?.thread?.id;
            if (
              resumed.error ||
              !returnedId ||
              !/^[a-zA-Z0-9_-]{1,128}$/.test(returnedId) ||
              (threadId && returnedId !== threadId)
            ) {
              contextFailure = !!threadId;
              throw new Error(contextFailure ? CONTEXT_ERROR : 'cos_thread_unavailable');
            }
            threadId = returnedId;
            if (cancelled()) return;
            // Persist before dispatching any model work; ordinary restarts resume this same ID.
            yield { type: 'init', continuation: self.prefix + threadId };
            yield* runOneTurn(
              current,
              threadId,
              prompt,
              self.options.model,
              undefined,
              input.cwd,
              (id) => self.prefix + id,
              () => true,
              () => {},
              async () => {
                await credentials.refresh();
              },
              cancelled,
              {
                started: (thread, turn) => (bridge ? bridge.beginTurn(thread, turn) : dispatch.beginTurn(thread, turn)),
                finished: () => (bridge ? bridge.endTurn() : dispatch.endTurn()),
              },
            );
          } catch {
            if (cancelled()) return;
            yield {
              type: 'error',
              message: contextFailure
                ? 'CoS conversation recovery is required.'
                : 'CoS subscription execution is unavailable.',
              retryable: false,
              ...(contextFailure ? { classification: CONTEXT_ERROR } : {}),
            };
            yield {
              type: 'result',
              text: contextFailure
                ? 'The saved CoS conversation needs explicit recovery. No new conversation was started.'
                : 'CoS could not complete this turn. It has not been replayed.',
            };
          } finally {
            if (bridge) bridge.endTurn();
            else dispatch.endTurn();
            try {
              if (server) {
                const current = server;
                server = undefined;
                await self.dependencies.stop(current);
              }
            } finally {
              await attempts.end();
            }
          }
        }
      } finally {
        dispatch.close();
        if (server) {
          const current = server;
          server = undefined;
          await self.dependencies.stop(current);
        }
        await bridge?.close();
      }
    }
    return {
      push(message) {
        if (!ended && !cancelled()) {
          queue.push(message);
          wake?.();
        }
      },
      end() {
        ended = true;
        wake?.();
      },
      abort() {
        cancellation.abort();
        dispatch.close();
        if (server) killCodexAppServer(server);
        wake?.();
      },
      events: events(),
    };
  }
}
