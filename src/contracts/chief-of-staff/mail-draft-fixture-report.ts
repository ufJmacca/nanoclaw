import { verifyExactFlatTap } from './flat-tap-report.js';
export const MAIL_DRAFT_DATABASE_CASES = [
  'G05 actual owner policy transaction installs one immutable revision and reconciles identical metadata',
  'G05 actual owner policy rollback preserves a failed final authority check without creating policy rows',
  'G05 actual owner policy refuses a changed reader and never enables another scope',
  'G05 runtime policy reads do not require or grant policy mutation rights',
  'G05 real writer discovery exposes only current owner-bound identifiers without provider work',
  'G05 real PostgreSQL policies and published read-only source admit one verified draft; retries recheck edits',
  'G05 concurrent retries and an older PostgreSQL request snapshot cannot erase the independent effect reservation',
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
export type MailDraftFixtureSuite = 'database' | 'native' | 'all';
/** Source/image/kernel/account identities remain separately mandatory. */
export function verifyMailDraftFixtureReport(
  text: string,
  suite: MailDraftFixtureSuite,
): { suite: MailDraftFixtureSuite; actualCases: number } {
  try {
    if (!['database', 'native', 'all'].includes(suite)) throw Error('suite');
    const required =
      suite === 'database'
        ? MAIL_DRAFT_DATABASE_CASES
        : suite === 'native'
          ? MAIL_DRAFT_NATIVE_CASES
          : [...MAIL_DRAFT_DATABASE_CASES, ...MAIL_DRAFT_NATIVE_CASES];
    return { suite, ...verifyExactFlatTap(text, required) };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Raw private fixture diagnostics cannot become release authority.
    throw Error('mail_draft_fixture_report_unverified');
  }
}
