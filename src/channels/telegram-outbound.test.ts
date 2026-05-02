import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, OutboundFile, OutboundMessage } from './adapter.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import {
  deliverTelegramOutbound,
  sendTelegramOutboundFiles,
  telegramChatIdFromPlatformId,
  telegramUploadTarget,
} from './telegram-outbound.js';

function file(filename: string, body = 'hello'): OutboundFile {
  return { filename, data: Buffer.from(body) };
}

function telegramResponse(messageId: number | string, status = 200): Response {
  return new Response(JSON.stringify({ ok: status < 400, result: { message_id: messageId } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function telegramError(description: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, description }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function formAt(fetchMock: ReturnType<typeof vi.fn>, index: number): FormData {
  return fetchMock.mock.calls[index]![1]!.body as FormData;
}

describe('telegram outbound upload helpers', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => telegramResponse(100)),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('converts Telegram platform ids to Bot API chat ids', () => {
    expect(telegramChatIdFromPlatformId('telegram:123')).toBe('123');
    expect(telegramChatIdFromPlatformId('telegram:-100123')).toBe('-100123');
    expect(telegramChatIdFromPlatformId('123')).toBe('123');
  });

  it('selects media endpoints from filename extensions', () => {
    expect(telegramUploadTarget('photo.jpg')).toEqual({ endpoint: 'sendPhoto', field: 'photo' });
    expect(telegramUploadTarget('photo.png')).toEqual({ endpoint: 'sendPhoto', field: 'photo' });
    expect(telegramUploadTarget('clip.mp4')).toEqual({ endpoint: 'sendVideo', field: 'video' });
    expect(telegramUploadTarget('song.mp3')).toEqual({ endpoint: 'sendAudio', field: 'audio' });
    expect(telegramUploadTarget('voice.ogg')).toEqual({ endpoint: 'sendAudio', field: 'audio' });
    expect(telegramUploadTarget('report.pdf')).toEqual({ endpoint: 'sendDocument', field: 'document' });
  });

  it('uploads images with chat id, file, caption, and markdown parse mode', async () => {
    const fetchMock = vi.mocked(fetch);

    const result = await sendTelegramOutboundFiles({
      token: 'TOKEN',
      platformId: 'telegram:123',
      files: [file('photo.jpg')],
      caption: '*caption*',
    });

    expect(result).toBe('100');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.telegram.org/botTOKEN/sendPhoto');
    const form = formAt(fetchMock, 0);
    expect(form.get('chat_id')).toBe('123');
    expect(form.get('caption')).toBe('*caption*');
    expect(form.get('parse_mode')).toBe('Markdown');
    expect((form.get('photo') as { name?: string }).name).toBe('photo.jpg');
  });

  it('adds a caption only to the first file', async () => {
    const fetchMock = vi.mocked(fetch);

    await sendTelegramOutboundFiles({
      token: 'TOKEN',
      platformId: 'telegram:123',
      files: [file('one.pdf'), file('two.pdf')],
      caption: 'first file caption',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(formAt(fetchMock, 0).get('caption')).toBe('first file caption');
    expect(formAt(fetchMock, 1).get('caption')).toBeNull();
    expect(formAt(fetchMock, 1).get('parse_mode')).toBeNull();
  });

  it('retries markdown caption parse failures without parse_mode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(telegramError("Bad Request: can't parse entities"))
      .mockResolvedValueOnce(telegramResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendTelegramOutboundFiles({
      token: 'TOKEN',
      platformId: 'telegram:123',
      files: [file('one.pdf')],
      caption: '*unbalanced',
    });

    expect(result).toBe('200');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(formAt(fetchMock, 0).get('parse_mode')).toBe('Markdown');
    expect(formAt(fetchMock, 1).get('parse_mode')).toBeNull();
  });

  it('throws on non-OK upload responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => telegramError('Internal Server Error', 500)),
    );

    await expect(
      sendTelegramOutboundFiles({
        token: 'TOKEN',
        platformId: 'telegram:123',
        files: [file('one.pdf')],
      }),
    ).rejects.toThrow('Telegram sendDocument failed (500)');
  });
});

describe('deliverTelegramOutbound', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => telegramResponse(300)),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bridge(result: string | undefined = 'bridge-message-id') {
    return {
      deliver: vi.fn<ChannelAdapter['deliver']>(async (_platformId, _threadId, _message) => result),
    };
  }

  it('delegates text-only delivery to the bridge', async () => {
    const b = bridge();
    const message: OutboundMessage = { kind: 'chat', content: { text: 'hello' } };

    const result = await deliverTelegramOutbound({
      bridge: b,
      token: 'TOKEN',
      platformId: 'telegram:123',
      threadId: null,
      message,
      sanitizeCaption: sanitizeTelegramLegacyMarkdown,
    });

    expect(result).toBe('bridge-message-id');
    expect(b.deliver).toHaveBeenCalledWith('telegram:123', null, message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uploads file-only messages without bridge delivery', async () => {
    const b = bridge();

    const result = await deliverTelegramOutbound({
      bridge: b,
      token: 'TOKEN',
      platformId: 'telegram:123',
      threadId: null,
      message: { kind: 'chat', content: { files: ['report.pdf'] }, files: [file('report.pdf')] },
      sanitizeCaption: sanitizeTelegramLegacyMarkdown,
    });

    expect(result).toBe('300');
    expect(b.deliver).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses short text as the first file caption after Telegram markdown sanitization', async () => {
    const b = bridge();

    await deliverTelegramOutbound({
      bridge: b,
      token: 'TOKEN',
      platformId: 'telegram:123',
      threadId: null,
      message: {
        kind: 'chat',
        content: { text: '**Host path**', files: ['report.pdf'] },
        files: [file('report.pdf')],
      },
      sanitizeCaption: sanitizeTelegramLegacyMarkdown,
    });

    expect(b.deliver).not.toHaveBeenCalled();
    expect(formAt(vi.mocked(fetch), 0).get('caption')).toBe('*Host path*');
  });

  it('sends long text through the bridge before uploading captionless files', async () => {
    const b = bridge('text-message-id');
    const longText = 'x'.repeat(1025);

    const result = await deliverTelegramOutbound({
      bridge: b,
      token: 'TOKEN',
      platformId: 'telegram:123',
      threadId: null,
      message: {
        kind: 'chat',
        content: { text: longText, files: ['report.pdf'] },
        files: [file('report.pdf')],
      },
      sanitizeCaption: sanitizeTelegramLegacyMarkdown,
    });

    expect(result).toBe('text-message-id');
    expect(b.deliver).toHaveBeenCalledTimes(1);
    expect(b.deliver.mock.calls[0]![2].files).toBeUndefined();
    expect(formAt(vi.mocked(fetch), 0).get('caption')).toBeNull();
  });

  it('delegates edits, reactions, and question cards to the bridge even if files are present', async () => {
    const b = bridge();
    const message: OutboundMessage = {
      kind: 'chat',
      content: { operation: 'edit', messageId: 'm1', text: 'edit', files: ['report.pdf'] },
      files: [file('report.pdf')],
    };

    await deliverTelegramOutbound({
      bridge: b,
      token: 'TOKEN',
      platformId: 'telegram:123',
      threadId: null,
      message,
      sanitizeCaption: sanitizeTelegramLegacyMarkdown,
    });

    expect(b.deliver).toHaveBeenCalledWith('telegram:123', null, message);
    expect(fetch).not.toHaveBeenCalled();
  });
});
