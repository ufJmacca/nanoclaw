# S10 — owner feedback and review structure correction

**Status:** the owner's assessment is received with limitations and the structure
correction passed technical verification on the Mac and Pi. Human review/merge
remains pending. This is a tested, unreviewed candidate; S11 is not eligible and
the programme is incomplete. CoS remains paused.

## Owner assessment and resulting change

The owner assessed both original synthetic reviews: “Both are useful with
limitations - They were unclear in structure”. The exact judgement and limitation
are recorded in the private execution ledger. This is an assessment of the
checked fixture advice, not live model quality or approval to execute its advice.
No numerical score or improved subjective rating has been inferred.

New reviews put the recommended option's readable title, initiative, reasoning,
next action, confidence and uncertainty first. Alternatives have separate
trade-off, opportunity-cost and next-action lines. Outcomes, evidence, findings,
resources and provenance have distinct headings. The later review brings the
previous recommendation and actual owner choices before the supporting record
list. Original observations, contradictions, evidence references and permission
boundaries remain present.

Published artifacts record rendering version `cos-strategy-render/v2`.
Unversioned artifacts retain the frozen v1 renderer and their exact original
text. Unknown rendering versions are denied. Both renderers use the same typed
review validation, output bound and mention/Markdown escaping. Redisplay still
checks current source/context authority, artifact and output hashes, and the
exact publication ticket; it does not rewrite history for a layout change.

Three new layout tests first failed alongside 26 passing tests. A compatibility
test then failed alongside 29 passing tests. All 30 renderer tests passed after
the changes. The real Test database verifies new rendering metadata, unchanged
legacy text, historical redisplay and publication, and denial of an unknown
renderer. The complete native demonstration verifies that the actual delivered
initial and later reviews expose the decision before evidence.

An initial local candidate at
`469185184f186634fd0b9ec6de772e8c2659cab4` passed its 2,624 root and 214 runner
tests, then failed three fixture assertions. The new compatibility test added
two separate reviews, while later assertions still counted only the original
review's records. The correction scopes the lineage query to that exact review
and checks quarantine/purge for all eight artifacts and four retained review
identities. The failed source log remains private. No image from that failed
candidate was transferred or deployed.

## Exact revised candidate

| Identity               | Verified value                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| Application commit     | `a80d4ada81538a531e97091f71f326c79eb5404a`                         |
| Application tree       | `425d37a85044bde5b72575acdb3e71e359be4cec`                         |
| Release                | `release-a80d4ada8153-20261006065224`                              |
| Source fetch reference | `refs/heads/codex/s10-strategic-reviews`                           |
| Manifest SHA256        | `12fb5a80bf874321ffa92addc16dde1aa58f6e5a5a44df95395821ccab180ab9` |
| Archive SHA256         | `4b6a11b79dfbaf41753b67af7b154f1e262eb9ca2b959728df77da05cb90eb02` |
| Archive bytes          | 1149284821                                                         |
| Host payload SHA256    | `4686f7b30cb4deb1d1fe1ec65c87273fd3c8fe10206815642ebe03740276823a` |
| PostgreSQL             | 18; all predecessor migration checksums unchanged                  |
| SQLite                 | compatibility 22; all 20 required named migrations verified        |

Later receipt/runbook-only commits do not change these tested artifact identities.

| Image                  | Engine identity                                                           | Archive configuration identity                                            |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Host                   | `sha256:922776d1fe8a1cfa7ac74cb7068987b5c6a2935237cdd9607eb923e7b4e72bc8` | `sha256:00e1f199478a71d77a4319b76098572c02581533fd80861b8e308c9215397b96` |
| Standard Codex worker  | `sha256:a05cb22f9c737fa009f501fda13df116e3f3ed342d25b4403b58b1f7f3f920d2` | `sha256:989d65de21a9378bc3e234e1d0deb0d9d005b1bceaaf7eadaa3462d3da98c567` |
| Documents Codex worker | `sha256:233e8927e29737b7ca8ce699b8947ea2e2b60b0577ec9c4ce2956bae7a06189d` | `sha256:fa668e4bd2bfec6354e2a00acaafa2655b4b253393396ee43c19519e6eada2f2` |

## Validation and deployment

All seven mandatory local gates passed: 2,624 root tests across 253 files,
typecheck/build/format/lint, 214 runner tests across 29 files and typecheck,
374 cumulative source database contracts, five native demonstration checks,
374 packaged contracts for each exact host/worker pair, and both final worker
profiles' native/RPC, offline real-Codex, runner and toolchain checks. Database
tests selected only the separate protected Test profile with verified TLS.

Both final Mac profiles retain MCP discovery and a strategic call without
rewriting main history or changing its generation. The exact immutable host also
passed the compiled wake-retirement and calendar-action recovery probes.

The first Pi attempt, `release-a80d4ada8153-20261006055727`, failed its final
native fixture after passing five health stages. Compatible recovery restored
the previous S10 service with admission closed. All 698 backed-up messages across
18 session databases were unchanged. The exact immutable fixture then passed on
retry; the original fixed-classification failure is retained and its precise
cause is not claimed. The terminal failed receipt was never relabelled green.
The fresh release below passed all seven Mac gates again before deployment.

The Pi verified the pinned detached source and exact archive/images/payload.
Seven deployment phases and six health stages passed at
`2026-10-06T07:33:18.102Z`.
Both actual Pi profiles passed their 214 runner tests, seven native/isolation
cases and seven offline real-Codex scenarios. Specialist context isolation and
exact child stop passed. The immutable wake/action probes passed again. No Pi
build, dependency installation or application-source repair ran.

The first broader Pi verification passed the standard profile's seven native
cases but two of its 214 runner tests timed out in SQLite setup/teardown hooks.
The original 212-pass/two-failure log and resource observations remain private;
the precise underlying cause is not inferred. One complete bounded retry passed
both profiles' 214 tests and all native/offline cases using the same images and
unchanged source and timeout limits. Tests were not skipped or relabelled.

All 694 original and 698 current-backup messages across
18 session databases were preserved with none missing or changed. Approved
records and complete proposals, the retained main context and continuation,
policy, ten charged attempts and ten replies stayed unchanged. Primary Codex
login and service-environment seals matched fresh baselines. The service is
active, maintenance is clear, CoS is paused and the calendar writer is disabled.

The Pi-owned independence probe passed from
`2026-10-06T07:44:05.009Z` to `2026-10-06T07:46:17.969Z`
after scheduling SSH disconnected and while the Mac development container was
stopped. Both profiles and wake/action recovery passed; the container was then
restored. Physical Mac power-off was not tested.

## Capacity and recovery

Before the first transfer, complete Mac archives and embedded image configurations
were verified for the duplicate original S10 transport archive and three obsolete
schema-incompatible generated payloads: S07 `16f4b142f4f9`, S07 merge
`a72be36a42f5`, and the initial S09 candidate `9a1b25b88419`.
Before the recovery transfer, the failed candidate's generated payload and
duplicate transport archive, and the schema-incompatible prior/accepted S09
payloads `27f1c7abe0f8` and `60ad9d5dd08d`, were also retired only after
complete Mac archives and embedded configurations were verified. The active
compatible schema-18 predecessor's payload, all three images and pinned source
remained verified throughout. Complete S09 payloads remain in verified Mac
archives; their Pi images, source and acceptance/backup records remain.
Only those backed-up caches were retired. All Docker images, containers and
volumes, protected backups, source checkouts, manifests, receipts, runtime data,
sessions and credentials were retained. Free space became 5384167424
bytes against the unchanged 5134010196-byte combined
transfer/preparation requirement. The service did not change during retirement.

An additional process-use check first refused inaccessible OS-helper links before
any removal. Systemd/logind verified the systemd/PAM and SSH helpers; checks for
all other application processes and overlapping container mounts remained. The
initial refusal and identity evidence are retained privately.

The migration path captured a paired protected-state backup covering
19 native databases, digest
`6fd20d97ede97a6acf467879db3d56267e67f181d07200bf1844f52c34ef0ce9`. The independent effect journal and runtime
privilege boundaries remain intact. All live action, mandate and strategy tables
in the bound scope are empty; writer, team and mission admission remain
unconfigured. No production restore proof was issued.

The previous tested, unreviewed S10 release
`release-93f10208d9a3-20261006022211` remains compatible at schema 18, with
all three exact images, its verified payload and clean pinned source retained.
Accepted S09 schema-16 artifacts remain incompatible with schema 18. Recovery
preserves paused admission and database contents. The first failed deployment
performed the recorded compatible code rollback; no old live SQLite restore or
schema reset ran.

Private provenance is `s10-structure-technical-evidence.json`, the exact release's
local/source/preparation/delivery/deployment receipts, the original owner
assessment, corrected checked review samples, and native/preservation/recovery/
independence/cache-retirement evidence. Recorded `2026-10-06T07:48:02.178Z`.

## Remaining gates

Human review and merge of [PR 67](https://github.com/ufJmacca/nanoclaw/pull/67)
remain required, followed by fresh build/test/deployment and acceptance of the
actual merged source before S11. The owner assessment has been recorded; it is
not a merge approval.

Live subscription/channel authority remains expired after ten charged attempts.
This correction made zero live model calls, real messages, OAuth requests or
calendar writes. A new finite live allowance and current binding/permission
verification remain separate, as do S09 writer consent and protected backup/
restore-proof gates. The Pi lifecycle remains `implementation_disposable` until
the programme's required reviewed merges, tests and protected transition pass.

See the [original S10 implementation evidence](S10.md) and
[strategic-review runbook](../STRATEGIC_REVIEWS.md).
