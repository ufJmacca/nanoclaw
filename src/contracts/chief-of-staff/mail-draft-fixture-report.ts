import { verifyExactFlatTap } from './flat-tap-report.js';
export const MAIL_DRAFT_DATABASE_CASES = [
  'G06 real Mail publication, frozen selection and independent unsent draft reach one checked fixture briefing without a duplicate save',
  'G06 an observed owner edit withholds the prepared draft confirmation and fixture delivery without recreating it',
  'G05 actual owner policy transaction installs one immutable revision and reconciles identical metadata',
  'G05 actual owner policy rollback preserves a failed final authority check without creating policy rows',
  'G05 actual owner policy refuses a changed reader and never enables another scope',
  'G05 runtime policy reads do not require or grant policy mutation rights',
  'G05 real writer discovery exposes only current owner-bound identifiers without provider work',
  'G05 real PostgreSQL policies and published read-only source admit one verified draft; retries recheck edits',
  'G05 concurrent retries and an older PostgreSQL request snapshot cannot erase the independent effect reservation',
  'G05 checked draft answers preserve the exact host receipt and stop publication after an observed edit',
  'G05 a draft changing during answer publication denies the staged success rather than publishing stale confirmation',
  'G05 real admission denies disabled_policy without any provider draft write',
  'G05 real admission denies foreign_owner without any provider draft write',
  'G05 real admission denies expired_source without any provider draft write',
  'G05 real admission denies withdrawn_source without any provider draft write',
  'G05 real admission denies processing_denied without any provider draft write',
  'G05 real admission denies reader_revoked without any provider draft write',
  'G05 real admission denies native_paused without any provider draft write',
] as const;
export const MAIL_DRAFT_NATIVE_CASES = [
  'G05 native reply drafts reconcile across restart, preserve the main context, and enforce the independent Sydney-day cap without model calls or sends',
] as const;
export const MAIL_DRAFT_CHECKPOINT_CASES = [
  'G05 schema-19 synthetic checkpoint restores insert-only into the actual current test database',
  'G05 schema-20 synthetic checkpoint restores insert-only into the actual current test database',
] as const;
export type MailDraftFixtureSuite = 'database' | 'native' | 'checkpoint' | 'all';
/** Source/image/kernel/account identities remain separately mandatory. */
export function verifyMailDraftFixtureReport(
  text: string,
  suite: MailDraftFixtureSuite,
): { suite: MailDraftFixtureSuite; actualCases: number } {
  try {
    if (!['database', 'native', 'checkpoint', 'all'].includes(suite)) throw Error('suite');
    const required =
      suite === 'database'
        ? MAIL_DRAFT_DATABASE_CASES
        : suite === 'native'
          ? MAIL_DRAFT_NATIVE_CASES
          : suite === 'checkpoint'
            ? MAIL_DRAFT_CHECKPOINT_CASES
            : [...MAIL_DRAFT_DATABASE_CASES, ...MAIL_DRAFT_NATIVE_CASES, ...MAIL_DRAFT_CHECKPOINT_CASES];
    return { suite, ...verifyExactFlatTap(text, required) };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Raw private fixture diagnostics cannot become release authority.
    throw Error('mail_draft_fixture_report_unverified');
  }
}
