/** Dedicated CoS coordinator: no ordinary provider barrel, shared memory or configurable MCP servers. */
import fs from 'node:fs';
import { CodexProvider } from './providers/codex.js';
import { CosCodexProvider } from './providers/codex-cos.js';
import { loadConfig } from './config.js';
import { runPollLoop } from './poll-loop.js';
import { startCosRelay } from './cos-relay.js';
import { startSubscriptionRelay } from './cos-subscription-relay.js';
import { clearContinuation } from './db/session-state.js';

const raw = JSON.parse(fs.readFileSync('/workspace/agent/container.json', 'utf8'));
const native = raw.runtime === 'codex-subscription/v1';
if (
  process.env.NANOCLAW_COS_PROTOCOL !== 'cos-rpc/v1' ||
  raw.provider !== 'codex' ||
  typeof raw.model !== 'string' ||
  !/^[a-zA-Z0-9._-]{1,100}$/.test(raw.model) ||
  (raw.runtime !== undefined && !native) ||
  (native &&
    (typeof raw.contextGeneration !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.contextGeneration)))
)
  throw new Error('restricted_configuration_required');
loadConfig();
// The legacy gateway remains a fixture profile. Production uses the host-bound
// generation and durable native HOME; an ordinary restart never clears it.
if (!native) clearContinuation('codex');
const relay = native ? await startSubscriptionRelay() : await startCosRelay();
const cancellation = new AbortController();
process.once('SIGTERM', () => cancellation.abort());
process.once('SIGINT', () => cancellation.abort());
try {
  await runPollLoop({
    provider: native
      ? new CosCodexProvider({
          model: raw.model,
          proxyUrl: (relay as Awaited<ReturnType<typeof startSubscriptionRelay>>).proxyUrl,
        })
      : new CodexProvider({
          restrictedCos: true,
          env: { CODEX_MODEL: raw.model },
          mcpServers: {
            cos: { command: 'bun', args: ['/app/src/cos-mcp.ts'], env: { NANOCLAW_COS_PROTOCOL: 'cos-rpc/v1' } },
          },
        }),
    providerName: native ? 'cos-codex-subscription:' + raw.contextGeneration : 'codex',
    ...(native ? { continuationPolicy: 'host-scoped' as const } : {}),
    cwd: '/workspace/agent',
    signal: cancellation.signal,
    systemContext: {
      instructions: `You are the private Chief of Staff for the current owner.
Use cos_context_get to read approved priorities; cite returned record IDs and versions. Rank attention as advice.
Use cos_change_propose to propose charter, goal or project changes. Proposed changes are not approved facts.
Never approve or apply changes yourself. The host handles owner approval separately.
If a request is pending, reconcile its original request ID with cos_request_status before retrying.
If context is unavailable or empty, say so. Do not invent records or import other histories.
Reply in plain text to this conversation. You have no authority for external actions or account access.`,
    },
  });
} finally {
  await relay.close();
}
