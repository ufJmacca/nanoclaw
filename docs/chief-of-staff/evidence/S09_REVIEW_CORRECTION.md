# S09 — settle calendar actions blocked by a verified overlap

**Status:** historical corrected candidate evidence; PR #66 is now human-merged.
The [merged-release receipt](S09_MERGED.md) records the accepted actual merge.
Live writer admission and validation remain pending. The S01–S11 programme is incomplete.

When two overlapping calendar blocks were approved before execution, completing
the first left the second pending indefinitely. The
[review finding](https://github.com/ufJmacca/nanoclaw/pull/66#discussion_r4183304734)
was reproduced against the previous PR head. A verified competing block now
settles the never-started action as blocked, records one durable conflict receipt,
removes it from executable discovery and exposes its private terminal notice.
Executing or uncertain competitors remain pending; original-effect readback and
adjacent, non-overlapping slots remain eligible. No approval or permission was widened.

## Exact tested and deployed identity

Plan revision 5, `cos-postgres/external-env-v3` and the pinned-source delivery
contract apply. This corrects the [initial S09 candidate](S09.md), on the existing
`codex/s09-approved-calendar-actions` branch and [PR #66](https://github.com/ufJmacca/nanoclaw/pull/66).

- Release: `release-27f1c7abe0f8-20261005111558`.
- Application source: `27f1c7abe0f8863b68334e184e0a167774848168`.
- Tree: `64cd553bdc386ce6fdfe9a3780941a965d72e58c`.
- Manifest SHA-256: `e7463cf4cb8d6c636ac4d7fcca4a6a114fe6b4da6c768a78093abee67ac56786`.
- Archive SHA-256: `568208beee78557c4ed493719fc97ddbd1f8d2099269174ab1db1706ee25615f`; 1,149,048,100 bytes.
- Host payload SHA-256: `39874e9f6ce03a277f6387365905159c7a3985681684e4a91a82dc8ee8147c80`.
- PostgreSQL schema: 16; migration checksum `16ee0461d142e26db0cae6d4cc66f6e87347ea33a0776c9ff9f6243e54c34967`.
- SQLite compatibility: 22; all 20 required named migrations and applied-order maximum 20 verified.

| Artifact        | Tested image identity                                                     | Configuration digest                                                      |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Host            | `sha256:0a94145aee624b07967b25756ef0fdbada9cb7e0f6435c6075083d29d45f4308` | `sha256:e30a5f1a2f227a9e8867e3d7501c2b87455882a143ebca347e647505ef9663d3` |
| Standard worker | `sha256:6d3cd8c51eb8f887e577abb8155890818ce2b3511a19731bec37cf773289d9b4` | `sha256:8af3d598f1bfaec4719ebb7ab3bd4859309fe8bb9eac7431a9110dc64d22a33d` |
| Document worker | `sha256:519fb0d2e501dfb368abbf81dbdbd41279d5a6b30a9545e40d82e83b1e541469` | `sha256:bf8ff32466f982e316b9dc7dc7fb031b007b6f6996e2a1747ff8d8015fe6c0f4` |

Receipt documentation committed afterwards is distinct from this tested
application source. A human merge requires a fresh release identified with the
actual merged commit, with local tests and accepted Pi deployment before S10.

## Red, green and release checks

The targeted red run passed the in-flight/readback case and failed the verified
overlap case: it returned pending instead of the required terminal denial.
The corrected complete action integration suite passed 32 tests without failures
or skips. It verifies one blocked receipt and no request-start or second create,
terminal private-notice availability, removal from queue discovery, adjacent
slot execution and retained uncertain-effect readback.

All seven fresh local release gates passed. Root checks passed 2,550 tests,
typechecking, build, formatting and lint with zero errors and 321 warnings.
Runner checks passed 209 tests. Cumulative source contracts passed 316 tests
without failures or skips; the native calendar demonstration passed ten checks.
Both exact final Linux/ARM64 host/worker pairs passed all 316 packaged contracts,
209 runner tests, seven native/RPC cases and seven offline subscription scenarios
each. Their packaged contract runs took 486,555.203889 and 482,381.110302 ms.
Final image tests used baked application code without checkout-source overrides.
The correction's GitHub CI also passed.

Tests selected only the separate protected external test database, with
authenticated, verified TLS. Provider, model and message transports were
synthetic. No whole environment file or administrative credentials entered workers.

## Actual Pi acceptance and recovery

The Pi fetched the exact clean detached source and verified the transferred
archive, images and prebuilt payload. All seven deployment phases and six health
stages passed at `2026-10-05T11:59:56.853Z`. Both actual Pi profiles passed
209 runner tests, seven native/RPC checks and seven subscription scenarios each.
Specialist isolation and exact child stop preserved the sibling. Compiled offline
calendar-action and clock-recovery probes passed. No Pi build, dependency
installation or source repair occurred.

All 694 original and 696 current-backup messages across 18 session databases were
preserved, with none missing or changed. Three approved records, full proposal
rows, main context, continuation, ten replies, policy and ten charged attempts
were unchanged. Primary Codex login and service-environment seals matched fresh
pre-deployment snapshots. CoS remains paused.

The Pi-owned independence probe passed from `2026-10-05T12:07:18.006Z` to
`2026-10-05T12:09:26.850Z`, after the scheduling SSH connection closed and while
the Mac development container was stopped. Both profiles and compiled probes
passed; the service remained active. The Mac container was restored. Physical
Mac power-off was not tested.

The paired backup covers 19 native databases, with digest
`35c2613e58b88b6d73202507569665a401099085c9754233f3e53992bc5b7e88`.
Independent journal ownership, immutable action privileges and read-only runtime
access to writer consent passed. The preceding S09 release
`release-9a1b25b88419-20261005100038` supports schema 16; all three images, its
payload and clean pinned source remain verified and available for compatible
recovery. The accepted S08 artifacts remain retained but are ineligible at schema 16. No rollback, schema reset or old live SQLite restore ran.

Before transfer, two unused schema-incompatible historical host carrier caches
(`f6e7f02f6dc4`, `d8f91982647b`) and the duplicate initial S09 transport archive
were retired after complete Mac archive/configuration verification. Free space
rose to 5,586,522,112 bytes, above the unchanged 5,133,063,312-byte staging guard.
All payloads, worker images, active/compatible recovery images, containers,
volumes, sources, receipts, backups, data, sessions and credentials were retained.
The service was unchanged by retirement.

## Remaining gates

The live action and mandate tables remain empty. No writer profile/binding,
production restore proof, team admission or mission delegation is configured.
Writer admission remains disabled. Live account consent, protected writer
storage, selected owned test calendar, production paired-backup/separate-test
restore proof and a separately approved calendar test remain pending.
This correction made zero real OAuth requests, live model calls, real messages
or real calendar writes. The Pi lifecycle remains `implementation_disposable`.
Human review/merge and acceptance of the actual merged release gate S10.
