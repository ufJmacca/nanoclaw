# S10 correction: current observations retain review capacity

**Status:** exact tested candidate deployed and technically verified; [PR #68](https://github.com/ufJmacca/nanoclaw/pull/68) human review/merge pending.

After the owner merged [S10 PR #67](https://github.com/ufJmacca/nanoclaw/pull/67),
its P1 review identified historical source evidence that could block fresh reviews.
The [first source-evolution correction](S10_SOURCE_EVOLUTION.md) addressed that
case. PR #68's actual P2 review found a remaining problem: retired observations
could fill the 20-observation collection limit before newly approved current
evidence was considered. This receipt records the final candidate for both fixes.

Fresh reviews now select current source references before applying the bounded
collection limit, then recheck body integrity, current context and source
permissions. Newer charter versions and newer approved observations take priority
within the available set. Retired observations remain immutable, their private
text stays out of fresh snapshots, and withheld or overflowing history produces
limited coverage. Saved-review disclosure controls remain enforced.

The owner's original assessment remains **useful with limitations** for both
reviews because “They were unclear in structure”. The merged
[decision-first layout](S10_STRUCTURE.md) is retained. No revised subjective
rating or renewed live authority is inferred. S11 has not started.

## Exact delivered identities

| Item                 | Verified identity                                                  |
| -------------------- | ------------------------------------------------------------------ |
| Application source   | `1e0f089c60b7104e4d392f219d3a5799ff65ba65`                         |
| Source tree          | `39e72705718181fa5733e700614f8929024a9a26`                         |
| Branch               | `codex/s10-current-observations`                                   |
| Release              | `release-1e0f089c60b7-20261006103123`                              |
| Platform             | Linux/ARM64                                                        |
| Manifest SHA-256     | `c40ba310927e5a1891e9f4e94c265d341b904113f7e150591036903df0d05f04` |
| Archive SHA-256      | `a61002530db4ee6c112434f56b9c4fef3a3b4b73717d23ddf9d06ccee6427c5b` |
| Archive bytes        | `1,149,295,168`                                                    |
| Host payload SHA-256 | `f37b739afd8464604a23738ede45ea2d33fb92b6169da02e0e7739fe002b3a57` |

| Role             | Engine image ID                                                           | Archive configuration ID                                                  |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Host             | `sha256:b6e58d4fbe776bae2f81b660d1ff4fb72672c04a1fd3209fbb90677a0151c7b7` | `sha256:d6aba03dbafbc27a34b852ce755266b8559f1b9eb64d488c157926548eb73f74` |
| Standard worker  | `sha256:2d2949e6ddf3fc253533f9c68b0937addc514233760fc417eea819c5248c8fbc` | `sha256:d59a46bf8fad80a7748af4e606247f64d6f47a689dbc7a374b0dc451d089cac1` |
| Documents worker | `sha256:047a1681e8026440c4bc0cf7d7825e776b10805229516e317f204bd143c255a3` | `sha256:850d02ab7742be49afde3942921c01f018eb7c9f03f707fbd8d73d0a32469236` |

The Mac built and tested these exact artifacts. The Pi fetched the pinned source
into a clean detached checkout, verified commit/tree agreement, and loaded the
matching prebuilt artifacts. It performed no source build or dependency install.

## Tests and retained failures

The saturated-history regression first failed with a newly approved backed
outcome reported as unknown. It creates 25 retired observations through the
production proposal and approval paths using fixture identities, places them
deterministically before the new observation, and
verifies both admission of current evidence and a full bounded set of 20 current
observations without changing the old rows. All 17 focused collection/evolution
PostgreSQL tests and 49 affected unit tests passed.

Two fixture-cleanup tests first failed when auto-removal raced inspection or
stop. All seven cleanup tests then passed, including refusal to treat a
still-listed uninspectable worker as absent and preservation of foreign workers.
Types, lint and formatting passed. S10's expanded full suite has a bounded
15-minute deadline; a timeout is explicitly a failed gate. Live model authority
and runtime limits are unchanged.

The first release stopped at its former ten-minute deadline after 355 top-level
passes and the first nested specialist scenario, without a complete summary.
Cleanup encountered an already removed worker. Its full log and failed gate were
retained; no images were built or transferred. Worker absence was independently
verified. An intermediate fixture diagnostic type error is also retained.

The second release completed 379 tests with 290 passes and 89 failures. Two
unfinished synthetic specialist reservations from the timed-out run still
consumed the separate test database's worker capacity. The fence correctly kept
later work pending. After authenticated test-target, exact native/remote owner,
exclusive lock, worker-absence and zero-real-effect checks, the single abandoned
test scope was backed up and reconciled. All other scope counts and the admission
fence were unchanged; no schema reset or runtime-database mutation occurred.
All 49 mission checks then passed. Both failed releases remain failed.

The fresh final release passed all seven mandatory Mac gates:

| Check                    | Result                                                                      |
| ------------------------ | --------------------------------------------------------------------------- |
| Application              | 2,627 unit tests across 253 files; types, build, lint and formatting passed |
| Runner                   | 214 tests across 29 files; types passed                                     |
| Source contracts         | 379 passed, zero failures/skips                                             |
| Native S10 demonstration | Five passed, zero failures/skips                                            |
| Packaged host            | 379 passed per worker profile, zero failures/skips; baked release code      |
| Worker images            | 214 runner tests per profile; tools and document libraries passed           |
| Image isolation          | Seven native cases and seven offline subscription scenarios per profile     |

Additional wake-recovery and durable-action probes passed against the exact host
image. Pi delivery completed all seven phases; all six health stages passed at
`2026-10-06T11:22:53.408Z`. Both Pi profiles passed seven native cases,
214 runner tests and seven offline subscription scenarios, including specialist
context isolation and exact-child stop. The extra packaged probes passed too.

## Preservation, capacity and recovery

All 698 messages in the current protected backup and all
18 checked session databases were preserved, including the original
694 messages. Approved records/proposals, ten charged attempts, ten replies,
policy, main context, continuation, primary Codex login and service environment
remained unchanged. The paired backup covers 19 native databases and the
independent action journal, with digest `1faa7daf9bb2a159e5f3069d71fc965486d79c936058655e7909dbd41ca84f5e`.

External schema 18 and SQLite compatibility level 22 remain unchanged; all 20
required named native migrations and immutable-history/writer-consent privileges
were verified. No live strategic, mandate or action configuration/effects were
added. The writer remains disabled and its production restore proof is pending.

The complete compatible previous release `release-da5b567abd87-20261006083219`
remains on the Pi with all three images, verified payload and pinned source.
The earlier compatible `release-a80d4ada8153-20261006065224` was also fully retained
during capacity maintenance. Compatibility was checked; this successful
deployment performed no rollback. Earlier actual S10 rollback/failures remain in
[the structure receipt](S10_STRUCTURE.md).

Complete Mac recovery archives and embedded configurations were verified before
retiring four unused historical host carrier images, plus the duplicate transport
archive for the prior active release. Their worker images, source checkouts,
receipts and backups were retained. Current and previous compatible payloads and
images, all containers/volumes, runtime data, sessions and credentials were
retained. The four historical host caches were:

- `release-9a1b25b88419-20261005100038`
- `release-27f1c7abe0f8-20261005111558`
- `release-60ad9d5dd08d-20261005215838`
- `release-93f10208d9a3-20261006022211`

Free space rose from `3,082,162,176` to `5,987,196,928` bytes,
above the required `5,134,051,584` bytes. No blanket prune or
unrelated workload cleanup occurred.

## Remaining gates

A Pi-owned transient service passed both profiles' offline subscription and
specialist/child-stop checks, plus wake/action recovery, while the Mac development
runtime was stopped. It ran from `2026-10-06T11:30:22.022Z` to
`2026-10-06T11:32:29.447Z`; the Mac container was restored afterwards.
Physical Mac power-off has not been tested.

CoS remains paused and its Pi lifecycle is `implementation_disposable` until
programme completion. This correction used zero live model calls, real messages,
OAuth requests or calendar writes. Human review/merge of PR #68 and fresh
acceptance of its actual merged source are required before S11. Original PR #67's
human merge is verified; the programme remains incomplete.
