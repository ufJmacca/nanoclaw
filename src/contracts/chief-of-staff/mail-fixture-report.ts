import { verifyExactFlatTap } from './flat-tap-report.js';
/** Exact flat TAP contracts; aggregate counts and successful exits alone are insufficient. */
export const MAIL_STORE_CASES = [
  'G04 host inventory pages all retention bindings without account or message content',
  'G04 mailbox overflow keeps bounded notices and retained context while checking undisplayed access',
  'G04 mailbox legacy context identity remains valid with 1 bindings',
  'G04 mailbox legacy context identity remains valid with 10 bindings',
  'G04 only one concurrent host claims a due poll; claims never fabricate a capture or success',
  'G04 mailbox schema is additive, constrained and included in coordinated checkpoints',
  'G04 binding replay preserves identity and refuses broader grants and foreign owners',
  'G04 publishes messages and their history cursor atomically, then reconciles the same capture once',
  'G04 failed reads and superseded captures cannot advance the saved cursor or replace newer state',
  'G04 losing the publish response reconciles the committed receipt without duplicate messages or cursor changes',
  'G04 capture publication refuses a wrong mailbox, modified content, changed binding and a later pause',
  'G04 reconstructs only the current capture and preserves the original selection identity across incremental publication',
  'G04 background maintenance applies independent revocation to real paused storage without inference or provider reads',
  'G04 global-off owner tightens real paused mail storage without a source connector or waiving protected history purge',
  'G04 reconstructing a background scheduler honors a prior database poll claim',
  'G04 publishes mail as cited untrusted evidence in the same committed capture and cursor',
  'G04 a capture rollback admits neither mail evidence nor its cursor and reconciles the same capture after restart',
  'G04 history and label changes preserve unchanged source revisions and exposed context',
  'G04 selection withdrawal closes evidence immediately and purges its local copies before a fresh selection is admitted',
  'G04 retention publishes a separate immutable checkpoint during a provider outage and preserves the provider sync time and cursor',
  'G04 trusted retention removes closed mail while paused without reopening source or global admission',
  'G04 trusted retention removes closed mail while revoked without reopening source or global admission',
  'G04 owner source denial removes raw copies and cannot be revived by a later capture',
  'G04 a fresh capture cannot move its observation window backwards after retention advanced it',
  'G04 repeated retention checks without content changes do not grow checkpoint history or replace provider freshness',
  'G04 cited mail answers carry host-rendered freshness without resetting their context on an ordinary poll',
  'G04 even an empty mailbox metadata view is fenced when its account authority is later withdrawn',
  'G04 mail exposed by a work-evidence path still adds host coverage to its answer',
  'G04 mailbox coverage explicitly reports partial observations',
  'G04 mailbox coverage explicitly reports stale observations',
  'G04 mailbox coverage explicitly reports failed observations',
  'G04 mailbox coverage explicitly reports retention observations',
  'G04 account loss between answer preparation and commit cannot publish a stale mail answer',
  'G04 a refresh starting during answer publication cannot commit the previous freshness observation',
  'G04 host refresh publishes through the real store and a reconstructed mail journal preserves provider revocation',
  'G04 host refresh reconciles the exact committed capture after losing publication acknowledgement',
  'G04 host access-loss updates are monotonic, close exposed evidence and remain available while paused',
  'G04 typed mail search ranks only the selected binding and thread reads carry captured message references',
  'G04 mail evidence is closed by default and by a Calendar-only grant, and opens only under its own host authority',
  'G04 the rolling wall-clock retention boundary closes cached evidence and its existing context during a provider outage',
  'G04 mail disclosure rejects changed account authority',
  'G04 mail disclosure rejects changed selection authority',
  'G04 mail disclosure rejects changed message authority',
  'G04 mail disclosure rejects changed auth authority',
  'G04 mail disclosure rejects changed capture authority',
  'G04 mail disclosure rejects changed late-host-denial authority',
] as const;
export const MAIL_CHECKPOINT_CASES = [
  'G04 schema-18 synthetic checkpoint restores insert-only into the actual current test database',
  'G04 schema-19 synthetic checkpoint restores insert-only into the actual current test database',
] as const;
export const MAIL_NATIVE_CASES = [
  'G04 native mail conversation cites only selected messages, preserves context across restart and closes withdrawn evidence',
] as const;
export type MailFixtureSuite = 'database' | 'native' | 'all' | 'checkpoint';
/** Report coverage only. Immutable source/image bindings, selected database,
 * kernel credentials and installed/live acceptance remain separate gates. */
export function verifyMailFixtureReport(
  text: string,
  suite: MailFixtureSuite,
): { suite: MailFixtureSuite; actualCases: number } {
  try {
    if (!['database', 'native', 'all', 'checkpoint'].includes(suite)) throw Error('suite');
    const required: readonly string[] =
      suite === 'checkpoint'
        ? MAIL_CHECKPOINT_CASES
        : suite === 'native'
          ? MAIL_NATIVE_CASES
          : [...MAIL_STORE_CASES, ...MAIL_CHECKPOINT_CASES, ...(suite === 'all' ? MAIL_NATIVE_CASES : [])];
    return { suite, ...verifyExactFlatTap(text, required) };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private database and fixture diagnostics do not leave this fixed gate error.
    throw Error('mail_fixture_report_unverified');
  }
}
