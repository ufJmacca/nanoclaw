import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup, OutboundFile, OutboundMessage } from './adapter.js';

const mocks = vi.hoisted(() => ({
  bridgeDeliver: vi.fn(),
  bridgeSetup: vi.fn(),
  bridgeTeardown: vi.fn(),
  createTelegramAdapter: vi.fn(),
  readEnvFile: vi.fn(),
}));

vi.mock('@chat-adapter/telegram', () => ({
  createTelegramAdapter: mocks.createTelegramAdapter,
}));

vi.mock('../env.js', () => ({
  readEnvFile: mocks.readEnvFile,
}));

vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: vi.fn(
    (): ChannelAdapter => ({
      name: 'telegram',
      channelType: 'telegram',
      supportsThreads: false,
      setup: mocks.bridgeSetup,
      teardown: mocks.bridgeTeardown,
      isConnected: () => true,
      deliver: mocks.bridgeDeliver,
    }),
  ),
}));

function file(filename: string, body = 'hello'): OutboundFile {
  return { filename, data: Buffer.from(body) };
}

function telegramResponse(messageId: number | string): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function formFrom(call: unknown[]): FormData {
  return (call[1] as RequestInit).body as FormData;
}

async function loadTelegramAdapter(fetchMock: ReturnType<typeof vi.fn>): Promise<ChannelAdapter> {
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  mocks.readEnvFile.mockReturnValue({ TELEGRAM_BOT_TOKEN: 'TOKEN' });
  mocks.createTelegramAdapter.mockReturnValue({ name: 'telegram-adapter' });
  mocks.bridgeSetup.mockResolvedValue(undefined);
  mocks.bridgeTeardown.mockResolvedValue(undefined);
  mocks.bridgeDeliver.mockResolvedValue('bridge-message-id');

  await import('./telegram.js');
  const { getChannelAdapter, initChannelAdapters } = await import('./channel-registry.js');
  const setup: ChannelSetup = {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
  await initChannelAdapters(() => setup);

  const adapter = getChannelAdapter('telegram');
  expect(adapter).toBeDefined();
  return adapter!;
}

describe('telegram channel adapter outbound delivery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: string | Request | URL) => {
      const url = String(input);
      if (url.endsWith('/getMe')) {
        return new Response(JSON.stringify({ ok: true, result: { username: 'nanoclaw_bot' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return telegramResponse(900);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('delegates text-only delivery to the Chat SDK bridge', async () => {
    const adapter = await loadTelegramAdapter(fetchMock);
    const message: OutboundMessage = { kind: 'chat', content: { text: 'hello' } };

    const result = await adapter.deliver('telegram:123', null, message);

    expect(result).toBe('bridge-message-id');
    expect(mocks.bridgeDeliver).toHaveBeenCalledWith('telegram:123', null, message);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/send'))).toBe(false);
  });

  it('uploads file-only delivery through the Telegram Bot API', async () => {
    const adapter = await loadTelegramAdapter(fetchMock);

    const result = await adapter.deliver('telegram:123', null, {
      kind: 'chat',
      content: { files: ['report.pdf'] },
      files: [file('report.pdf')],
    });

    const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/sendDocument'));
    expect(result).toBe('900');
    expect(mocks.bridgeDeliver).not.toHaveBeenCalled();
    expect(uploadCall).toBeDefined();
    expect(formFrom(uploadCall!).get('chat_id')).toBe('123');
    expect((formFrom(uploadCall!).get('document') as { name?: string }).name).toBe('report.pdf');
  });

  it('uses short text plus files as the first upload caption', async () => {
    const adapter = await loadTelegramAdapter(fetchMock);

    await adapter.deliver('telegram:123', null, {
      kind: 'chat',
      content: { text: '**Host path**', files: ['report.pdf'] },
      files: [file('report.pdf')],
    });

    const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/sendDocument'));
    expect(mocks.bridgeDeliver).not.toHaveBeenCalled();
    expect(formFrom(uploadCall!).get('caption')).toBe('*Host path*');
  });

  it('sends long text through the bridge before uploading files without captions', async () => {
    const adapter = await loadTelegramAdapter(fetchMock);
    const longText = 'x'.repeat(1025);

    const result = await adapter.deliver('telegram:123', null, {
      kind: 'chat',
      content: { text: longText, files: ['report.pdf'] },
      files: [file('report.pdf')],
    });

    const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/sendDocument'));
    expect(result).toBe('bridge-message-id');
    expect(mocks.bridgeDeliver).toHaveBeenCalledTimes(1);
    expect(mocks.bridgeDeliver.mock.calls[0]![2].files).toBeUndefined();
    expect(formFrom(uploadCall!).get('caption')).toBeNull();
  });
});
