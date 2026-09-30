/**
 * OpenAI Codex provider — wraps `codex app-server` via JSON-RPC.
 *
 * Unlike the (deprecated) @openai/codex-sdk approach, the app-server
 * protocol exposes proper session/stream semantics, native compaction, and
 * stable MCP config via ~/.codex/config.toml — which is the same mechanism
 * the standalone codex CLI uses, so the container and host share one
 * provider-integration story.
 *
 * Codex turns don't accept mid-turn input. Follow-up `push()` messages are
 * queued and drained after the current turn completes (same pattern as the
 * opencode provider — see poll-loop for why that's correct: the poll-loop
 * only pushes once it has new pending messages, and we only drain between
 * turns, so no message is dropped).
 */
import fs from 'fs';
import path from 'path';
import { createSubscriptionCredentialClient } from './codex-credential-client.js';
import { stopSubscriptionAppServer } from './codex-subscription-check.js';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import {
  type AppServer,
  type JsonRpcNotification,
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  createCodexConfigOverrides,
  decodeCodexContinuation,
  encodeCodexContinuation,
  initializeCodexAppServer,
  killCodexAppServer,
  loadNanoclawWorkflowDynamicTools,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';

/** Hard ceiling for a single turn. Guards against app-server wedging. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

// ── System-prompt assembly ──────────────────────────────────────────────────
// Codex's app-server doesn't expand Claude Code's `@-import` syntax in
// CLAUDE.md, and doesn't auto-load CLAUDE.local.md from the working dir the
// way Claude Code does. Left alone, the agent sees only the raw import
// directives as literal text and none of the composed content — no shared
// CLAUDE.md, no module fragments, no per-group memory. We resolve both here
// so Codex (and any other non-Claude provider) gets the same effective
// system prompt the Claude provider gets natively.

/**
 * Inline `@<path>` import directives (line-anchored) with the contents of
 * the referenced file, resolved relative to `baseDir`. Recurses so imports
 * within imported files expand too. Cycles and missing files are silently
 * dropped (replaced with empty text) rather than left as raw `@path` lines,
 * which would confuse the model.
 */
export function resolveClaudeImports(content: string, baseDir: string, seen: Set<string> = new Set()): string {
  return content.replace(/^@(\S+)\s*$/gm, (_match, importPath: string) => {
    try {
      const resolved = path.resolve(baseDir, importPath);
      if (seen.has(resolved)) return '';
      if (!fs.existsSync(resolved)) return '';
      const nextSeen = new Set(seen);
      nextSeen.add(resolved);
      const imported = fs.readFileSync(resolved, 'utf-8');
      return resolveClaudeImports(imported, path.dirname(resolved), nextSeen);
    } catch {
      return '';
    }
  });
}

function readAgentAndGlobalClaudeMd(): string | undefined {
  // Per-group CLAUDE.md is responsible for pulling in the global instructions
  // if the group wants them (the default scaffold starts with
  // `@./.claude-global.md` which resolveClaudeImports inlines). Appending
  // `/workspace/global/CLAUDE.md` explicitly here would double-inline the
  // global content for any non-main group, wasting context tokens and
  // risking contradictory instructions. Groups that don't import global
  // intentionally don't get it — same as Claude-backed agents.
  const groupDir = '/workspace/agent';
  const groupPath = `${groupDir}/CLAUDE.md`;
  const localPath = `${groupDir}/CLAUDE.local.md`;
  const parts: string[] = [];

  if (fs.existsSync(groupPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(groupPath, 'utf-8'), groupDir));
  }
  if (fs.existsSync(localPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(localPath, 'utf-8'), groupDir));
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

function composeBaseInstructions(promptAddendum: string | undefined): string | undefined {
  const claudeMd = readAgentAndGlobalClaudeMd();
  const pieces = [claudeMd, promptAddendum].filter((s): s is string => Boolean(s));
  return pieces.length > 0 ? pieces.join('\n\n---\n\n') : undefined;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  private readonly model: string;
  private readonly reasoningEffort: CodexReasoningEffort | undefined;
  private readonly restrictedCos: boolean;
  private readonly coordinatedSubscription: boolean;

  constructor(options: ProviderOptions = {}) {
    this.restrictedCos = options.restrictedCos === true;
    this.coordinatedSubscription = options.env?.NANOCLAW_CODEX_SUBSCRIPTION === '1';
    this.mcpServers = options.mcpServers ?? {};
    this.model = (options.env?.CODEX_MODEL as string | undefined) ?? 'gpt-6-astra';
    const configuredEffort = (options.env?.CODEX_REASONING_EFFORT as string | undefined)?.trim().toLowerCase();
    if (configuredEffort !== undefined && !CODEX_REASONING_EFFORTS.includes(configuredEffort as CodexReasoningEffort)) {
      throw new Error(`Invalid CODEX_REASONING_EFFORT: expected one of ${CODEX_REASONING_EFFORTS.join(', ')}`);
    }
    this.reasoningEffort = configuredEffort as CodexReasoningEffort | undefined;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let activeServer: AppServer | undefined;
    const credentialCancellation = new AbortController();
    const kick = (): void => {
      waiting?.();
    };

    pending.push(input.prompt);

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      // Keep the native process warm across turns; replace it only when the
      // coordinated credential generation changes, resuming the same thread.
      const credentials = self.coordinatedSubscription
        ? createSubscriptionCredentialClient({ signal: credentialCancellation.signal })
        : undefined;
      let restart = false;

      const decodedContinuation = decodeCodexContinuation(input.continuation);
      let threadId: string | undefined = decodedContinuation.threadId;
      let initYielded = false;

      try {
        if (decodedContinuation.refreshRequired) {
          console.error(
            '[codex-provider] Refreshing pre-bridge Codex continuation so dynamic MCP workflow tools are attached',
          );
        }

        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
          if (aborted) return;
          if (pending.length === 0 && ended) return;

          const text = pending.shift()!;
          try {
            const changed = await credentials?.prepare();
            if (aborted) return;
            if (activeServer && (changed || restart)) {
              await stopSubscriptionAppServer(activeServer);
              activeServer = undefined;
            }
            if (!activeServer) {
              writeCodexMcpConfigToml(self.mcpServers, self.restrictedCos);
              const overrides = createCodexConfigOverrides(self.restrictedCos);
              if (credentials)
                overrides.push(
                  'forced_login_method="chatgpt"',
                  'model_provider="openai"',
                  'cli_auth_credentials_store="file"',
                );
              activeServer = spawnCodexAppServer(overrides, credentials ? { diagnostic: () => {} } : {});
              attachCodexAutoApproval(activeServer);
              await initializeCodexAppServer(activeServer);
              const dynamicTools = self.restrictedCos ? [] : await loadNanoclawWorkflowDynamicTools(activeServer);
              if (aborted) return;
              const previousThread = threadId;
              threadId = await startOrResumeCodexThread(activeServer, threadId, {
                model: self.model,
                cwd: input.cwd,
                sandbox: 'danger-full-access',
                approvalPolicy: 'never',
                personality: 'friendly',
                baseInstructions: self.restrictedCos
                  ? input.systemContext?.instructions
                  : composeBaseInstructions(input.systemContext?.instructions),
                dynamicTools,
              });
              if (previousThread !== threadId) initYielded = false;
              restart = false;
            }
          } catch (error) {
            if (!credentials) throw error;
            if (activeServer) {
              await stopSubscriptionAppServer(activeServer);
              activeServer = undefined;
            }
            if (aborted) return;
            yield { type: 'error', message: 'Codex subscription is unavailable.', retryable: false };
            yield {
              type: 'result',
              text: 'Codex could not start this turn. The subscription runtime needs attention; this turn was not run.',
            };
            continue;
          }
          if (aborted) return;

          // One turn = one channel of streaming events. Each notification
          // from the app-server yields an `activity` first (so the
          // poll-loop's idle timer stays honest) and then, where relevant,
          // an init / result / progress event.
          yield* runOneTurn(
            activeServer,
            threadId!,
            text,
            self.model,
            self.reasoningEffort,
            input.cwd,
            encodeCodexContinuation,
            () => initYielded,
            () => {
              initYielded = true;
            },
            credentials
              ? async () => {
                  restart = true;
                  await credentials.refresh();
                }
              : undefined,
            () => aborted,
          );
        }
      } finally {
        if (activeServer) killCodexAppServer(activeServer);
      }
    }

    return {
      push: (message: string) => {
        pending.push(message);
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      abort: () => {
        aborted = true;
        credentialCancellation.abort();
        if (activeServer) killCodexAppServer(activeServer);
        kick();
      },
      events: gen(),
    };
  }
}

// ── Per-turn event pump ─────────────────────────────────────────────────────
// Pulled out because the gen() loop above reads cleaner with it extracted,
// and because it's a natural seam for future unit tests that drive it with
// a fake notification stream.

export async function* runOneTurn(
  server: AppServer,
  threadId: string,
  inputText: string,
  model: string,
  effort: CodexReasoningEffort | undefined,
  cwd: string,
  encodeContinuation: (threadId: string) => string,
  hasInit: () => boolean,
  markInit: () => void,
  renewSubscription?: () => Promise<void>,
  cancelled: () => boolean = () => false,
  restrictedSubscription?: { started(threadId: string, turnId: string): void; finished(): void },
): AsyncGenerator<ProviderEvent> {
  if (cancelled()) return;
  // Mutable refs via object properties — TS can't track closure assignments
  // for narrowing, but property access keeps the declared type visible.
  const turnState: { error: Error | null; unauthorized: boolean } = { error: null, unauthorized: false };
  let resultText = '';
  let turnDone = false;
  let nativeTurnId: string | undefined;
  const progressState: CodexProgressState = { functionCalls: new Map(), completedWebSearches: new Set() };

  // Buffered event queue so we can `yield` across the async notification
  // callback. Each notification pushes zero or more ProviderEvents; the
  // generator drains the buffer.
  const buffer: ProviderEvent[] = [];
  let waker: (() => void) | null = null;
  const kick = (): void => {
    waker?.();
    waker = null;
  };

  const handler = (n: JsonRpcNotification): void => {
    const method = n.method;
    const params = n.params;

    if (restrictedSubscription) {
      if (turnDone || cancelled() || params.threadId !== threadId) return;
      const turn = params.turn as { id?: unknown } | undefined;
      if (method === 'turn/started') {
        if (nativeTurnId || typeof turn?.id !== 'string' || !turn.id) return;
        nativeTurnId = turn.id;
        restrictedSubscription.started(threadId, nativeTurnId);
      } else if (!nativeTurnId || (params.turnId ?? turn?.id) !== nativeTurnId) return;
      if (buffer.length >= 256) {
        turnState.error = new Error('CoS turn output limit reached');
        turnDone = true;
        restrictedSubscription.finished();
        kick();
        return;
      }
    }

    // Every inbound notification counts as activity for the poll-loop's
    // idle timer — yield before any event-specific translation so even
    // long tool executions keep the loop awake.
    buffer.push({ type: 'activity' });

    switch (method) {
      case 'thread/started': {
        const thread = params.thread as { id?: string } | undefined;
        if (thread?.id && !hasInit()) {
          markInit();
          buffer.push({ type: 'init', continuation: encodeContinuation(thread.id) });
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = params.delta as string;
        if (typeof delta === 'string') resultText += delta;
        break;
      }
      case 'item/completed': {
        const item = params.item as { type?: string; text?: string; phase?: string } | undefined;
        if (
          item?.type === 'agentMessage' &&
          typeof item.text === 'string' &&
          item.text &&
          item.phase !== 'commentary'
        ) {
          resultText = item.text;
        }
        for (const message of codexProgressMessages(n, progressState)) {
          buffer.push({ type: 'progress', message });
        }
        break;
      }
      case 'item/started':
      case 'item/updated': {
        for (const message of codexProgressMessages(n, progressState)) {
          buffer.push({ type: 'progress', message });
        }
        break;
      }
      case 'turn/completed': {
        const turn = params.turn as
          | { status?: string; error?: { message?: string; codexErrorInfo?: unknown } }
          | undefined;
        if (turn?.status === 'failed' || turn?.status === 'interrupted') {
          turnState.error = new Error(turn.error?.message ?? 'Turn did not complete');
          if (turn.error?.codexErrorInfo !== undefined)
            turnState.unauthorized = nativeUnauthorized(turn.error.codexErrorInfo, turn.error.message);
        }
        turnDone = true;
        break;
      }
      case 'turn/failed': {
        const e = params.error as { message?: string; codexErrorInfo?: unknown } | undefined;
        turnState.error = new Error(e?.message || 'Turn failed');
        turnState.unauthorized = nativeUnauthorized(e?.codexErrorInfo, e?.message);
        turnDone = true;
        break;
      }
      case 'error': {
        if (params.willRetry === true || (params.threadId && params.threadId !== threadId)) break;
        const error = params.error as { message?: string; codexErrorInfo?: unknown } | undefined;
        turnState.error = new Error(error?.message ?? 'Turn failed');
        turnState.unauthorized = nativeUnauthorized(error?.codexErrorInfo, error?.message);
        break;
      }
      case 'thread/status/changed': {
        // Status changes are useful as liveness, but too noisy and generic
        // for user-facing channel progress. The activity event above already
        // keeps the poll-loop heartbeat honest.
        break;
      }
      case 'item/mcpToolCall/progress':
      case 'turn/plan/updated':
      case 'thread/goal/updated':
        for (const message of codexProgressMessages(n, progressState)) {
          buffer.push({ type: 'progress', message });
        }
        break;
      default:
        // Silently handle the many item/* notifications — they already
        // contributed an activity event above.
        break;
    }

    if (restrictedSubscription) {
      if (Buffer.byteLength(resultText) > 65536) {
        resultText = '';
        turnState.error = new Error('CoS turn output limit reached');
        turnDone = true;
      }
      if (turnDone) restrictedSubscription.finished();
    }

    kick();
  };

  server.notificationHandlers.push(handler);
  const exited = () => {
    turnState.error = new Error('Codex process ended before turn completion');
    turnDone = true;
    restrictedSubscription?.finished();
    kick();
  };
  server.process.once('exit', exited);

  const timer = setTimeout(() => {
    turnState.error = new Error(`Turn timed out after ${TURN_TIMEOUT_MS}ms`);
    turnDone = true;
    restrictedSubscription?.finished();
    kick();
  }, TURN_TIMEOUT_MS);

  try {
    // If we yield init before turn/start, the poll-loop stores
    // continuation early and survives a mid-turn crash.
    if (!hasInit()) {
      markInit();
      buffer.push({ type: 'init', continuation: encodeContinuation(threadId) });
    }

    void startCodexTurn(server, {
      threadId,
      inputText,
      model,
      effort,
      cwd,
      restrictedSubscription: !!restrictedSubscription,
    }).catch((err) => {
      turnState.error = err instanceof Error ? err : new Error(String(err));
      turnDone = true;
      restrictedSubscription?.finished();
      kick();
    });

    while (true) {
      while (buffer.length > 0) {
        if (cancelled()) return;
        const ev = buffer.shift()!;
        yield ev;
      }
      if (turnDone) break;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
      waker = null;
    }

    if (cancelled()) return;
    while (buffer.length > 0) yield buffer.shift()!;

    if (turnState.error) {
      if (renewSubscription) {
        let renewed = false;
        if (turnState.unauthorized) {
          try {
            await renewSubscription();
            renewed = true;
          } catch {
            /* The host retains exact private failure state. */
          }
        }
        if (cancelled()) return;
        const message = renewed
          ? 'Subscription credentials were renewed. This interrupted turn was not replayed.'
          : 'Codex could not complete this turn. It has not been replayed.';
        yield { type: 'error', message, retryable: false };
        yield { type: 'result', text: message };
      } else yield { type: 'error', message: turnState.error.message, retryable: false };
      return;
    }

    yield { type: 'result', text: resultText || null };
  } finally {
    restrictedSubscription?.finished();
    clearTimeout(timer);
    server.process.removeListener('exit', exited);
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
  }
}

// Pinned 0.158.0 turns a managed-cache 401 into these terminal refresh errors.
// Access-only workers cannot refresh themselves. Only the coordinated owner's
// native helper may rotate; the failed turn is never automatically replayed.
// Match exact native errors, not endpoint substrings or arbitrary provider text.
const NATIVE_REFRESH_FAILURES = new Set([
  'error sending request for url (https://auth.openai.com/oauth/token)',
  'Your access token could not be refreshed. Please log out and sign in again.',
  'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
  'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
  'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
]);
function nativeUnauthorized(info: unknown, message?: string): boolean {
  if (info === 'unauthorized') return true;
  if (info === 'other' && typeof message === 'string' && NATIVE_REFRESH_FAILURES.has(message)) return true;
  if (!info || typeof info !== 'object') return false;
  return [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
  ].some((key) => {
    const value = (info as Record<string, unknown>)[key];
    return value && typeof value === 'object' && (value as { httpStatusCode?: number }).httpStatusCode === 401;
  });
}

interface CodexReasoningItem {
  type?: string;
  summary?: unknown;
  content?: unknown;
}

interface CodexMessageItem {
  type?: string;
  role?: unknown;
  text?: unknown;
  phase?: unknown;
  content?: unknown;
}

interface CodexWebSearchItem {
  type?: string;
  id?: unknown;
  status?: unknown;
  action?: unknown;
}

interface CodexFunctionCallItem {
  type?: string;
  name?: unknown;
  call_id?: unknown;
  callId?: unknown;
}

interface CodexPlanStep {
  step?: unknown;
  status?: unknown;
}

interface CodexGoal {
  objective?: unknown;
  status?: unknown;
}

export interface CodexProgressState {
  functionCalls: Map<string, string>;
  completedWebSearches?: Set<string>;
}

export function codexProgressMessages(notification: JsonRpcNotification, state?: CodexProgressState): string[] {
  const params = notification.params;

  switch (notification.method) {
    case 'item/completed': {
      const item = params.item as
        | CodexReasoningItem
        | CodexMessageItem
        | CodexWebSearchItem
        | CodexFunctionCallItem
        | undefined;
      return progressMessagesForCompletedItem(item, state);
    }
    case 'item/started':
    case 'item/updated': {
      const item = params.item as CodexFunctionCallItem | CodexWebSearchItem | undefined;
      return progressMessagesForStartedOrUpdatedItem(item, state);
    }
    case 'item/mcpToolCall/progress': {
      const message = typeof params.message === 'string' ? params.message.trim() : '';
      return message ? [message] : [];
    }
    case 'turn/plan/updated': {
      const explanation = typeof params.explanation === 'string' ? params.explanation.trim() : '';
      const steps = Array.isArray(params.plan) ? (params.plan as CodexPlanStep[]) : [];
      const active = steps.find((step) => step.status === 'inProgress');
      const completed = [...steps].reverse().find((step) => step.status === 'completed');
      const current = active ?? completed;
      const step = typeof current?.step === 'string' ? current.step.trim() : '';

      const parts = [explanation, step].filter(Boolean);
      return parts.length > 0 ? [parts.join('\n')] : [];
    }
    case 'thread/goal/updated': {
      const goal = params.goal as CodexGoal | undefined;
      if (goal?.status === 'complete') return [];

      const objective = typeof goal?.objective === 'string' ? goal.objective.trim() : '';
      return objective ? [`Goal: ${objective}`] : [];
    }
    default:
      return [];
  }
}

function progressMessagesForCompletedItem(
  item: CodexReasoningItem | CodexMessageItem | CodexWebSearchItem | CodexFunctionCallItem | undefined,
  state?: CodexProgressState,
): string[] {
  if (!item) return [];

  switch (item.type) {
    case 'reasoning': {
      const summary = normalizeStringArray((item as CodexReasoningItem).summary)
        .join('\n')
        .trim();
      return summary ? [summary] : [];
    }
    case 'agentMessage':
      return commentaryMessageProgress(item as CodexMessageItem);
    case 'message':
      return assistantCommentaryProgress(item as CodexMessageItem);
    case 'web_search_call':
    case 'webSearchCall':
      return webSearchProgress(item as CodexWebSearchItem, state);
    case 'function_call':
    case 'functionCall':
      return functionCallStartedProgress(item as CodexFunctionCallItem, state);
    case 'function_call_output':
    case 'functionCallOutput':
      return functionCallCompletedProgress(item as CodexFunctionCallItem, state);
    default:
      return [];
  }
}

function progressMessagesForStartedOrUpdatedItem(
  item: CodexFunctionCallItem | CodexWebSearchItem | undefined,
  state?: CodexProgressState,
): string[] {
  if (!item) return [];
  switch (item.type) {
    case 'function_call':
    case 'functionCall':
      return functionCallStartedProgress(item, state);
    case 'web_search_call':
    case 'webSearchCall':
      return webSearchProgress(item, state);
    default:
      return [];
  }
}

function commentaryMessageProgress(item: CodexMessageItem): string[] {
  if (item.phase !== 'commentary') return [];
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  return text ? [text] : [];
}

function assistantCommentaryProgress(item: CodexMessageItem): string[] {
  if (item.phase !== 'commentary' || item.role !== 'assistant') return [];
  const text = extractMessageText(item.content);
  return text ? [text] : [];
}

function webSearchProgress(item: CodexWebSearchItem, state?: CodexProgressState): string[] {
  if (item.status && item.status !== 'completed') return [];
  const query = webSearchQuery(item.action);
  const key = webSearchKey(item, query);
  if (key && state?.completedWebSearches?.has(key)) return [];
  if (key) state?.completedWebSearches?.add(key);
  return query ? [`Completed web search: ${query}`] : ['Completed web search.'];
}

function functionCallStartedProgress(item: CodexFunctionCallItem, state?: CodexProgressState): string[] {
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) return [];

  const callId = functionCallId(item);
  if (callId && state?.functionCalls.has(callId)) return [];
  if (callId) {
    state?.functionCalls.set(callId, name);
  }

  return [`Running ${name}.`];
}

function functionCallCompletedProgress(item: CodexFunctionCallItem, state?: CodexProgressState): string[] {
  const callId = functionCallId(item);
  const name = callId ? state?.functionCalls.get(callId) : undefined;
  if (callId) state?.functionCalls.delete(callId);
  return [name ? `Completed ${name}.` : 'Completed tool call.'];
}

function functionCallId(item: CodexFunctionCallItem): string {
  const raw = item.call_id ?? item.callId;
  return typeof raw === 'string' ? raw : '';
}

function webSearchQuery(action: unknown): string {
  if (!action || typeof action !== 'object') return '';
  const record = action as { query?: unknown; queries?: unknown };
  const query = typeof record.query === 'string' ? record.query : '';
  if (query.trim()) return truncateProgressDetail(query.trim());
  if (Array.isArray(record.queries)) {
    const first = record.queries.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return first ? truncateProgressDetail(first.trim()) : '';
  }
  return '';
}

function webSearchKey(item: CodexWebSearchItem, query: string): string {
  const id = typeof item.id === 'string' ? item.id : '';
  return id || query;
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const text = (entry as { text?: unknown }).text;
      return typeof text === 'string' ? text.trim() : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function truncateProgressDetail(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117).trimEnd()}...` : text;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

registerProvider('codex', (opts) => new CodexProvider(opts));
