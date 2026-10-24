import { digest } from '../domain/contracts.js';
import type { DraftEffect, DraftEffectState } from './journal.js';

export type MailDraftAnswerNotice = {
  operationId: string;
  state: DraftEffectState;
  effectDigest: string;
  identityDigest: string;
  text: string;
};
/** Current policy/source checks belong to the caller. This projection never reads
 * or changes a provider draft, and never turns an uncertain/edited witness into success. */
export function mailDraftAnswerNotice(record: DraftEffect, identityDigest: string): MailDraftAnswerNotice {
  const descriptions: Record<DraftEffectState, string> = {
    reserved: 'The save outcome is uncertain; no verified saved content is available.',
    verified: 'A plain-text reply draft was saved in Gmail and verified as unsent',
    edited: 'The draft is recorded as edited; its original saved content is not verified',
    missing: 'The draft is recorded as missing; it has not been recreated',
    sent: 'The draft is recorded as sent; it has not been recreated',
    collision: 'A draft collision is recorded; no verified saved content is available',
  };
  const at = record.observedAt ?? record.reservedAt;
  if (!Number.isFinite(Date.parse(at))) throw Error('mail_draft_notice_unverified');
  return {
    operationId: record.operationId,
    state: record.state,
    effectDigest: digest(record),
    identityDigest,
    text: `${descriptions[record.state]} (observation: ${at}). Operation: ${record.operationId}. This is an as-of observation; later edits, deletion or sending are not covered. Review the draft in Gmail. This check does not send, change or recreate it.`,
  };
}
