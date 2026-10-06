import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCosToolDispatch } from './codex-cos-tools.js';
import { createMandateToolBridge, callNativeMandateTool } from './codex-mandate-bridge.js';
test('S10 retained main conversations discover review tools through the existing image-owned server and turn fence', async () => {
  const f = await fixture(),
    review_id = 'review-' + 'a'.repeat(64);
  try {
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_review_get', { review_id, revision: 1 })).isError).toBe(
      true,
    );
    f.bridge.beginTurn('thread', 'turn');
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_review_get', { review_id, revision: 1 })).isError).toBe(
      false,
    );
    const config = Bun.TOML.parse(f.bridge.configuration) as any;
    expect(config.mcp_servers.nanoclaw_cos_mandates.enabled_tools).toContain('cos_review_request');
    expect(config.mcp_servers.nanoclaw_cos_mandates.tools.cos_review_request.approval_mode).toBe('approve');
    for (const tool of ['cos_review_approve', 'cos_strategy_apply', 'cos_review_schedule'])
      expect((await callNativeMandateTool(f.bridge.socket, tool, {})).isError).toBe(true);
    f.bridge.endTurn();
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_review_get', { review_id, revision: 1 })).isError).toBe(
      true,
    );
    expect(f.calls).toEqual(['cos_review_get']);
  } finally {
    await f.close();
  }
});

const mandate_id = 'mandate-' + 'a'.repeat(64);
test('S09 retained coordinator context gains action controls through the same fenced MCP bridge', async () => {
  const f = await fixture();
  const action_id = 'action-' + 'a'.repeat(64);
  try {
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_action_get', { action_id })).isError).toBe(true);
    f.bridge.beginTurn('existing-retained-thread', 'owner-turn');
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_action_get', { action_id })).isError).toBe(false);
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_action_cancel', { action_id })).isError).toBe(false);
    for (const tool of ['cos_action_approve', 'cos_action_execute', 'cos_action_delete', 'cos_action_retry'])
      expect((await callNativeMandateTool(f.bridge.socket, tool, { action_id })).isError).toBe(true);
    expect(
      (await callNativeMandateTool(f.bridge.socket, 'cos_action_get', { action_id, scope_id: 'foreign' })).isError,
    ).toBe(true);
    const config = Bun.TOML.parse(f.bridge.configuration) as any;
    expect(config.mcp_servers.nanoclaw_cos_mandates.enabled_tools).toContain('cos_action_propose');
    expect(config.mcp_servers.nanoclaw_cos_mandates.tools.cos_action_propose.approval_mode).toBe('approve');
    f.bridge.endTurn();
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_action_get', { action_id })).isError).toBe(true);
    expect(f.calls).toEqual(['cos_action_get', 'cos_action_cancel']);
  } finally {
    await f.close();
  }
});
async function fixture(execute?: Parameters<typeof createCosToolDispatch>[0]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mandate-bridge-'));
  fs.chmodSync(directory, 0o700);
  const calls: string[] = [];
  const dispatch = createCosToolDispatch(
    execute ??
      (async (r) => {
        calls.push(r.method);
        return { protocol: 'cos-rpc/v1', request_id: r.request_id, status: 'ok', result: {} };
      }),
  );
  const bridge = await createMandateToolBridge(dispatch, directory);
  return {
    calls,
    dispatch,
    bridge,
    async close() {
      await bridge.close();
      fs.rmSync(directory, { recursive: true });
    },
  };
}
test('S08/S09 retained-thread coordinator MCP shares the current native turn fence and exposes only fixed tools', async () => {
  const f = await fixture();
  try {
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_mandate_activity', { mandate_id })).isError).toBe(true);
    f.bridge.beginTurn('thread', 'turn');
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_mandate_activity', { mandate_id })).isError).toBe(false);
    for (const [tool, args] of [
      ['cos_context_get', {}],
      ['exec_command', { cmd: 'touch /tmp/escaped' }],
      ['cos_mandate_activity', { mandate_id, scope_id: 'foreign' }],
      ['cos_mandate_activity', { mandate_id, payload: 'x'.repeat(70000) }],
    ] as const)
      expect((await callNativeMandateTool(f.bridge.socket, tool, args)).isError).toBe(true);
    f.bridge.endTurn();
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_mandate_activity', { mandate_id })).isError).toBe(true);
    expect(f.calls).toEqual(['cos_mandate_activity']);
    expect(fs.statSync(f.bridge.socket).mode & 0o777).toBe(0o600);
    const config = Bun.TOML.parse(f.bridge.configuration) as any;
    expect(Object.keys(config.mcp_servers)).toEqual(['nanoclaw_cos_mandates']);
    expect(config.mcp_servers.nanoclaw_cos_mandates.required).toBe(true);
    expect(config.mcp_servers.nanoclaw_cos_mandates.env_vars).toEqual([]);
    expect(config.mcp_servers.nanoclaw_cos_mandates.enabled_tools).toEqual([
      'cos_mandate_activity',
      'cos_mandate_propose',
      'cos_action_propose',
      'cos_action_get',
      'cos_action_cancel',
      'cos_review_charter_propose',
      'cos_strategy_observation_propose',
      'cos_strategy_direction_propose',
      'cos_review_request',
      'cos_review_submit',
      'cos_review_get',
    ]);
    expect(config.mcp_servers.nanoclaw_cos_mandates.default_tools_approval_mode).toBe('prompt');
    expect(Object.keys(config.mcp_servers.nanoclaw_cos_mandates.tools)).toEqual([
      'cos_mandate_activity',
      'cos_mandate_propose',
      'cos_action_propose',
      'cos_action_get',
      'cos_action_cancel',
      'cos_review_charter_propose',
      'cos_strategy_observation_propose',
      'cos_strategy_direction_propose',
      'cos_review_request',
      'cos_review_submit',
      'cos_review_get',
    ]);
  } finally {
    await f.close();
  }
});
test('S08 mandate MCP and dynamic calls spend the same 32-call turn limit', async () => {
  const f = await fixture();
  try {
    f.bridge.beginTurn('thread', 'turn');
    for (let i = 0; i < 31; i++)
      expect(
        (
          await f.dispatch.handle({
            id: i,
            method: 'item/tool/call',
            params: {
              threadId: 'thread',
              turnId: 'turn',
              callId: String(i),
              tool: 'cos_context_get',
              arguments: {},
            },
          })
        ).success,
      ).toBe(true);
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_mandate_activity', { mandate_id })).isError).toBe(false);
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_mandate_activity', { mandate_id })).isError).toBe(true);
    expect(f.calls).toHaveLength(32);
    f.bridge.beginTurn('thread', 'next');
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_mandate_activity', { mandate_id })).isError).toBe(false);
  } finally {
    await f.close();
  }
});
test('S08 mandate MCP refuses concurrent dispatch and withholds a late response after cancellation', async () => {
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const f = await fixture(async (r) => {
    started();
    await hold;
    return { protocol: 'cos-rpc/v1', request_id: r.request_id, status: 'ok', result: { canary: 'late' } };
  });
  try {
    f.bridge.beginTurn('thread', 'turn');
    const pending = callNativeMandateTool(f.bridge.socket, 'cos_mandate_activity', { mandate_id });
    await ready;
    expect((await callNativeMandateTool(f.bridge.socket, 'cos_mandate_activity', { mandate_id })).isError).toBe(true);
    f.bridge.endTurn();
    release();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('late');
  } finally {
    release();
    await f.close();
  }
});
test('S08 mandate bridge requires a private owned directory and closes without leaving a callable socket', async () => {
  const f = await fixture();
  const socket = f.bridge.socket;
  try {
    const directory = path.dirname(socket);
    fs.chmodSync(directory, 0o755);
    await expect(createMandateToolBridge(f.dispatch, directory)).rejects.toThrow('cos_tool_bridge_unavailable');
    fs.chmodSync(directory, 0o700);
    f.bridge.beginTurn('thread', 'turn');
    await f.bridge.close();
    expect(fs.existsSync(socket)).toBe(false);
    expect((await callNativeMandateTool(socket, 'cos_mandate_activity', { mandate_id })).isError).toBe(true);
  } finally {
    await f.close();
  }
});
