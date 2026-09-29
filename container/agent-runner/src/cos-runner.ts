/** Dedicated CoS coordinator: no ordinary provider barrel, shared memory or configurable MCP servers. */
import fs from 'node:fs';
import { CodexProvider } from './providers/codex.js';
import { loadConfig } from './config.js';
import { runPollLoop } from './poll-loop.js';
import { startCosRelay } from './cos-relay.js';
import { clearContinuation } from './db/session-state.js';

const raw = JSON.parse(fs.readFileSync('/workspace/agent/container.json', 'utf8'));
if (
  process.env.NANOCLAW_COS_PROTOCOL !== 'cos-rpc/v1' ||
  raw.provider !== 'codex' ||
  typeof raw.model !== 'string' ||
  !/^[a-zA-Z0-9._-]{1,100}$/.test(raw.model)
)
  throw new Error('restricted_configuration_required');
loadConfig();
// Provider HOME is ephemeral. Only host-approved CoS records survive a fresh launch.
clearContinuation('codex');
const relay = await startCosRelay();
const cancellation = new AbortController();
process.once('SIGTERM', () => cancellation.abort());
process.once('SIGINT', () => cancellation.abort());
try {
  await runPollLoop({
    provider: new CodexProvider({
      restrictedCos: true,
      env: { CODEX_MODEL: raw.model },
      mcpServers: {
        cos: { command: 'bun', args: ['/app/src/cos-mcp.ts'], env: { NANOCLAW_COS_PROTOCOL: 'cos-rpc/v1' } },
      },
    }),
    providerName: 'codex',
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
