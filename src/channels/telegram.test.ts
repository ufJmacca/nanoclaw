import fs from 'fs';
import https from 'https';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commandHandlers = new Map<string, (ctx: any) => unknown>();
const eventHandlers = new Map<string, (ctx: any) => unknown>();
const sendMessageMock = vi.fn();
const sendChatActionMock = vi.fn();
const getFileMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();

class FakeBot {
  public readonly api = {
    sendMessage: sendMessageMock,
    sendChatAction: sendChatActionMock,
    getFile: getFileMock,
  };

  public readonly me = { username: 'andy_bot' };

  constructor(
    public readonly token: string,
    public readonly options: Record<string, unknown>,
  ) {}

  command(name: string, handler: (ctx: any) => unknown) {
    commandHandlers.set(name, handler);
    return this;
  }

  on(event: string, handler: (ctx: any) => unknown) {
    eventHandlers.set(event, handler);
    return this;
  }

  catch(_handler: (err: Error) => unknown) {
    return this;
  }

  start(opts?: {
    onStart?: (botInfo: { username: string; id: number }) => void;
  }) {
    startMock(opts);
    opts?.onStart?.({ username: 'andy_bot', id: 42 });
  }

  stop() {
    stopMock();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock('grammy', () => ({
  Api: class {},
  Bot: FakeBot,
}));

function baseGroup() {
  return {
    name: 'My Chat',
    folder: 'telegram_main',
    trigger: '@Andy',
    added_at: '2026-04-06T00:00:00.000Z',
    providerId: 'codex',
    isMain: true,
    requiresTrigger: false,
  };
}

async function loadTelegramRegistry() {
  vi.resetModules();
  const registry = await import('./registry.js');
  await import('./telegram.js');
  return registry;
}

describe('telegram channel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    commandHandlers.clear();
    eventHandlers.clear();
    sendMessageMock.mockReset();
    sendChatActionMock.mockReset();
    getFileMock.mockReset();
    startMock.mockReset();
    stopMock.mockReset();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('registers a factory that returns null when TELEGRAM_BOT_TOKEN is missing', async () => {
    const { getChannelFactory } = await loadTelegramRegistry();
    const factory = getChannelFactory('telegram');

    expect(factory).toBeTypeOf('function');
    expect(
      factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      }),
    ).toBeNull();
  });

  it('creates a telegram channel when TELEGRAM_BOT_TOKEN is present', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const { getChannelFactory } = await loadTelegramRegistry();
    const factory = getChannelFactory('telegram');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    expect(channel).not.toBeNull();
    expect(channel!.name).toBe('telegram');
    expect(channel!.ownsJid('tg:123')).toBe(true);
    expect(channel!.ownsJid('dc:123')).toBe(false);
  });

  it('connects the bot and exposes the /chatid helper command', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    await channel!.connect();

    expect(startMock).toHaveBeenCalledOnce();
    expect(commandHandlers.has('chatid')).toBe(true);

    const reply = vi.fn();
    await commandHandlers.get('chatid')!({
      chat: { id: 123456789, type: 'private' },
      from: { first_name: 'Jon' },
      reply,
    });

    expect(reply).toHaveBeenCalledWith(
      'Chat ID: `tg:123456789`\nName: Jon\nType: private',
      { parse_mode: 'Markdown' },
    );
  });

  it('stores metadata and forwards registered inbound messages', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage,
      onChatMetadata,
      registeredGroups: () => ({
        'tg:123456789': baseGroup(),
      }),
    });

    await channel!.connect();

    const handler = eventHandlers.get('message:text');
    expect(handler).toBeTypeOf('function');

    await handler!({
      chat: { id: 123456789, type: 'private' },
      from: { id: 55, first_name: 'Jon' },
      me: { username: 'andy_bot' },
      message: {
        text: 'hello @andy_bot',
        date: 1712419200,
        message_id: 77,
        message_thread_id: 999,
        entities: [{ type: 'mention', offset: 6, length: 9 }],
      },
    });

    expect(onChatMetadata).toHaveBeenCalledWith(
      'tg:123456789',
      '2024-04-06T16:00:00.000Z',
      'Jon',
      'telegram',
      false,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'tg:123456789',
      expect.objectContaining({
        id: '77',
        chat_jid: 'tg:123456789',
        sender: '55',
        sender_name: 'Jon',
        content: '@Andy hello @andy_bot',
        thread_id: '999',
        is_from_me: false,
      }),
    );
  });

  it('rewrites bot mentions using the group-specific trigger', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const onMessage = vi.fn();

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'tg:123456789': {
          ...baseGroup(),
          trigger: '@Boss',
        },
      }),
    });

    await channel!.connect();

    const handler = eventHandlers.get('message:text');
    expect(handler).toBeTypeOf('function');

    await handler!({
      chat: { id: 123456789, type: 'private' },
      from: { id: 55, first_name: 'Jon' },
      me: { username: 'andy_bot' },
      message: {
        text: 'hello @andy_bot',
        date: 1712419200,
        message_id: 79,
        entities: [{ type: 'mention', offset: 6, length: 9 }],
      },
    });

    expect(onMessage).toHaveBeenCalledWith(
      'tg:123456789',
      expect.objectContaining({
        id: '79',
        content: '@Boss hello @andy_bot',
      }),
    );
  });

  it('normalizes remote-control commands that include the Telegram bot suffix', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const onMessage = vi.fn();

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'tg:123456789': baseGroup(),
      }),
    });

    await channel!.connect();

    const handler = eventHandlers.get('message:text');
    expect(handler).toBeTypeOf('function');

    await handler!({
      chat: { id: 123456789, type: 'private' },
      from: { id: 55, first_name: 'Jon' },
      me: { username: 'andy_bot' },
      message: {
        text: '/remote-control@andy_bot',
        date: 1712419200,
        message_id: 78,
        entities: [],
      },
    });

    expect(onMessage).toHaveBeenCalledWith(
      'tg:123456789',
      expect.objectContaining({
        id: '78',
        content: '/remote-control',
      }),
    );
  });

  it('stores document messages before the attachment download finishes', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const onMessage = vi.fn();

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'tg:123456789': baseGroup(),
      }),
    });

    await channel!.connect();

    const handler = eventHandlers.get('message:document');
    expect(handler).toBeTypeOf('function');

    const download = createDeferred<string | null>();
    vi.spyOn(channel as any, 'downloadFile').mockReturnValue(download.promise);

    handler!({
      chat: { id: 123456789, type: 'private' },
      from: { id: 55, first_name: 'Jon' },
      message: {
        date: 1712419200,
        message_id: 88,
        caption: 'Quarterly report',
        document: {
          file_id: 'doc-file-1',
          file_name: 'report.pdf',
        },
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenNthCalledWith(
      1,
      'tg:123456789',
      expect.objectContaining({
        id: '88',
        content: '[Document: report.pdf] Quarterly report',
        timestamp: '2024-04-06T16:00:00.000Z',
      }),
    );

    download.resolve('/workspace/group/attachments/report_88.pdf');
    await download.promise;
    await Promise.resolve();

    expect(onMessage).toHaveBeenCalledTimes(2);
    const attachmentEvent = onMessage.mock.calls[1][1];
    expect(onMessage).toHaveBeenNthCalledWith(
      2,
      'tg:123456789',
      expect.objectContaining({
        id: '88:attachment',
        content:
          '[Document: report.pdf] (/workspace/group/attachments/report_88.pdf) Quarterly report',
      }),
    );
    expect(
      attachmentEvent.timestamp > onMessage.mock.calls[0][1].timestamp,
    ).toBe(true);
  });

  it('uses a message-specific filename when downloading documents', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'tg:123456789': baseGroup(),
      }),
    });

    await channel!.connect();

    const handler = eventHandlers.get('message:document');
    expect(handler).toBeTypeOf('function');

    const downloadSpy = vi
      .spyOn(channel as any, 'downloadFile')
      .mockResolvedValue(null);

    handler!({
      chat: { id: 123456789, type: 'private' },
      from: { id: 55, first_name: 'Jon' },
      message: {
        date: 1712419200,
        message_id: 99,
        document: {
          file_id: 'doc-file-2',
          file_name: 'report.pdf',
        },
      },
    });

    expect(downloadSpy).toHaveBeenCalledWith(
      'doc-file-2',
      'telegram_main',
      'report_99.pdf',
    );
  });

  it('captures media chat metadata before registration gating', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage,
      onChatMetadata,
      registeredGroups: () => ({}),
    });

    await channel!.connect();

    const handler = eventHandlers.get('message:document');
    expect(handler).toBeTypeOf('function');

    handler!({
      chat: { id: 123456789, type: 'private' },
      from: { id: 55, first_name: 'Jon' },
      message: {
        date: 1712419200,
        message_id: 101,
        document: {
          file_id: 'doc-file-3',
          file_name: 'report.pdf',
        },
      },
    });

    expect(onChatMetadata).toHaveBeenCalledWith(
      'tg:123456789',
      '2024-04-06T16:00:00.000Z',
      'Jon',
      'telegram',
      false,
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('downloads files with the configured Telegram fetch settings', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'tg:123456789': baseGroup(),
      }),
    });

    await channel!.connect();

    getFileMock.mockResolvedValue({ file_path: 'documents/report.pdf' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    const filePath = await (channel as any).downloadFile(
      'doc-file-4',
      'telegram_main',
      'report_102.pdf',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/file/bottest-token/documents/report.pdf',
      expect.objectContaining({
        agent: https.globalAgent,
        compress: true,
      }),
    );
    expect(filePath).toBe('/workspace/group/attachments/report_102.pdf');
  });
});
