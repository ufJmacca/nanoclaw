# S08 — actual reviewed merge accepted; live activation pending

PR [#64](https://github.com/ufJmacca/nanoclaw/pull/64) and correction
PR [#65](https://github.com/ufJmacca/nanoclaw/pull/65) were merged by the repository
owner. PR #65 merged at `2026-10-05T01:45:20Z`; actual merge
`462daabef958b9ba1874168719737ad7b39ef8e8` has the same tree as reviewed head
`6442c998d36d90b3bf731c1538e8e2d294deed16`. Both clock findings are fixed; their
red → green evidence remains in [the correction history](S08_WAKE_RECOVERY.md).
A fresh build, all seven mandatory gates and exact Pi acceptance passed for the
actual merge. S09 fixture implementation is eligible. CoS remains paused, with
live account/model/mandate activation pending and no active mandate.

Plan revision 5 and `cos-postgres/external-env-v3` apply. Tests used the separate,
protected external `test` database with authenticated, verified TLS. Root checks
passed 2,316 tests in 232 files, typecheck, build, lint and formatting. Runner
checks passed 206 tests in 27 files and typechecking. The complete native
owner-approval/preparation/review/digest demonstration passed. Source contracts
passed 268 tests without failures or skips; each final Linux/ARM64 packaged
host/profile pair also passed all 268 contracts. Both workers passed runner,
native/RPC, subscription, isolation, provider and document-library checks.

One initial source run failed S01-PG02's maintenance-lease check when the bounded
database client reported unavailable after its cooldown. That failed run remains
recorded. The unchanged contract passed five isolated diagnostic runs, then the
complete unchanged source suite and both final packaged suites passed. No source
or assertion was changed to bypass the failure. Its transient cause is not
proven. No artifact was transferred while a mandatory gate was failing.

- Release: `release-462daabef958-20261005014814`.
- Source: `462daabef958b9ba1874168719737ad7b39ef8e8`.
- Tree: `72a63f8be9f6a8d2fd9be7480a288be3edcb8571`.
- Source ref: `refs/heads/codex/s08-merged-clock-recovery`.
- Manifest SHA-256: `b8eee8ff046cbee94605a9554d4110a38f1bb2e4b1f4af28e687552b94260dac`.
- Archive SHA-256: `1d31d378dfa4d39f8cc92440aff56c4837667c4d1447767f2a06661ab73f48c9`;
  1,148,687,663 bytes.
- Host payload SHA-256: `9a25402c215e4d919aef46ce4786cdb252ccad97dc9a564016e494471d072a36`.
- PostgreSQL schema: 15; migration 15 remains
  `afda148ed0b6efc324f91390d2e715e982072b9a0e571e28bb531ccd7bcc6517`.
- Native SQLite compatibility: 22; all 20 required named migrations and
  applied-order maximum 20 verified. No registered migration changed.

| Artifact        | Tested image identity                                                     | Configuration digest                                                      |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Host            | `sha256:b5430959c685d3c9455e11e0c214a866b4feedafe6014fd8711db3e7ea6f3ad0` | `sha256:432b7c1bba4907393a8af86b9e14012d75f4963ee803f203bce5c204fb682dfc` |
| Standard worker | `sha256:c7e6ff7d0313030dde2b6aba7a63b2c9637681640f842b56ec98c3241b5fd0a0` | `sha256:d75e3e6b0e2a070e9e33b2f9b93eff4e5e1a1b6d7efe94bedb4f34025460844c` |
| Document worker | `sha256:88cf3ff7df67112a5b4358861c955cf8b56c6c073a760902e6caf712c0814d58` | `sha256:bfb5dcc6f13f922e6c2e7dd0d9992d5d257e426af4fcd6043edf9973b8409e58` |

The Pi fetched the exact clean detached GitHub source, verified the archive and
images, and activated the prebuilt payload. All seven deployment phases and six
health stages passed at `2026-10-05T02:42:29.531Z`. Both actual Pi profiles passed
206 runner tests, seven native/RPC cases and seven subscription scenarios each.
Specialist context isolation and exact child stop preserved the sibling. The
compiled clock probe passed on the exact Mac and Pi host image: evaluated clocks
remain closed through repeated drains/restart, future clocks survive and later
evaluate, temporary-ineligibility recovery requires fresh authority, and no due
model message or duplicate row is created. No Pi build, dependency installation
or source repair occurred.

All 694 original and 696 fresh-backup messages across 18 session databases were
preserved, with none missing or changed. Three approved records, complete
proposal rows, main conversation/continuation, ten replies, policy and ten
charged attempts were unchanged. Primary Codex login and service-environment
seals matched fresh before-deployment snapshots.

The Pi-owned independence probe passed from `2026-10-05T02:51:27.014Z` to
`2026-10-05T02:53:30.244Z`, after scheduling SSH disconnected and while the Mac
development container was stopped. Both exact profiles and the compiled clock
probe passed; the service stayed active. The Mac container was restored.
Physical Mac power-off is not tested.

Before transfer, three unused host carrier caches from schema-incompatible
historical releases (`074befc0f421`, `8a040c1213a4`, `e2518aacc6c1`) and the
previous release's duplicate transport archive were retired after full Mac
archive verification. No payload, worker image, container, volume, source
checkout, receipt, protected backup, data, session or credential was removed.
Free space rose from 3,360,526,336 to 5,810,835,456 bytes, exceeding the unchanged
5,131,621,564-byte guard. Explicitly retained recovery identities were verified
before and after; retirement did not mutate the service.

The preceding `release-0606b51d1165-20261005002115` is the verified,
manifest-admitted schema-15 recovery predecessor, retaining its exact payload,
three images and clean pinned source. Earlier schema-15 candidates remain
retained with their known clock limitations; automation must stay paused if
used. S07 schema-14 artifacts remain retained and ineligible for rollback. No
actual rollback, old live SQLite restore or schema reset occurred. Immutable
mandate privileges passed, and all eight live mandate-table counts remain zero.

The private acceptance checkpoint records the human merge and all release,
deployment, native, preservation, recovery and independence receipts. This work
made zero live model calls and sent zero real messages. Knowledge and calendar
linking, fresh finite model/channel authority and live mandate validation remain
pending. The Pi-owned lifecycle remains `implementation_disposable`; the full
S01–S11 programme remains incomplete.
