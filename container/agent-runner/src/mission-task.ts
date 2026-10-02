/** One host-admitted native task. Provider prose is never a chat message or a mission result. */
import { openInboundDb, getOutboundDb, clearStaleProcessingAcks, touchHeartbeat } from './db/connection.js';
import { markProcessing, markCompleted, markFailed, type MessageInRow } from './db/messages-in.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { digest } from './mcp-tools/generated/cos-protocol.js';
import { validMissionRuntimeConfig, type MissionRuntimeConfig } from './mcp-tools/generated/mission-runtime.js';
import type { AgentProvider, AgentQuery } from './providers/types.js';

export async function runMissionTask(options: {
  config: MissionRuntimeConfig;
  deadlineAt: string;
  instructions: string;
  provider: AgentProvider;
  signal?: AbortSignal;
}): Promise<'idle' | 'processed' | 'failed'> {
  const { config, provider, signal } = options;
  if (!validMissionRuntimeConfig(config)) throw new Error('mission_input_denied');
  const m = config.mission,
    inbound = openInboundDb();
  let rows: MessageInRow[];
  try {
    rows = inbound.query('SELECT * FROM messages_in LIMIT 2').all() as MessageInRow[];
  } finally {
    inbound.close();
  }
  const row = rows[0];
  const expected = {
    text: 'Perform the approved read-only research work order using only its admitted context.',
    mission: {
      mission_id: m.missionId,
      attempt_id: m.attemptId,
      generation: m.generation,
      work_order_digest: m.workOrderDigest,
    },
  };
  let matches = false;
  try {
    matches = !!row && digest(JSON.parse(row.content)) === digest(expected);
  } catch {
    /* Invalid transport data grants nothing. */
  }
  if (
    rows.length !== 1 ||
    row.id !== m.inputId ||
    row.kind !== 'task' ||
    row.channel_type !== null ||
    row.platform_id !== null ||
    row.thread_id !== null ||
    row.recurrence !== null ||
    row.process_after !== null ||
    row.trigger !== 1 ||
    !matches
  )
    throw new Error('mission_input_denied');
  // Native crash recovery retains this same input, attempt and continuation. Host reservations
  // still precede every physical model turn; this never creates a new mission generation.
  clearStaleProcessingAcks();
  if (row.status !== 'pending' || getOutboundDb().query('SELECT 1 FROM processing_ack WHERE message_id=?').get(row.id))
    return 'idle';
  const remaining = Date.parse(options.deadlineAt) - Date.now();
  if (signal?.aborted || !Number.isFinite(remaining) || remaining <= 0 || remaining > 1800000) {
    markFailed(row.id);
    return 'failed';
  }
  const providerName = 'cos-mission-subscription:' + m.attemptId;
  let query: AgentQuery | undefined,
    failed = false,
    result = false,
    cancelled = false;
  const abort = () => {
    if (!cancelled) {
      cancelled = true;
      query?.abort();
    }
  };
  const deadline = setTimeout(abort, remaining),
    heartbeat = setInterval(touchHeartbeat, 1000);
  signal?.addEventListener('abort', abort, { once: true });
  markProcessing([row.id]);
  touchHeartbeat();
  try {
    query = provider.query({
      cwd: '/workspace/agent',
      continuation: getContinuation(providerName),
      prompt: JSON.stringify(expected),
      systemContext: { instructions: options.instructions },
    });
    query.end();
    for await (const event of query.events) {
      if (cancelled || signal?.aborted) break;
      if (event.type === 'init') {
        if (!/^cos-mission-codex-subscription-v1:[a-zA-Z0-9_-]{1,128}$/.test(event.continuation)) {
          failed = true;
          abort();
          break;
        }
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'error') failed = true;
      else if (event.type === 'result') result = true;
      // No generic result formatting, destinations, files, progress or error messages leave this entry.
    }
  } catch {
    failed = true;
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', abort);
  }
  if (failed || cancelled || signal?.aborted || !result) {
    markFailed(row.id);
    return 'failed';
  }
  // This acknowledges transport only. The host must accept a separate result submission and review it.
  markCompleted([row.id]);
  return 'processed';
}
