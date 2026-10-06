# S11: reviewed merged-source acceptance and programme closure

**Status:** all S01–S11 implementation merges and the exact reviewed release's Mac/Pi acceptance are verified. The Pi owns the protected-data seal. A later CI failure exposed a date-dependent test fixture; [PR #71](https://github.com/ufJmacca/nanoclaw/pull/71) awaits human review/merge and acceptance of the resulting merged source before the programme's completion checkpoint. Live account/model activation remains separately gated.

The owner merged [PR #69](https://github.com/ufJmacca/nanoclaw/pull/69) at `e916c4d1388a141ea6095a215742f39521d4b7b2` on `2026-10-06T21:50:35Z`. Its tree matches the published receipt head. A fresh complete Mac build/test and Pi deployment nevertheless used the actual merged identity; candidate images were not relabelled. [Earlier S11 candidate and recovery evidence](S11.md) remains historical, including its genuine failures and recoveries.

## Reviewed implementation

| Slice | Original implementation PR                             | Final accepted merge PR                                | Accepted merged source                     |
| ----- | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------ |
| S01   | [PR #54](https://github.com/ufJmacca/nanoclaw/pull/54) | [PR #55](https://github.com/ufJmacca/nanoclaw/pull/55) | `54edbf47102c6ab7b8b7c397e424780579344cf4` |
| S02   | [PR #56](https://github.com/ufJmacca/nanoclaw/pull/56) | [PR #56](https://github.com/ufJmacca/nanoclaw/pull/56) | `fdc52a635f6ba8bb379ae0c7e888ba92f397418f` |
| S03   | [PR #57](https://github.com/ufJmacca/nanoclaw/pull/57) | [PR #57](https://github.com/ufJmacca/nanoclaw/pull/57) | `b93d5e58503490ad6b8db11ae1f5f018ef7cf009` |
| S04   | [PR #58](https://github.com/ufJmacca/nanoclaw/pull/58) | [PR #58](https://github.com/ufJmacca/nanoclaw/pull/58) | `0c79df8daba82c5bacba5ce819bce4f88ddf1e8f` |
| S05   | [PR #59](https://github.com/ufJmacca/nanoclaw/pull/59) | [PR #59](https://github.com/ufJmacca/nanoclaw/pull/59) | `4ea9a622a016da5d9150e26ea2d10832ae167494` |
| S06   | [PR #60](https://github.com/ufJmacca/nanoclaw/pull/60) | [PR #61](https://github.com/ufJmacca/nanoclaw/pull/61) | `9e1717d62af17b3a06e24bb715eb03c6304592fa` |
| S07   | [PR #62](https://github.com/ufJmacca/nanoclaw/pull/62) | [PR #63](https://github.com/ufJmacca/nanoclaw/pull/63) | `a72be36a42f53f38256d47f9b3b18564e27f3f73` |
| S08   | [PR #64](https://github.com/ufJmacca/nanoclaw/pull/64) | [PR #65](https://github.com/ufJmacca/nanoclaw/pull/65) | `462daabef958b9ba1874168719737ad7b39ef8e8` |
| S09   | [PR #66](https://github.com/ufJmacca/nanoclaw/pull/66) | [PR #66](https://github.com/ufJmacca/nanoclaw/pull/66) | `60ad9d5dd08d4dd4a64377745ad49a4cc22254fe` |
| S10   | [PR #67](https://github.com/ufJmacca/nanoclaw/pull/67) | [PR #68](https://github.com/ufJmacca/nanoclaw/pull/68) | `e8b4c3fc15a26df64fe18da2a56111234c41cc63` |
| S11   | [PR #69](https://github.com/ufJmacca/nanoclaw/pull/69) | [PR #69](https://github.com/ufJmacca/nanoclaw/pull/69) | `e916c4d1388a141ea6095a215742f39521d4b7b2` |

The final protection coordinator independently reobserved these human merges through GitHub and verified each accepted commit's ancestry in the tested final source. S01's subscription runtime alignment is included. Three stale ledger links to original PRs were reconciled to their already accepted correction merges; the original references and publication history were preserved.

## Delivered identity

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Source                  | `e916c4d1388a141ea6095a215742f39521d4b7b2`                         |
| Tree                    | `b0e5171685dc2a3fcd5c6d10626654c3e6cf9434`                         |
| Release                 | `release-e916c4d1388a-20261006215547`                              |
| Platform                | Linux/ARM64                                                        |
| Manifest SHA-256        | `88b3a28e2e2c6077de1b228f774c9343a1583d42d75c6baab4521d84f618d63c` |
| Archive SHA-256         | `54a37609bda5c540206e635f573e24675009f8f52bf41a2becb9120ff4eae3a7` |
| Archive bytes           | 1,149,504,805                                                      |
| Host payload SHA-256    | `ec70934c583751743e539bd7201f0c7f747d1b3fae315fd71ed2b0c3e877e448` |
| Completion proof digest | `3805891a4c460e409be05baee747ae34d64fdda5a8c0f2d5f3ffdcf30d6fca0f` |

| Role             | Engine image ID                                                           | Archive configuration ID                                                  |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| host             | `sha256:8b3959ca18811e5faf9c9870b1e10e4fd21e168c055399d68342a93e64795266` | `sha256:5df1c696d6bed5257d254881a958b6da15259f73048c0e563fbc48b5501c546c` |
| standard worker  | `sha256:f282a713455da3204c75b798188e1b0ced05e47640d20626b3bf09d11ddca4b8` | `sha256:46c306fa0bdf4a6fbc6f5189a071d7b37adc48b22d179197932d96458b9d998e` |
| documents worker | `sha256:fffd10a1db7b54202434659d388eec10dadd3e7f33fd496aafebd99002ca368d` | `sha256:a4ab843806074e53d31428f9168edaff0464fdefa333b4570895d02cfde848ff` |

The Pi fetched and verified this exact source/tree in a clean detached release checkout, loaded the Mac-tested image archive and extracted the matching prebuilt payload. No source build, dependency installation or source fix occurred on the Pi. Later acceptance-document commits describe this release; they are not its tested application identity.

## Final checks and protection

All seven fresh Mac gates passed: 2,744 application tests across 270 files, host/runner types, build, lint and formatting, 215 runner tests, 395 source contracts, 18 combined demonstration checks, image isolation, baked worker checks and 395 packaged contracts per profile, with no contract failures or skips. Lint retained 324 warnings with no errors. Both profiles passed seven native isolation cases and seven offline subscription scenarios. The exact final host also passed compiled clock, action and protected-completion probes without network, credentials or checkout overrides.

The first packaged-host run passed 394 of 395 contracts on the standard profile. The calendar-disconnect/restart inspection returned unavailable instead of the expected result. Its exact cause was not captured. The unchanged isolated flow passed on both profiles; a complete unchanged host gate then passed all 395 contracts on both profiles, including native bootstrap and operator checks. The original failed log and both diagnostic receipts remain separate. No source, image, timeout or test assertion was changed for the retry.

The later documentation PR's CI failed one host test after the fixed calendar event date passed. That approval fixture calculated its expiry using the real clock, so the production validator correctly rejected an expiry later than the event start. The unchanged local test reproduced the failure. PR #71 fixes only the fixture clock, restores it after each test and adds expiry-boundary denial coverage; its eight outbox tests and all 2,745 host tests pass locally, with types, lint and formatting. It has not changed the deployed artifacts. This new, explained failure is separate from the earlier packaged-host failure above. The final programme checkpoint was not executed.

The first final-release launcher refused `active_slice_required` before tests or target mutation. The existing launcher requires the acceptance phase to be active; the ledger phase was reconciled while keeping human merge evidence intact. No tested source or release guard was weakened.

Two private acceptance-launcher errors were corrected without changing product source or images: an initially sandbox-denied host Docker checkpoint was retried with authorised host access, and a fixture installer was reinvoked with its required pinned release argument after refusing the missing one before target mutation. Both original failures and successful results are retained separately.

Programme protection used the retained, tested S11 helper to seal the Pi **before** final image delivery or deployment repair. The proof binds all eleven human merges, the required alignment, final manifest and installation. It grants no account/model authority. The Pi retained protection through the new source activation and service restart.

Final normal delivery passed source, artifacts, quiesce, backup, migrate, activate and health at `2026-10-06T23:01:05.983Z`. Installed read-only checks confirmed database readiness and the private Mattermost owner/channel binding without sending a message. Both Pi profiles passed their operator fixture, seven native cases, 215 runner tests and seven offline subscription scenarios, plus clock/action/protected-completion fixtures, at `2026-10-06T23:11:10.073Z`.

The standard delivery coordinator was then rerun against the exact protected current release. Its dedicated completion path returned healthy with `cosResumed=false`. The original deployment, migration and paired-backup records, protected target records and service PID stayed unchanged. The actual compiled runtime-disposable maintenance request was refused by the Pi's own protected state, with target records and PID unchanged. Synthetic failed-health and same-identity retry cases remain separate from these actual checks.

## Preservation, recovery and independent operation

All 698 backed-up messages and 18 session databases were preserved, including the original 694 message identities/content. Credentials, main context and continuation, model policy, three approved records, four proposals, ten replies and ten charged model attempts were unchanged.

The fresh paired backup covers 19 native databases and the independent action journal, with digest `4d41d32ae271aef2b134f9f799fb994fbaed42d1f54cbf2b0a534520a8bd9484`. PostgreSQL remains at schema 18 with all 18 migration checksums, and native compatibility remains 22 with all 20 required named migrations. Immutable history and read-only writer-consent privileges were verified. The complete compatible predecessor `release-eec66c59c239-20261006200417` retains all three images, payload and clean pinned source. Current native denial history was checked against both releases. No actual final-release rollback or restoration over live data occurred.

The earlier installed backup/isolated restore belongs to `release-2ac71c185d65-20261006182617`. Its exact isolated proof, `58fa742a4436070579c03281f31ac5cb47f98c336924f82beb49a8e743f40859`, was verified again on the final Pi. That drill used isolated Pi local files and the separate admitted external test database; its first unavailable maintenance release and same-UUID recovery remain recorded. It was not repeated or relabelled as a new final-source restore. The unchanged final compiled recovery contracts passed in the full replay.

A Pi-owned transient service ran after its scheduling SSH session disconnected, from `2026-10-06T23:12:42.018Z` to `2026-10-06T23:14:49.269Z`, while only the Mac repository development container was stopped. Both worker profiles passed offline subscription and specialist context/stop checks; clock and action probes passed and the Pi service remained active. The Mac container was restored. This establishes independence from the development runtime for the tested fixtures; physical Mac power-off and fresh live inference were not tested.

Before transfer, three complete Mac recovery archives and image configurations were verified. Scoped retirement removed only the current candidate's duplicate Pi transport archive and the obsolete S10 host carrier/payload cache. Free space rose from 3,473,096,704 to 5,359,575,040 bytes. Both complete S11 recovery releases, every worker image, container, volume, source checkout, receipt, protected backup, credential and runtime history were retained. The obsolete S10 artifacts remain reconstructible from their verified Mac archive. Earlier failures and refusal logs remain preserved in the private ledger and [historical S11 receipt](S11.md).

## What is available and what remains gated

S01–S11 implement persistent priorities, grounded knowledge, calendar awareness, scheduled preparation, direct missions, specialist teams, proactive proposals, bounded mandates, exact-action approvals, strategy reviews and owner inspection/recovery. CoS is an agent group within NanoClaw. Its main conversation shares one retained context; reply threads group messages visually. Only authorised specialist agents use separate model contexts.

In the bound private Mattermost channel, the owner can use deterministic `cos status`, category inspection and scoped pause/cancel/revoke controls without a model turn. The [operator runbook](../OPERATIONS_AND_RECOVERY.md) covers status, maintenance, export, isolated restore and safe recovery. The protected lifecycle permanently closes runtime-disposable cleanup; integration testing continues on the separate admitted test database.

CoS remains paused. Subscription runtime support is implemented and had prior live acceptance, but the finite live allowance has expired. This final acceptance made zero new live model calls, real messages, OAuth requests or calendar writes. The calendar writer, live team/mission policies, account-specific pilot and real-source strategic review remain unconfigured or separately pending. New live calls/messages need a new explicit allowance; real writes still need their account-specific validation and exact approval.

The owner's two strategic-review ratings remain **useful with limitations because their structure was unclear**. No improved rating, net time saving or live model-quality outcome is inferred from fixtures. Server backups/PITR and actual password issuance remain the external DBA's responsibilities; selected credential reinjection and pool-retirement tests do not establish those outcomes.

Private source/image, local-gate, target, protection, preservation, recovery and independent-operation receipts are indexed by `.cos-plan-state/s11-merged-acceptance-assessment.json` and the additive execution ledger. The Pi retains its own authoritative release, maintenance, protection and recovery records. No secret, private endpoint, account identifier or real source prose is included here.
