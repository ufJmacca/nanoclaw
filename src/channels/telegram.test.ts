import fs from 'fs';
import https from 'https';
import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commandHandlers = new Map<string, (ctx: any) => unknown>();
const eventHandlers = new Map<string, (ctx: any) => unknown>();
const botInstances: FakeBot[] = [];
const sendMessageMock = vi.fn();
const sendChatActionMock = vi.fn();
const getFileMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();
let autoStartBot = true;
let startResult: Promise<void> | void = undefined;

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
  ) {
    botInstances.push(this);
  }

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
    if (autoStartBot) {
      opts?.onStart?.({ username: 'andy_bot', id: 42 });
    }
    return startResult;
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
    vi.useRealTimers();
  });

  beforeEach(() => {
    commandHandlers.clear();
    eventHandlers.clear();
    botInstances.length = 0;
    sendMessageMock.mockReset();
    sendChatActionMock.mockReset();
    getFileMock.mockReset();
    startMock.mockReset();
    stopMock.mockReset();
    autoStartBot = true;
    startResult = undefined;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CONNECT_TIMEOUT_MS;
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
    expect(botInstances[0]?.options).toEqual(
      expect.objectContaining({
        client: expect.objectContaining({
          baseFetchConfig: expect.objectContaining({
            agent: expect.objectContaining({
              options: expect.objectContaining({
                family: 4,
              }),
            }),
          }),
        }),
      }),
    );
    expect(commandHandlers.has('chatid')).toBe(true);

    const reply = vi.fn();
    await commandHandlers.get('chatid')!({
      chat: { id: 123456789, type: 'private' },
      from: { first_name: 'Jon' },
      reply,
    });

    expect(reply).toHaveBeenCalledWith(
      'Chat ID: tg:123456789\nName: Jon\nType: private',
    );
  });

  it('rejects connect when Telegram polling never starts', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    autoStartBot = false;
    startResult = new Promise<void>(() => {});
    vi.useFakeTimers();

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    const connectPromise = channel!.connect();
    const rejection = expect(connectPromise).rejects.toThrow(
      'Telegram bot start timed out after 10000ms',
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(stopMock).toHaveBeenCalledOnce();
  });

  it('uses TELEGRAM_CONNECT_TIMEOUT_MS when set', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CONNECT_TIMEOUT_MS = '250';
    autoStartBot = false;
    startResult = new Promise<void>(() => {});
    vi.useFakeTimers();

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    const connectPromise = channel!.connect();
    const rejection = expect(connectPromise).rejects.toThrow(
      'Telegram bot start timed out after 250ms',
    );
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(stopMock).toHaveBeenCalledOnce();
  });

  it('sends /chatid as plain text for markdown-heavy group names', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    await channel!.connect();

    const reply = vi.fn();
    await commandHandlers.get('chatid')!({
      chat: {
        id: -100987654321,
        type: 'supergroup',
        title: 'Ops_[Oncall](1)',
      },
      from: { first_name: 'Jon' },
      reply,
    });

    expect(reply).toHaveBeenCalledWith(
      'Chat ID: tg:-100987654321\nName: Ops_[Oncall](1)\nType: supergroup',
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
        message_thread_id: 777,
        caption: 'Quarterly report',
        reply_to_message: {
          message_id: 40,
          caption: 'Previous report',
          from: { id: 66, first_name: 'Alice' },
        },
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
        thread_id: '777',
        reply_to_message_id: '40',
        reply_to_message_content: 'Previous report',
        reply_to_sender_name: 'Alice',
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
        thread_id: '777',
        reply_to_message_id: '40',
        reply_to_message_content: 'Previous report',
        reply_to_sender_name: 'Alice',
      }),
    );
    expect(
      attachmentEvent.timestamp > onMessage.mock.calls[0][1].timestamp,
    ).toBe(true);
  });

  it('keeps trigger-prefixed captions at the start of media content', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const onMessage = vi.fn();

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'tg:123456789': {
          ...baseGroup(),
          isMain: false,
          requiresTrigger: true,
        },
      }),
    });

    await channel!.connect();

    const handler = eventHandlers.get('message:document');
    expect(handler).toBeTypeOf('function');

    vi.spyOn(channel as any, 'downloadFile').mockResolvedValue(null);

    handler!({
      chat: { id: 123456789, type: 'private' },
      from: { id: 55, first_name: 'Jon' },
      message: {
        date: 1712419200,
        message_id: 89,
        caption: '@Andy summarize this',
        document: {
          file_id: 'doc-file-trigger',
          file_name: 'report.pdf',
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(
      'tg:123456789',
      expect.objectContaining({
        id: '89',
        content: '@Andy summarize this [Document: report.pdf]',
      }),
    );
  });

  it('rewrites media-caption bot mentions using the group-specific trigger', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const onMessage = vi.fn();

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'tg:123456789': {
          ...baseGroup(),
          isMain: false,
          requiresTrigger: true,
          trigger: '@Boss',
        },
      }),
    });

    await channel!.connect();

    const handler = eventHandlers.get('message:document');
    expect(handler).toBeTypeOf('function');

    vi.spyOn(channel as any, 'downloadFile').mockResolvedValue(null);

    handler!({
      chat: { id: 123456789, type: 'private' },
      from: { id: 55, first_name: 'Jon' },
      message: {
        date: 1712419200,
        message_id: 90,
        caption: 'please review @andy_bot',
        document: {
          file_id: 'doc-file-mention',
          file_name: 'report.pdf',
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(
      'tg:123456789',
      expect.objectContaining({
        id: '90',
        content: '@Boss please review @andy_bot [Document: report.pdf]',
      }),
    );
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

  it('routes outbound Telegram replies into the provided thread', async () => {
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
    await channel!.sendMessage('tg:123456789', 'hello thread', '999');

    expect(sendMessageMock).toHaveBeenCalledWith(
      '123456789',
      'hello thread',
      expect.objectContaining({
        message_thread_id: 999,
        parse_mode: 'Markdown',
      }),
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

  it('downloads files with the configured Telegram IPv4 transport', async () => {
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
    const getMock = vi.spyOn(https, 'get').mockImplementation(((
      _url,
      options,
      callback,
    ) => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        resume?: () => void;
      };
      response.statusCode = 200;
      response.resume = vi.fn();
      queueMicrotask(() => {
        callback?.(response as any);
        response.emit('data', Buffer.from([1, 2, 3]));
        response.emit('end');
      });

      return {
        on: vi.fn().mockReturnThis(),
        setTimeout: vi.fn().mockReturnThis(),
        destroy: vi.fn(),
      } as any;
    }) as typeof https.get);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    const filePath = await (channel as any).downloadFile(
      'doc-file-4',
      'telegram_main',
      'report_102.pdf',
    );

    expect(getMock).toHaveBeenCalledWith(
      'https://api.telegram.org/file/bottest-token/documents/report.pdf',
      expect.objectContaining({
        agent: expect.objectContaining({
          options: expect.objectContaining({
            family: 4,
          }),
        }),
        family: 4,
      }),
      expect.any(Function),
    );
    expect(filePath).toBe('/workspace/group/attachments/report_102.pdf');
  });

  it('returns null when the IPv4 Telegram download transport gets an HTTP error', async () => {
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
    vi.spyOn(https, 'get').mockImplementation(((_url, _options, callback) => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        resume?: () => void;
      };
      response.statusCode = 502;
      response.resume = vi.fn();
      queueMicrotask(() => {
        callback?.(response as any);
      });

      return {
        on: vi.fn().mockReturnThis(),
        setTimeout: vi.fn().mockReturnThis(),
        destroy: vi.fn(),
      } as any;
    }) as typeof https.get);

    const filePath = await (channel as any).downloadFile(
      'doc-file-4',
      'telegram_main',
      'report_102.pdf',
    );

    expect(filePath).toBeNull();
  });

  it('returns null when the IPv4 Telegram download transport gets redirected', async () => {
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
    vi.spyOn(https, 'get').mockImplementation(((_url, _options, callback) => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        resume?: () => void;
      };
      response.statusCode = 302;
      response.resume = vi.fn();
      queueMicrotask(() => {
        callback?.(response as any);
      });

      return {
        on: vi.fn().mockReturnThis(),
        setTimeout: vi.fn().mockReturnThis(),
        destroy: vi.fn(),
      } as any;
    }) as typeof https.get);

    const filePath = await (channel as any).downloadFile(
      'doc-file-4',
      'telegram_main',
      'report_102.pdf',
    );

    expect(filePath).toBeNull();
  });
});
