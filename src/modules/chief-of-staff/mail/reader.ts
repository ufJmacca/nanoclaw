import type { MailMessage, MailWindow, NormalizedMail } from './normalization.js';
export type MailAccess = {
  generation: string;
  mailboxEmail: string;
  scopes: string[];
  auth: 'ready' | 'expired' | 'revoked' | 'disconnected';
};
export type MailPage = {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken: string | null;
  resultSizeEstimate: number;
};
export type MailHistoryPage = {
  changedIds: string[];
  deletedIds: string[];
  historyId: string;
  nextPageToken: string | null;
};
export interface MailReader {
  profile(): Promise<{ mailboxEmail: string; historyId: string }>;
  list(window: MailWindow, pageToken?: string): Promise<MailPage>;
  message(id: string, window: MailWindow): Promise<NormalizedMail>;
  thread(id: string, window: MailWindow): Promise<{ messages: MailMessage[]; excluded: number; unsupported: number }>;
  history(startHistoryId: string, pageToken?: string): Promise<MailHistoryPage>;
}
export class MailReadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
