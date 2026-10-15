import { mailEvidenceText } from './evidence.js';
import { extractChunks } from '../knowledge/text.js';
import type { MailMessage } from './normalization.js';
/** Reserve 16 MiB of the coordinated 64 MiB row export for the existing domain,
 * state and compact receipts. Budget encoded mail, not just decoded body bytes. */
export const MAIL_CHECKPOINT_BYTES = 48 * 1024 ** 2;
export function mailCheckpointBytes(message: MailMessage, mailboxEmail: string): number {
  const text = mailEvidenceText(
      { id: 'a'.repeat(36), mailbox_email: mailboxEmail, processing_providers: ['codex', 'claude'] },
      { message, selection_id: 'b'.repeat(36) },
    ),
    chunks = extractChunks(text);
  // Fixed row/provenance/identity allowance covers mail, source, revision,
  // artifact and tiny selection-anchor rows; chunks also include scoped IDs.
  return (
    Buffer.byteLength(JSON.stringify(message)) + Buffer.byteLength(JSON.stringify(chunks)) + 8192 + chunks.length * 512
  );
}
