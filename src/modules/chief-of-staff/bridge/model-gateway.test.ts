import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startModelGateway, modelRequest } from './model-gateway.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-model-gateway-')),
    socket = path.join(root, 'model.sock');
  const authorize = vi.fn().mockResolvedValue(true);
  const upstream = vi.fn().mockResolvedValue({
    status: 200,
    body: (async function* () {
      yield Buffer.from('data: {"type":"response.completed"}\n\n');
    })(),
  });
  const gateway = await startModelGateway({
    socket,
    model: 'fixture-model',
    apiKey: 'PRIVATE_MODEL_KEY_CANARY',
    authorize,
    upstream,
  });
  cleanups.push(async () => {
    await gateway.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (body: unknown, url = '/v1/responses', method = 'POST') =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: socket,
          path: url,
          method,
          headers: { 'content-type': 'application/json', authorization: 'Bearer untrusted-worker' },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, text }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  return { request, upstream, authorize };
}
const body = {
  model: 'fixture-model',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Fixture request' }] }],
  tools: [{ type: 'function', name: 'cos_context_get', parameters: { type: 'object' } }],
  stream: true,
};
describe('S01 model-only gateway', () => {
  it('accepts the pinned Codex wire metadata but does not forward it or a worker-selected priority tier', () => {
    const result = modelRequest(
      { ...body, client_metadata: { originator: 'codex_cli' }, service_tier: 'priority' },
      'fixture-model',
    );
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('client_metadata');
    expect(result?.service_tier).toBe('default');
  });
  it('accepts only the admitted fixed model endpoint, strips ambient authority and disables storage', async () => {
    const f = await fixture();
    const result = await f.request(body);
    expect(result.status).toBe(200);
    expect(result.text).not.toContain('PRIVATE_MODEL_KEY_CANARY');
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.upstream.mock.calls[0][0]).toMatchObject({
      model: 'fixture-model',
      store: false,
      background: false,
      max_output_tokens: 4096,
    });
  });
  it('blocks foreign endpoints, hosted tools, remote media, old server-side conversations and model changes', async () => {
    const f = await fixture();
    for (const input of [
      { ...body, model: 'different' },
      { ...body, tools: [{ type: 'web_search' }] },
      { ...body, tools: [{ type: 'mcp', server_url: 'https://foreign.invalid' }] },
      {
        ...body,
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://foreign.invalid/image' }] }],
      },
      { ...body, previous_response_id: 'foreign-response' },
      { ...body, conversation: 'foreign-conversation' },
    ])
      expect((await f.request(input)).status).toBe(400);
    expect((await f.request(body, '/v1/files')).status).toBe(404);
    expect((await f.request(body, '/v1/responses?redirect=foreign')).status).toBe(404);
    expect(f.upstream).not.toHaveBeenCalled();
  });
  it('rechecks admission for every call and emits no driver or credential details on failure', async () => {
    const f = await fixture();
    f.authorize.mockResolvedValue(false);
    expect((await f.request(body)).status).toBe(403);
    expect(f.upstream).not.toHaveBeenCalled();
    f.authorize.mockRejectedValue(new Error('PRIVATE_DATABASE_CANARY'));
    const result = await f.request(body);
    expect(result.status).toBe(503);
    expect(result.text).not.toContain('CANARY');
  });
});
