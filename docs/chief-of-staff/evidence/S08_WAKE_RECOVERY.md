# S08 review correction — follow-up validation in progress

PR [#64](https://github.com/ufJmacca/nanoclaw/pull/64) was merged by the repository
owner on 5 October 2026. Its actual merged source is
`c52dd08a9ec963e969ec987d470a4452dcee3c27`, with the same tree as its reviewed
head. A [P1 review finding](https://github.com/ufJmacca/nanoclaw/pull/64#discussion_r4179592987)
requires a correction before S08 merged-release acceptance and S09.

When an active mandate temporarily loses eligibility, the host retires its
native wake. Previously, restoring eligibility with the same revision and wake
time could not stage that clock again. The retained completed row and ownership
marker prevented recovery, including after a host restart.

The initial correction restored an exactly verified completed host clock to `paused`
inside the existing SQLite transaction. It preserves the task identity, content,
source-evaluation digest and ownership marker. It creates no pending model
message. The pump must still obtain a fresh PostgreSQL grant before evaluation;
clock repair cannot authorize a mission or revive an obsolete mandate revision.
Altered rows and foreign bindings remain rejected. No migration is added or
modified.

## Follow-up review correction — 5 October 2026

PR #65's [P2 review finding](https://github.com/ufJmacca/nanoclaw/pull/65#discussion_r4179883188)
identified repeated recovery of already-evaluated due clocks. Four new regression
tests failed against the unchanged deployed production code; nine existing tests
passed. Eight repeated drains caused nine evaluations instead of one.

The follow-up records a verified retirement reason in additive host-only SQLite
metadata, within the same transaction as retirement. Only a clock retired for
temporary ineligibility can reopen. Evaluated, superseded and legacy completed
clocks with unknown reasons remain closed; a later eligibility loss cannot make
them recoverable. The original native row, evaluation history and binding checks
remain intact. Fresh PostgreSQL authority is still required before evaluation.
The pump stages a usable clock before retiring other clocks, preserving a future
clock when inventory repeats an already-completed wake.

All 13 targeted native/pump tests pass, including repeated drains and restart,
preserved future clocks and their eventual evaluation, transient recovery,
fresh-grant denial and zero due model messages. No PostgreSQL or registered
NanoClaw migration is added or edited; SQLite compatibility remains 22.

PR #65 has returned to draft. Full release/image gates and exact-artifact Pi
delivery/native/preservation/independence verification must pass for this new
source before it is ready again. The deployed candidate below remains historical
evidence; it does not prove the follow-up passed. CoS stays paused, and no live
model call or real message was made.

## Red → green evidence

The repository development container ran the two mandate native/pump test files
against unchanged merged production code. Three tests failed and six passed:
re-staging a retired clock after restart, resuming the same wake after temporary
ineligibility, and obtaining a new grant on recovery. The private red log is
retained.

After the correction, all nine tests passed. They verify retained identity and
evaluation history, quiet future clocks, overdue evaluation, fresh grant denial,
rejection of altered/foreign rows, no duplicate native row, no due model message,
and the existing emergency-pause behavior.

## Verified candidate — 5 October 2026

All seven mandatory local gates passed on the Mac using the repository
development container and separate protected external test target with
authenticated, verified TLS. Root checks passed 2,312 tests in 232 files, with
typecheck, build, formatting and lint passing (342 existing warnings, zero
errors). Both runner checks passed, including 206 tests in 27 files. Source
contracts passed 268 tests without failures or skips; the complete native
owner-approval/preparation/review/digest demonstration passed.

All three final Linux/ARM64 images were built and tested without checkout code
overrides. Each packaged host/profile combination passed all 268 contracts.
Both workers passed their 206 runner tests, seven baked native/RPC cases and
seven pinned subscription scenarios. Provider startup, host SQLite and document
libraries passed. The additional compiled-clock probe failed on the old
immutable image, then passed on this exact new image with networking disabled.

- Release: `release-d8f91982647b-20261004230039`, a tested **unreviewed correction candidate**.
- Source: `d8f91982647b0bb514bc4866b62fc3e0e7196244`.
- Tree: `3e679f2696e33f4fb7fd6206e981024c94f008b1`.
- Source ref: `refs/heads/codex/s08-retired-wake-recovery`.
- Manifest SHA-256: `65568b5fee2ea25a58a300725349c8c5ccdacdcb571921a67b0b577bfb255372`.
- Archive SHA-256: `14a6cb9c10398af1450f407946e0cb5e5607eed385e690d65501e812a289e72d`;
  1,148,686,367 bytes.
- Host payload SHA-256: `b4f7de35cb670bbfd6f5ec3198670a7f1ec15ee7b3afdee69c42092a7f0e1ff2`.
- PostgreSQL schema: 15; no migration was added or modified. Migration 15 remains
  `afda148ed0b6efc324f91390d2e715e982072b9a0e571e28bb531ccd7bcc6517`.
- Native SQLite compatibility: 22; all 20 required named migrations verified,
  with applied-order maximum 20.

| Artifact        | Tested image identity                                                     | Configuration digest                                                      |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Host            | `sha256:77f398d43e483e040534ecb62a9ca4744dc3bdadcb572b99d491e1938f1e6abe` | `sha256:7d56b49432ae5ba7980bef12230b05f9aac1e065c0be6d1aac23ec6091493918` |
| Standard worker | `sha256:1fdf20b903166eabcd61fd692fc7f85e62a39f9cd94e78ae6f0865c727ba0e7b` | `sha256:40d592f276c194e451810e0c84d5c2d9afbdef7eb02175a8201603e8c3b08866` |
| Document worker | `sha256:a6d6c7d222a00e86c84cf5d126f31b1142b02d5d4893bf7f5203a3a40e5f9b10` | `sha256:76bdef9bac3eed16b0a1bcc20f9aa0e46958827c539cfb0d65a1648daffc43b0` |

The Pi fetched the exact GitHub commit/tree into a clean detached source
worktree, verified the matching archive and loaded identities, extracted the
prebuilt payload and passed all seven deployment phases. All six health stages
passed. No Pi source build, dependency installation or source repair occurred.

## Capacity, native verification and preservation

The unchanged capacity guard required additional staging room. Four retained
Mac archives were stream-verified before scoped retirement. Only the generated
payload caches for these obsolete, unreviewed, schema-incompatible releases
were retired:

- `release-074befc0f421-20261002221654`.
- `release-8a040c1213a4-20261002174959`.
- `release-e2518aacc6c1-20261002232525`.

The identical Pi transport archive for the preceding S08 release was also
retired. All images, containers, volumes, pinned source worktrees, manifests,
deployment/acceptance receipts, protected backups, data, sessions and credentials
were retained. Current and retained recovery payload digests were verified
before and after. No service mutation occurred during retirement. Free space
rose from 3,304,591,360 to 5,326,581,760 bytes; the 5,131,616,380-byte requirement
before transfer passed. The bundle guard was not weakened or bypassed.

Both actual Pi profiles passed their seven baked native/RPC cases, 206 runner
tests and all seven subscription scenarios: restart, compaction, shutdown,
membership loss, RPC cancellation, tool refresh and retained-thread mandate
refresh. The compiled-clock recovery probe passed on the actual Pi against the
immutable packaged host. It verified the same clock and evaluation history after
restart, quiet future wakes, overdue evaluation, fresh-grant denial, pause,
altered/foreign rejection, ordinary canary preservation, no duplicate rows and
zero due model messages. Specialist canary isolation and exact child stop
preserved the sibling; main context and instruction history remained retained.

All 694 original messages and all 696 messages in the fresh backup were verified
across 18 session databases, with none missing or changed. Three approved
records, complete proposal rows, main conversation/continuation, prior replies,
model policy and ten charged attempts were unchanged. Primary Codex login and
service-environment seals matched the fresh before-deployment snapshots.

The Pi-owned independence probe passed from 23:57:41 to 23:59:47 UTC on 4 October
2026 (5 October locally), after the scheduling SSH session disconnected and while
the Mac development container was stopped. Both exact worker images passed all
seven subscription scenarios, specialist context isolation and exact child stop
with the sibling preserved. The Pi service remained active. The development
container was restored afterward. Physical Mac power-off is not tested.

## Recovery and remaining gates

The preceding S08 release `release-f6e7f02f6dc4-20261004145515` is a verified,
manifest-admitted schema-15 recovery predecessor: all three images, its exact
payload and clean pinned source remain retained. Its known retired-clock
availability issue remains documented; keep automation paused during recovery.
The exact current correction and Mac archive are also retained. S07's schema-14
artifacts remain retained but are ineligible for rollback at schema 15. No actual
code rollback was performed. Never restore old live SQLite or reset the schema.
Immutable mandate privileges passed, and all eight mandate table counts in the
live scope remain zero.

The correction [PR #65](https://github.com/ufJmacca/nanoclaw/pull/65) needs its own
reviewed merge because PR #64 is already merged.
After that merge, build/test and deploy the actual final merged source before
starting S09. S08 live activation remains separately pending: CoS stays paused,
no mandate is active, and this correction makes no live model call or real
message. The programme is incomplete.
