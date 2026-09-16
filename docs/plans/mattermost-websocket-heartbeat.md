# Mattermost WebSocket heartbeat

Status: Planned; not implemented.

## Summary

Detect silently stalled Mattermost connections and automatically reconnect using the existing backoff and missed-message recovery logic.

Use a protocol-level ping every **30 seconds**, with **10 seconds** to receive its matching pong. Normal channel inactivity must not cause reconnection.

## Implementation

- Implement heartbeat ownership in `NodeMattermostTransport` in `src/channels/mattermost-client.ts`. Start monitoring when the socket opens; keep the existing authentication timeout.
- Allow one outstanding ping. Give each ping a unique payload and accept only its matching pong. Send subsequent pings at 30-second intervals.
- Arm the pong timeout before sending the ping. On timeout or ping-send failure, clear heartbeat state and forcefully terminate the underlying socket. Its existing close/error handling must initiate exactly one reconnect.
- Clear heartbeat timers and listeners on explicit close, socket error, remote close, and termination. Late callbacks from an old socket must never affect a replacement connection.
- Reuse the existing reconnect backoff, sequence tracking, and recovery hooks. Heartbeat success must not reset reconnect backoff or alter message-processing state.
- Log heartbeat timeouts and send failures without credentials or message contents. Avoid routine ping/pong logs.

## Interfaces and compatibility

- Extend `MattermostNodeWebSocket` with the required `ping`, `terminate`, and pong-listener methods.
- Add an optional third `NodeMattermostTransport` constructor argument using the existing `MattermostTimers` interface, defaulting to system timers.
- Leave the higher-level `MattermostWebSocket` interface unchanged, preserving existing client mocks and alternate transports.
- Use fixed timing constants for this change; no new environment variables, database migrations, or container dependencies.

## Tests and rollout

Extend `src/channels/mattermost-client.test.ts` with fake sockets and deterministic timers:

- Healthy, quiet connections remain connected across multiple heartbeat cycles.
- Missing, mismatched, or unsolicited pongs do not satisfy the outstanding check.
- Timeout and ping-send failure terminate the connection once and trigger existing reconnect behavior.
- Ordinary incoming messages do not replace a matching pong.
- Shutdown, authentication failure, and remote disconnect clean up timers; stale callbacks cannot terminate a new connection.
- A heartbeat-triggered reconnect exercises existing recovery hooks, with replayed posts deduplicated by the existing receipt mechanism.

Run the Mattermost client, adapter, and recovery tests, host typecheck, and formatting checks. Build the host with `pnpm run build`, restart NanoClaw v2, and verify Mattermost startup plus at least two healthy heartbeat cycles. No agent-image rebuild is required.

Assumption: this change addresses silent transport failures; detecting stalled application handlers remains outside this implementation.
