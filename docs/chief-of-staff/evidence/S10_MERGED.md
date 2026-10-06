# S10: reviewed merged-source acceptance

**Status:** S10 and its required corrections are owner-merged and accepted against the actual merged source. S11 is now eligible; the programme is incomplete.

The owner merged [PR #68](https://github.com/ufJmacca/nanoclaw/pull/68) at `e8b4c3fc15a26df64fe18da2a56111234c41cc63` on `2026-10-06T12:15:09Z`. This follows the original S10 merge in [PR #67](https://github.com/ufJmacca/nanoclaw/pull/67), the [decision-first structure correction](S10_STRUCTURE.md), and the [source-evolution and collection-limit corrections](S10_OBSERVATION_CAP.md). The actual merge has the same tree as PR #68's documentation head. A fresh Mac build and every mandatory local and Pi check were nevertheless run for the changed source identity; previous images were not relabelled.

## Delivered identities

| Item                        | Verified value                                                     |
| --------------------------- | ------------------------------------------------------------------ |
| Reviewed application source | `e8b4c3fc15a26df64fe18da2a56111234c41cc63`                         |
| Source tree                 | `83008dffe2a7351527d5092c9b3c46a83dad0f43`                         |
| Release                     | `release-e8b4c3fc15a2-20261006121753`                              |
| Platform                    | Linux/ARM64                                                        |
| Manifest SHA-256            | `9da5ec19e25c060c9157b08d80b426dccc8eb908be1b037eba8d1dc76af9ddde` |
| Archive SHA-256             | `012f4ff4d708ca0b0688b7dd07b7cc4b9b0e929204770d069b562db6b34d015f` |
| Archive bytes               | `1,149,294,273`                                                    |
| Payload SHA-256             | `a203df3bb4fff945bbb332a94cfaec7b2e9d07a47d69658d76c00e69e1d6fbb2` |

| Role  | Engine image ID                                                           | Archive configuration ID                                                  |
| ----- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| host  | `sha256:d62ef42cac806841a5eb6187990a250af10720c6b1b58be6c24acc658c415657` | `sha256:793291290c7d754af8748772892dc7f47f3d3d0f5a857d763268b97b3f7d6c75` |
| agent | `sha256:c8cdd5af79027020def7a2acf440393e66595b6755200f4787aa48d03f495cc8` | `sha256:b0c809176cbf5b7338afe726caf2d9b0ded6511b4db76876261ad3cf804844df` |
| agent | `sha256:65061860f07fb2cebf04aae24f6da20181aaca524c64d974597a13ff4562ce13` | `sha256:f9e632bb631777a19ae8d91deae5c30cd77f293c1ff196e5e7dab38d59d1da6c` |

The Pi fetched and verified the exact commit/tree in a clean detached source checkout. It loaded the Mac-tested images and extracted the matching prebuilt payload. No source build, dependency install or source fix occurred on the Pi.

## Acceptance checks

All seven fresh Mac gates passed: 2,627 application tests across 253 files, types/build/lint/formatting, 214 runner tests, 379 source contracts, five native demonstrations, and 379 packaged contracts per worker profile. Both profiles also passed seven native isolation cases, seven offline subscription scenarios, runner/tool checks and final-image wake/action recovery probes. Final image tests used baked release code.

Pi delivery passed all seven phases and all six health stages at `2026-10-06T13:07:49.688Z`. Both worker profiles passed seven native cases, 214 runner tests and seven offline subscription scenarios. Specialist context isolation, exact-child stop, wake recovery and durable-action fixtures passed. A Pi-owned transient service independently passed both profiles while the Mac development container was stopped, from `2026-10-06T13:15:59.015Z` to `2026-10-06T13:18:11.206Z`. The Mac container was restored. Physical Mac power-off remains untested.

All 698 protected-backup messages and 18 session databases were preserved, including the original 694 messages. Approved records/proposals, the retained main context and continuation, credentials, model policy, ten charged attempts and ten replies were unchanged. The paired backup covers 19 native databases and the independent action journal, with digest `28fd2e997f82caa1a43871c1f62ee76fda779fb9d9429b8c2bebe18823bb96ea`.

PostgreSQL schema 18 and SQLite compatibility level 22 remain unchanged, with all 20 required named native migrations and immutable-history/writer-consent privileges verified. The complete compatible predecessor `release-1e0f089c60b7-20261006103123` remains on the Pi with all three images, payload and pinned source. Compatibility was verified; this successful deployment did not perform a rollback.

## Scoped space recovery and retained history

Before transfer, complete Mac recovery archives and embedded configurations were verified for the candidate, current and previous complete releases, and the older generated host carrier. Only the unused host-image cache for `release-a80d4ada8153-20261006065224` and the duplicate transport archive for the then-active predecessor were retired. The older carrier's actual Pi tag came from its first deployment of the same verified image ID; source, engine ID and archive configuration matched the complete Mac recovery bundle. Its payload, worker images, source and receipts were retained. Current and previous complete compatible releases, all other images, containers, volumes, sessions, credentials, data and backups were preserved.

Free space rose from `3,842,236,416` to `5,431,779,328` bytes, above the required `5,134,048,004` bytes. Earlier actual failures, compatible rollback, observer refusals and scoped test-fixture recovery remain recorded in the preceding receipts and private logs; they were not relabelled as successful runs.

## Live status and next slice

The owner's ratings remain **useful with limitations** for both reviews because their structure was unclear. The clearer recommendation/reason/next-action layout is retained; no new subjective assessment is inferred. The S10 demonstration and this acceptance use synthetic fixtures, not live model-quality validation.

CoS remains paused. Its Pi lifecycle is `implementation_disposable`, the calendar writer is disabled, and its production restore proof is pending. This run made zero live model calls, real messages, OAuth requests or calendar writes. S11 must implement and verify the remaining operations/recovery programme, pass its human merge and actual merged-source acceptance, and confirm the monotonic Pi-owned protected-data transition before programme completion.
