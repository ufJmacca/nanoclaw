# S10 correction: reviews after source changes

**Status:** exact tested candidate deployed and technically verified; correction human review/merge pending.

The owner merged [S10 PR #67](https://github.com/ufJmacca/nanoclaw/pull/67)
at `cb221bc0f6692f7ffd798e51dea786ab17105449`. Its automated review identified
a P1 defect: an immutable observation could prevent every fresh review after its
source was revised, withdrawn or removed from the charter. This required
correction starts directly from that actual merge. Acceptance of the final
reviewed merged source remains pending; S11 has not started.

Fresh reviews now omit observations whose evidence is no longer selected or
currently authorised, and report limited coverage. Their private statements,
rationales and evidence IDs stay out of the new snapshot. Approved observation
rows remain immutable. Current evidence can support a newly approved observation.
Current charter, owner, context and source checks still apply; a charter that
continues to select a revoked source is denied. Invalid observation bodies or
digests, interrupted database collection and stale publication remain closed.
Saved review redisplay retains its existing permission and version checks.

The owner's assessment remains **useful with limitations** for both reviews,
with the limitation “They were unclear in structure”. The
[decision-first structure correction](S10_STRUCTURE.md) is retained; no improved
subjective rating or renewed live authority is inferred.

## Exact delivered identities

| Item                 | Verified identity                                                  |
| -------------------- | ------------------------------------------------------------------ |
| Application source   | `da5b567abd870e4a426392b4b1c0a6688130fac0`                         |
| Source tree          | `435574e77b8157e97673c9ec2734f05fe36b2ea6`                         |
| Branch               | `codex/s10-current-observations`                                   |
| Release              | `release-da5b567abd87-20261006083219`                              |
| Platform             | Linux/ARM64                                                        |
| Manifest SHA-256     | `37c279e19a5591bfe76c7ed4afeaba63eee22642ada4cd97d96c887474de9b97` |
| Archive SHA-256      | `41bc24078e8edf4d5532ab607febc4e1568168db2bb9af7d5453693186c46523` |
| Archive bytes        | `1,149,294,430`                                                    |
| Host payload SHA-256 | `22f61db62600e8b56af85b703c99e83fb9670c5449d9b057150bef5223ee49b9` |

| Role             | Engine image ID                                                           | Archive configuration ID                                                  |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Host             | `sha256:c040daeee0b30deb06c09201198061940df9ae2bf158058c8a654b460a2d60ca` | `sha256:e96a020037ed95519c99c4d2394448dbb1b5ae0025effa29c773053714a63208` |
| Standard worker  | `sha256:c3da6f8dc9a4ac7421b007168709fabdc8909ff38887cf0e62bb67f65b438093` | `sha256:6a1b60f00250e07b08cecf201477829252264ea8929f8e92cd909399c8517326` |
| Documents worker | `sha256:8dc9cd7650714e711bb6e4c1c38d3faf491c88f53752e46c4dcafb085e8f2281` | `sha256:9d772faf207863929d021f40651577dcd8f65ab8531be6912ca38b3b01fa48b1` |

The Mac built and tested these identities. The Pi fetched the exact source into
a clean detached release checkout, verified its commit/tree, and loaded the
matching artifacts. It performed no source build or dependency installation.

## Verification

Four separately scoped external PostgreSQL scenarios first reproduced the defect
for source revision, charter deselection, revocation and deletion. The fixture
registration test also failed before registration. After correction, 49 affected
unit tests and all 16 collection/source-evolution database tests passed.
The scenarios verify withheld private text, limited coverage, preserved immutable
rows, replay, denied stale contexts/selected revoked sources, and admission of a
new observation supported by current evidence. Earlier fixture expectation and
type failures remain in the private history.

All seven final Mac release gates passed:

| Check                    | Result                                                                      |
| ------------------------ | --------------------------------------------------------------------------- |
| Application              | 2,624 unit tests across 253 files; types, build, lint and formatting passed |
| Runner                   | 214 tests across 29 files; types passed                                     |
| Source contracts         | 378 passed, zero failures/skips                                             |
| Native S10 demonstration | Five passed, zero failures/skips                                            |
| Packaged host            | 378 passed per worker profile, zero failures/skips; baked release code      |
| Worker images            | 214 runner tests per profile; tools and document libraries passed           |
| Image isolation          | Seven native cases and seven offline subscription scenarios per profile     |

Additional wake-recovery and durable-action probes passed against the exact host
image. Pi delivery completed source, artifacts, quiescence, backup, migration,
activation and health. All six health stages passed at
`2026-10-06T09:19:01.216Z`. Both Pi profiles passed seven native cases, 214 runner
tests and seven offline subscription scenarios, including separate specialist
contexts and exact-child stop. The extra packaged probes also passed on the Pi.

The first preservation observer refused two Mac baseline files with mode `0644`
as `unsafe_target_state`. Their exact permissions were tightened to `0600`, the
original refusal log was retained, and the remaining preservation comparison
passed. Application source, images and service were unchanged; passed native tests
were not rerun to hide that observer failure.
The final aggregation observer similarly refused a Mac cache receipt with mode
`0644`; its exact mode was tightened to `0600` and the refusal log retained.

## Preservation and compatible recovery

All 698 messages in the current protected backup and all 18 session databases
were preserved, including all 694 messages from the original baseline. Approved
records/proposals, policy, ten charged attempts, ten replies, main context and
continuation, primary Codex login and service environment remained unchanged.
The paired backup covers 19 native databases and the independent action journal,
with digest `591868550df562ee29c7fcf4e20d38be0456c961ad500062e7394931557560ad`.

The external schema remains 18; SQLite compatibility level remains 22, with all
20 required named migrations verified. Runtime immutable-history and writer
consent privileges passed. No live strategy, mandate or action configuration or
effects were added.

The complete compatible recovery release
`release-a80d4ada8153-20261006065224` remains on the Pi with all three images,
verified payload and pinned source. Recovery compatibility was checked; this
successful deployment did not perform a rollback. Earlier S10 failures and its
actual compatible rollback remain documented in [the structure receipt](S10_STRUCTURE.md).
S09/schema-16 artifacts remain incompatible with schema 18.

For capacity, complete Mac archives and embedded image configurations were
verified before retiring only the duplicate transport archive for the previous
active release and the unused older generated payload for
`release-93f10208d9a3-20261006022211`. All images, containers, volumes, source
checkouts, receipts, backups, runtime data, sessions and credentials were retained.
The older release retains its complete verified Mac archive for payload recovery.
Free space rose from `3,773,865,984` to `5,219,770,368` bytes, above the required
`5,134,048,632` bytes. The active compatible release's full payload was retained.

## Remaining gates

A Pi-owned transient service passed both profiles' offline subscription and
specialist-isolation/child-stop checks, plus wake/action recovery, while the Mac
development runtime was stopped. It ran from `2026-10-06T09:28:30.994Z` to
`2026-10-06T09:30:32.730Z`; the Mac container was restored afterwards. Physical
Mac power-off has not been tested. CoS remains paused and its Pi lifecycle remains
`implementation_disposable` until programme completion. This correction used
zero live model calls, real messages, OAuth requests or calendar writes. The
calendar writer remains disabled and its production restore proof is pending.

Human review/merge of this required correction and fresh acceptance of its actual
merged source are required before S11. Original PR #67's human merge is verified;
it does not substitute for acceptance of the final corrected source. The programme
is not complete.
