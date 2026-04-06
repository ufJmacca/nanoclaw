import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
  getTriggerPattern,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

const TELEGRAM_FETCH_CONFIG = {
  agent: https.globalAgent,
  compress: true,
};

function buildUniqueAttachmentFilename(
  filename: string,
  messageId: string,
): string {
  const ext = path.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return `${base || 'file'}_${messageId}${ext}`;
}

function normalizeTelegramCommand(text: string, botUsername: string): string {
  return text.replace(
    new RegExp(`^(/[^@\\s]+)@${botUsername}(?=\\s|$)`, 'i'),
    '$1',
  );
}

async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private readonly opts: TelegramChannelOpts;
  private readonly botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl, TELEGRAM_FETCH_CONFIG as RequestInit);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: TELEGRAM_FETCH_CONFIG,
      },
    });

    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as { title?: string }).title || 'Unknown';

      ctx.reply(
        `Chat ID: tg:${chatId}\nName: ${chatName}\nType: ${chatType}`,
      );
    });

    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    const telegramBotCommands = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (telegramBotCommands.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      const botUsername = ctx.me.username.toLowerCase();
      let content = normalizeTelegramCommand(ctx.message.text, botUsername);
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as { title?: string }).title || chatJid;

      const entities = ctx.message.entities || [];
      const isBotMentioned = entities.some((entity) => {
        if (entity.type !== 'mention') {
          return false;
        }
        const mentionText = content
          .substring(entity.offset, entity.offset + entity.length)
          .toLowerCase();
        return mentionText === `@${botUsername}`;
      });

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      const group = this.opts.registeredGroups()[chatJid];
      const mentionTriggerPattern = group
        ? getTriggerPattern(group.trigger)
        : TRIGGER_PATTERN;
      const mentionPrefix = group?.trigger || `@${ASSISTANT_NAME}`;
      if (isBotMentioned && !mentionTriggerPattern.test(content)) {
        content = `${mentionPrefix} ${content}`;
      }

      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    const storeMedia = (
      ctx: {
        chat: { id: number | string; type: string; title?: string };
        from?: { id?: number | string; first_name?: string; username?: string };
        message: {
          date: number;
          message_id: number;
          message_thread_id?: number;
          caption?: string;
          photo?: Array<{ file_id: string }>;
          video?: { file_id?: string };
          voice?: { file_id?: string };
          audio?: { file_id?: string; file_name?: string };
          document?: { file_id?: string; file_name?: string };
          sticker?: { emoji?: string };
          reply_to_message?: {
            message_id?: number;
            text?: string;
            caption?: string;
            from?: {
              id?: number | string;
              first_name?: string;
              username?: string;
            };
          };
        };
      },
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const chatName =
        ctx.chat.type === 'private' ? senderName : ctx.chat.title || chatJid;
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const messageId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id?.toString();
      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const deliver = (
        content: string,
        deliveryOpts?: { id?: string; timestamp?: string },
      ) => {
        this.opts.onMessage(chatJid, {
          id: deliveryOpts?.id || messageId,
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp: deliveryOpts?.timestamp || timestamp,
          is_from_me: false,
          thread_id: threadId,
          reply_to_message_id: replyToMessageId,
          reply_to_message_content: replyToContent,
          reply_to_sender_name: replyToSenderName,
        });
      };

      deliver(`${placeholder}${caption}`);

      if (opts?.fileId) {
        const filename =
          opts.filename ||
          `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${messageId}`;

        // Persist a follow-up event after the download completes so the
        // attachment path reaches downstream processing without risking a
        // lost media message if the download lags behind newer inbound rows.
        void this.downloadFile(opts.fileId, group.folder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`, {
                id: `${messageId}:attachment`,
                timestamp: new Date().toISOString(),
              });
            }
          },
        );
      }
    };

    this.bot.on('message:photo', (ctx) => {
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const messageId = ctx.message.message_id.toString();
      const name = ctx.message.audio?.file_name
        ? buildUniqueAttachmentFilename(ctx.message.audio.file_name, messageId)
        : `audio_${messageId}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', (ctx) => {
      const messageId = ctx.message.message_id.toString();
      const displayName = ctx.message.document?.file_name || 'file';
      const name = ctx.message.document?.file_name
        ? buildUniqueAttachmentFilename(
            ctx.message.document.file_name,
            messageId,
          )
        : `file_${messageId}`;
      storeMedia(ctx, `[Document: ${displayName}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            "  Send /chatid to the bot to get a chat's registration ID\n",
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      const maxLength = 4096;
      if (text.length <= maxLength) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += maxLength) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + maxLength),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
