import { expect, it } from 'vitest';
import { mailEvidenceText, type MailSelection } from './evidence.js';
import { extractChunks } from '../knowledge/text.js';
const binding = { id: 'b', mailbox_email: 'owner@example.invalid', processing_providers: ['codex'] };
function selection(text: string): MailSelection {
  return {
    selection_id: 's',
    message: {
      id: 'aa01',
      threadId: 'bb01',
      historyId: '100',
      internalDate: Date.parse('2026-10-15T00:00:00Z'),
      labels: ['INBOX'],
      subject: 'Fixture',
      from: 'sender@example.invalid',
      to: 'owner@example.invalid',
      text,
      attachmentsExcluded: 0,
      trust: 'untrusted_mail_evidence',
      digest: 'fixture',
    },
  };
}
it('indexes adversarial mail headings within the bounded untrusted evidence section without losing Unicode', () => {
  const text = '# hostile heading\n'.repeat(1500) + '😀'.repeat(7000),
    rendered = mailEvidenceText(binding, selection(text)),
    chunks = extractChunks(rendered);
  expect(chunks.length).toBeLessThan(512);
  expect(chunks.every((chunk) => /Untrusted/.test(chunk.heading))).toBe(true);
  expect(rendered.match(/😀/gu)).toHaveLength(7000);
  expect(rendered.includes('\ufffd')).toBe(false);
  expect(rendered.split('\n').every((line) => line.length <= 1501)).toBe(true);
});
it('binds immutable evidence bytes to selection and mailbox while excluding polling-only metadata', () => {
  const a = selection('Retained body'),
    first = mailEvidenceText(binding, a);
  a.message.historyId = '200';
  a.message.labels = ['SENT'];
  expect(mailEvidenceText(binding, a)).toBe(first);
  a.selection_id = 'new-selection';
  expect(mailEvidenceText(binding, a)).not.toBe(first);
  expect(mailEvidenceText({ ...binding, mailbox_email: 'other@example.invalid' }, selection('Retained body'))).not.toBe(
    first,
  );
});
