import type { MailWindow } from '../mail/normalization.js';
import type { ReplySource } from './reply.js';
export type FreshReplySource = {
  source: ReplySource;
  internalDate: number;
  observedAt: number;
  historyId: string;
  hasDraft: boolean;
  alreadyAnswered: boolean;
};
/** Fixed read-only metadata operation; unrelated thread bodies never enter draft collision checks. */
export interface MailReplySourceReader {
  replySource(id: string, window: MailWindow): Promise<FreshReplySource>;
}
