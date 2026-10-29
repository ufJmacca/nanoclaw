import { verifyExactFlatTap } from './flat-tap-report.js';

export const MAIL_REVIEW_NATIVE_CASES = [
  'G06 both Sydney reviews use native routing, retained context, bounded drafts and checked private briefings',
] as const;

/** Exact post-order node:test results, including every nested SQL denial and its enclosing cases. */
export const MAIL_REVIEW_SCHEMA_RESULTS = [
  [0, 1, 'G06 schema-21 synthetic checkpoint restores insert-only into the actual current test database'],
  [4, 1, 'keeps one generic schedule and two mail slots'],
  [4, 2, 'refuses widened model budgets, altered times and policy bodies'],
  [4, 3, 'allows owner-administration provenance without forging a chat proposal'],
  [8, 1, 'revoked policy'],
  [8, 2, 'disabled writer'],
  [8, 3, 'revoked reader'],
  [8, 4, 'paused schedule'],
  [8, 5, 'expired deadline'],
  [8, 6, 'expired lease'],
  [8, 7, 'another native host'],
  [8, 8, 'terminal run'],
  [8, 9, 'widened model count'],
  [8, 10, 'widened tool count'],
  [8, 11, 'different policy digest'],
  [8, 12, 'missing selection'],
  [8, 13, 'eleventh candidate thread'],
  [8, 14, 'no longer current capture'],
  [8, 15, 'stale selection can disclose its limits but cannot create drafts'],
  [8, 16, 'a claimed run cannot create drafts before its first model reservation'],
  [8, 17, 'prepared brief publication retains selected reads while further draft saves stay closed'],
  [8, 18, 'selection preparation uses retained owner identity before installing a scheduled origin'],
  [8, 19, 'a formerly fresh selection cannot save a draft after its last sync becomes stale'],
  [8, 20, 'freezes one verified selection and cannot replace it or start selection after model use'],
  [8, 21, 'a different current capture cannot adopt frozen inputs even when its window is identical'],
  [4, 4, 'scheduled access requires the live owner policy, native lease and frozen selection'],
  [4, 5, 'the runtime can read but cannot grant or alter review authority'],
  [4, 6, 'three schedules share one active run and retain independent daily occurrence keys'],
  [4, 7, 'generic schedule discovery and proposals cannot read or change the mail-review schedules'],
  [4, 8, 'trusted review setup creates two bound schedules and replays without changing activation'],
  [
    4,
    9,
    'trusted consent rebind versions policy and schedules once without replaying cancelled runs or enabling a disabled owner pin',
  ],
  [0, 2, 'G06 migration preserves the generic schedule and admits only two owner-bound mail-review slots'],
] as const;

export function verifyMailReviewFixtureReport(text: string, suite: 'database' | 'native') {
  try {
    if (!['database', 'native'].includes(suite)) throw Error('suite');
    if (suite === 'native') return { suite, ...verifyExactFlatTap(text, MAIL_REVIEW_NATIVE_CASES) };
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 ** 2 || /^\s*(?:not ok\b|Bail out!)/im.test(text))
      throw Error('report');
    const lines = text.split(/\r?\n/),
      records = lines.filter((line) => /^\s*(?:ok|not ok)\b/.test(line)),
      plans = lines.filter((line) => /^\s*\d+\.\.\d+(?:\s|$)/.test(line));
    if (
      records.length !== MAIL_REVIEW_SCHEMA_RESULTS.length ||
      JSON.stringify(plans) !== JSON.stringify(['        1..21', '    1..9', '1..2'])
    )
      throw Error('coverage');
    for (const [index, [depth, id, name]] of MAIL_REVIEW_SCHEMA_RESULTS.entries())
      if (records[index] !== ' '.repeat(depth) + `ok ${id} - ${name}`) throw Error('case');
    for (const [pattern, expected] of [
      [/^TAP version .*$/, 'TAP version 13'],
      [/^# tests .*$/, '# tests 32'],
      [/^# suites .*$/, '# suites 0'],
      [/^# pass .*$/, '# pass 32'],
      [/^# fail .*$/, '# fail 0'],
      [/^# cancelled .*$/, '# cancelled 0'],
      [/^# skipped .*$/, '# skipped 0'],
      [/^# todo .*$/, '# todo 0'],
    ] as const) {
      const found = lines.filter((line) => pattern.test(line));
      if (found.length !== 1 || found[0] !== expected) throw Error('summary');
    }
    return { suite, actualCases: 32 };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private SQL/native fixture diagnostics never become release authority.
    throw Error('mail_review_fixture_report_unverified');
  }
}
