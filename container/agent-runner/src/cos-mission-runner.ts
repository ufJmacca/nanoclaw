/** Fixed specialist entry: one native task, no generic poll-loop output or shared history. */
import fs from 'node:fs';
import { CosCodexProvider } from './providers/codex-cos.js';
import { startSubscriptionRelay } from './cos-subscription-relay.js';
import { loadMissionRuntime } from './mission-runtime.js';
import { runMissionTask } from './mission-task.js';

if (process.env.NANOCLAW_COS_PROTOCOL !== 'cos-mission-rpc/v1') throw new Error('mission_runtime_denied');
const configFile = '/workspace/agent/container.json';
if (fs.statSync(configFile).size > 4096) throw new Error('mission_runtime_denied');
const runtime = loadMissionRuntime('/run/cos/mission', JSON.parse(fs.readFileSync(configFile, 'utf8')));
const cancellation = new AbortController();
process.once('SIGTERM', () => cancellation.abort());
process.once('SIGINT', () => cancellation.abort());
const relay = await startSubscriptionRelay();
try {
  const outcome = await runMissionTask({
    ...runtime,
    signal: cancellation.signal,
    provider: new CosCodexProvider({ model: runtime.config.model, proxyUrl: relay.proxyUrl, profile: 'research' }),
  });
  if (outcome === 'failed') process.exitCode = 1;
} finally {
  await relay.close();
}
