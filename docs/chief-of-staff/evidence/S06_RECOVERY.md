# S06 deployment recovery correction — ready for review

The owner merged [PR #60](https://github.com/ufJmacca/nanoclaw/pull/60) as
`074befc0f421290855ca5878ce6a918b2fe9aa33`. Its exact merged-source release
passed all seven local gates, but the Pi health gate failed and automatically
restored the compatible schema-13 S06 candidate. The ordinary service remained
running, with CoS admission closed. The failed receipt, protected backups, exact
images, payload and pinned source were retained. No old SQLite was restored.

The original helper discarded the health error, so its cause remains unknown.
Subsequent read-only schema/profile/image checks and an isolated native smoke
against the same image passed. Those later checks do not make the failed release
accepted.

[PR #61](https://github.com/ufJmacca/nanoclaw/pull/61) records the failed health
gate and a fixed, sanitised classification before rollback. Process readiness
uses the existing bounded startup helper and rejects unrelated process failures.
It also fixes a separate regression: S06 incorrectly refused permanent specialist
state. S01–S04 and legacy releases still refuse that state without deleting it.

The regression was red before the fix. All 49 focused tests passed, followed by
2,252 root tests, 196 runner tests, all 235 S01–S06 source fixtures, the three S06
demonstrations, both final ARM64 isolation profiles, 196 baked runner tests per
profile and the complete 235-result suite against each final host/worker pair.
Typechecks, build, lint and formatting completed with zero errors. The actual
final host image additionally preserved all four specialist-state tables and
refused older code using in-memory fixtures. External database integration tests
used the separate admitted test profile with verified TLS.

The tested source is `e2518aacc6c174313a41b215ea26fb7c9c3f8293`, tree `381fcc6fa83e0c9553b9d50d262ab06137fdd405`.
Release `release-e2518aacc6c1-20261002232525` was built on the Mac, pushed to the bound fork,
fetched into a clean pinned Pi source worktree and deployed from the exact tested
artifacts. Its acceptance status is **tested, unreviewed recovery candidate**.

| Role | Immutable image ID |
| --- | --- |
| Host | `sha256:9ced41c760e2a45c276420e18586e703f5fba32048733085e578335376a24766` |
| Standard worker | `sha256:338e468402a93caa70673cec50003e5a945c5e591b09a6312ca29247515cf7e3` |
| Document worker | `sha256:332b6a0c487c884802d300d8cc66308bdb41d3c086ad901485764b3e3cb756c4` |

Host payload SHA-256: `1801573e8afb750437aab675ebdeb5e11d2b90a1452a4b87406ea9b23580bbf3`.
Manifest SHA-256: `85c4ef421aff6bfecb32543fbae5016de1fbbfe09fce57751656a002c4d03ede`.
Archive SHA-256: `8a9986fb3818eae43d2d932d26113903334adc863b50a165f9dc56fb3f9a403c`.
The manifest records actual configuration IDs and all thirteen migration checksums.

The Pi is healthy at PostgreSQL schema 13 and SQLite compatibility level 22,
verified by required migration names. Its new health receipt passed native
compatibility, process ownership, schema, profiles, image
identity and the isolated fixture. Both worker profiles passed the native
subscription/isolation checks, all 196 runner tests and six offline recovery
scenarios. A Pi-owned job repeated recovery, independent specialist contexts and
exact-child cancellation after scheduling SSH disconnect while the Mac development
container was stopped. NanoClaw remained active, and the Mac container was restored.
Physical Mac power-off was not tested. These probes used synthetic credentials,
model endpoints and messages.

All 694 protected original messages across 18 session databases, native identities,
three CoS records, proposals, main conversation and continuation were preserved.
The policy, ten charged attempts, ten replies, primary Codex login and service
environment remain unchanged. CoS is paused; maintenance is clear. Mission/team
admission is unconfigured, knowledge/calendar/public retrieval are disabled, and
the expired live allowance was not renewed. The existing main model context was
not silently reset or replaced by reply-thread contexts.

Capacity recovery retired only the completed failed-release transport archive and
three unused prebuilt payload caches incompatible with schema 13. Every archive
was independently rehashed and retained on the Mac first. Current and failed S06
images/payloads, all source, manifests, receipts, backups, runtime data and credentials
were retained. No blanket pruning occurred. Available capacity before transfer was
5386153984 bytes, above the measured and unchanged-helper
reserve of 5130628372 bytes. The exact Docker/containerd loader
versions were revalidated against the existing source-linked streaming analysis.

The prior S06 candidate `release-8a040c1213a4-20261002174959` still has its three
images, verified payload and clean pinned source. The actual earlier rollback is
recorded; no second rollback or native database restoration is claimed. Recovery
remains that compatible code pair or a tested roll-forward under closed admission.

One administrative recovery check initially confused SQLite's applied-order
counter with the release compatibility level. It rejected the check, without
changing live data. Verification was corrected to compare required migration
names; the failed log remains retained. No application source changed on the Pi.

Private references: `s06-health-recovery-acceptance.json`, the release's
local/source/delivery/deployment receipts, `s06-health-recovery-pi-health.json`,
`s06-health-recovery-pi-native-receipt.json`,
`s06-health-recovery-live-state-preservation.json`,
`s06-health-recovery-compatibility.json`, `s06-health-recovery-streaming-capacity.json`,
`s06-health-recovery-cache-retirement.json` and
`subscription-s06-independent-release-e2518aacc6c1-20261002232525.json`.

S07 remains ineligible until PR #61 receives a legitimate human merge and its exact
merged-source release passes the required local and Pi acceptance checks. The
programme remains incomplete and the Pi lifecycle is `implementation_disposable`.
Live team activation and retained main-tool-catalog compatibility remain subject
to the separately recorded owner authority and supported context-renewal contract.
