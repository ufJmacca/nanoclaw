export const BACKUP_REPOSITORY_CASES = [
  ...['intent', 'ack'].flatMap((phase) =>
    ['empty', 'partial', 'before_rename', 'after_rename'].map(
      (stage) => `real repository recovery after SIGKILL at ${phase}:${stage}`,
    ),
  ),
  'the final ARM64 host carries the exact official backup executable and immutable seal',
  'compiled recovery rejects connection aliases as evidence of database separation and accepts only fixed owner selections',
  'official pinned ARM64 binary initializes repository v2 and binds its decrypted identity',
  'the verified executable stays pinned across awaited work and its lease expires afterward',
  'a changed executable path is refused before any credential command',
  'an awaited private command failure closes the verified descriptor and exposes a fixed error',
  'real stdin backup encrypts content and metadata and restores only into an isolated fixture',
  'an interrupted stdin upload leaves a checkable repository and no claimed checkpoint',
  'a real command producer streams a verified PAX checkpoint through Restic and restores it in isolation',
  'Restic rejects a command producer failure without recording an empty or partial checkpoint',
  'guarded transfer authenticates read-back and reconciles the same operation without uploading twice',
  'wrong repository identity and exhausted capacity refuse transfer before a new upload',
  'fresh verification reads the exact existing encrypted archive without producer or upload admission',
  'fresh verification refuses an absent operation without manufacturing a new checkpoint',
  'fresh verification refuses wrong archive hashes and lengths while leaving its queued source intact',
  'fresh verification still checks the current repository identity before any archive readback',
  'a completed writer or binary lifetime cannot be replayed as fresh verification authority',
  'fresh verification binds the original receipt to the authenticated archive before recovering cleanup',
  'real remote restoration streams directly into new private files and retires only its verified isolated workspace',
  'real remote recovery shares measured staging and the actual checkpoint writer while preserving pending state',
  'real encrypted remote recovery validates the complete captured payload without importing live authority',
  'real restoration denies a foreign receipt owner and missing checkpoint without destination files or remote changes',
  'real restoration refuses capacity withdrawn after its awaited repository identity without a completed destination',
  'real restoration handles long PAX paths and empty files through bounded streaming sinks',
  'real authenticated Restic data with noncanonical application framing is refused before file extraction',
  'real streaming restoration stops on scope withdrawal and holds only its new private residue',
  'real restore cleanup holds edited private content despite unchanged timestamp observations',
  'a mismatched remote archive cannot be acknowledged as a verified checkpoint',
  'guarded transfer refuses a failed command producer and retains the queued source',
  'a stalled producer is terminated within the transfer deadline without leaving a live child or snapshot',
  'withdrawn live permission terminates a quiet real producer without waiting for its upload deadline',
  'real maintenance keeps 14 daily and four weekly checkpoints per kind without touching unrelated snapshots',
  'real maintenance replay verifies unchanged retained snapshots without another deletion',
  'capacity withdrawal and wrong repository identity refuse real retention with all snapshot IDs intact',
  'full data integrity failure refuses real maintenance before forgetting snapshots or pruning data',
  'real remote receipt verification recovers interrupted queue retirement and preserves a newer snapshot on replay',
  'real restoration still recovers the original checkpoint after its queued plaintext source has been retired',
] as const;
/** A success exit and aggregate count alone cannot supply the three repository
 * gates. Require every actual compiled case, no skips and the complete TAP plan.
 */
export function verifyBackupRepositoryReport(text: string): { actualRepositoryCases: 45 } {
  try {
    if (
      typeof text !== 'string' ||
      Buffer.byteLength(text) > 512 * 1024 ||
      /^(?:not ok\b|Bail out!)/m.test(text) ||
      /^(?:ok|not ok) \d+.*#\s*(?:SKIP|TODO)\b/im.test(text)
    )
      throw Error('report');
    const lines = text.split(/\r?\n/),
      cases = lines.filter((line) => /^ok \d+ - /.test(line));
    if (cases.length !== 45 || BACKUP_REPOSITORY_CASES.length !== 45 || new Set(BACKUP_REPOSITORY_CASES).size !== 45)
      throw Error('coverage');
    const ids = new Set<number>(),
      names = new Set<string>();
    for (const line of cases) {
      const match = /^ok ([1-9][0-9]*) - (.+)$/.exec(line)!;
      const id = Number(match[1]);
      if (id > 45 || ids.has(id) || names.has(match[2]) || !BACKUP_REPOSITORY_CASES.includes(match[2]))
        throw Error('case');
      ids.add(id);
      names.add(match[2]);
    }
    for (const [pattern, expected] of [
      [/^TAP version .*$/, 'TAP version 13'],
      [/^[0-9]+\.\.[0-9]+$/, '1..45'],
      [/^# tests .*$/, '# tests 45'],
      [/^# suites .*$/, '# suites 0'],
      [/^# pass .*$/, '# pass 45'],
      [/^# fail .*$/, '# fail 0'],
      [/^# cancelled .*$/, '# cancelled 0'],
      [/^# skipped .*$/, '# skipped 0'],
      [/^# todo .*$/, '# todo 0'],
    ] as const) {
      const found = lines.filter((line) => pattern.test(line));
      if (found.length !== 1 || found[0] !== expected) throw Error('summary');
    }
    return { actualRepositoryCases: 45 };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Do not expose private fixture command diagnostics.
    throw Error('backup_repository_fixture_unverified');
  }
}
