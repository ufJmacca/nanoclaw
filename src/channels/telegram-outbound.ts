import path from 'path';

import type { ChannelAdapter, OutboundFile, OutboundMessage } from './adapter.js';

export const TELEGRAM_CAPTION_LIMIT = 1024;

type TelegramMediaField = 'photo' | 'video' | 'audio' | 'document';

interface TelegramUploadTarget {
  endpoint: 'sendPhoto' | 'sendVideo' | 'sendAudio' | 'sendDocument';
  field: TelegramMediaField;
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: {
    message_id?: number | string;
  };
}

export interface TelegramFileUpload {
  token: string;
  platformId: string;
  file: OutboundFile;
  caption?: string;
  parseMode?: 'Markdown';
}

export interface TelegramFilesDelivery {
  token: string;
  platformId: string;
  files: OutboundFile[];
  caption?: string;
}

export interface TelegramOutboundDelivery {
  bridge: Pick<ChannelAdapter, 'deliver'>;
  token: string;
  platformId: string;
  threadId: string | null;
  message: OutboundMessage;
  sanitizeCaption: (text: string) => string;
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.aac', '.opus']);

export function telegramChatIdFromPlatformId(platformId: string): string {
  return platformId.startsWith('telegram:') ? platformId.slice('telegram:'.length) : platformId;
}

export function telegramUploadTarget(filename: string): TelegramUploadTarget {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return { endpoint: 'sendPhoto', field: 'photo' };
  if (VIDEO_EXTENSIONS.has(ext)) return { endpoint: 'sendVideo', field: 'video' };
  if (AUDIO_EXTENSIONS.has(ext)) return { endpoint: 'sendAudio', field: 'audio' };
  return { endpoint: 'sendDocument', field: 'document' };
}

function shouldRetryWithoutMarkdown(status: number, response: TelegramApiResponse): boolean {
  const description = response.description ?? '';
  return status >= 400 && /(parse|entities|markdown)/i.test(description);
}

async function postTelegramFile({
  token,
  platformId,
  file,
  caption,
  parseMode,
}: TelegramFileUpload): Promise<string | undefined> {
  const target = telegramUploadTarget(file.filename);
  const form = new FormData();
  form.append('chat_id', telegramChatIdFromPlatformId(platformId));
  form.append(target.field, new Blob([file.data]), file.filename);
  if (caption) {
    form.append('caption', caption);
    if (parseMode) form.append('parse_mode', parseMode);
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/${target.endpoint}`, {
    method: 'POST',
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as TelegramApiResponse;

  if (!res.ok || !data.ok) {
    if (parseMode && shouldRetryWithoutMarkdown(res.status, data)) {
      return postTelegramFile({ token, platformId, file, caption });
    }
    throw new Error(`Telegram ${target.endpoint} failed (${res.status}): ${data.description ?? res.statusText}`);
  }

  const messageId = data.result?.message_id;
  return messageId == null ? undefined : String(messageId);
}

export async function sendTelegramOutboundFiles({
  token,
  platformId,
  files,
  caption,
}: TelegramFilesDelivery): Promise<string | undefined> {
  let firstMessageId: string | undefined;
  for (let i = 0; i < files.length; i++) {
    const messageId = await postTelegramFile({
      token,
      platformId,
      file: files[i]!,
      caption: i === 0 ? caption : undefined,
      parseMode: i === 0 && caption ? 'Markdown' : undefined,
    });
    firstMessageId ??= messageId;
  }
  return firstMessageId;
}

export async function deliverTelegramOutbound({
  bridge,
  token,
  platformId,
  threadId,
  message,
  sanitizeCaption,
}: TelegramOutboundDelivery): Promise<string | undefined> {
  const content = message.content as Record<string, unknown>;
  if (content.operation || content.type === 'ask_question' || !message.files || message.files.length === 0) {
    return bridge.deliver(platformId, threadId, message);
  }

  const rawText = (content.markdown as string | undefined) || (content.text as string | undefined) || '';
  const caption = rawText ? sanitizeCaption(rawText) : '';

  let textMessageId: string | undefined;
  const fileCaption = caption.length > 0 && caption.length <= TELEGRAM_CAPTION_LIMIT ? caption : undefined;
  if (caption.length > TELEGRAM_CAPTION_LIMIT) {
    textMessageId = await bridge.deliver(platformId, threadId, { ...message, files: undefined });
  }

  const fileMessageId = await sendTelegramOutboundFiles({
    token,
    platformId,
    files: message.files,
    caption: fileCaption,
  });

  return textMessageId ?? fileMessageId;
}
