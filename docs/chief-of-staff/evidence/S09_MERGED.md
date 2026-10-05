# S09 — actual reviewed merge accepted; live writer pending

The repository owner merged [PR #66](https://github.com/ufJmacca/nanoclaw/pull/66)
at `2026-10-05T21:56:36Z`. Actual merge
`60ad9d5dd08d4dd4a64377745ad49a4cc22254fe` has the same tree as reviewed head
`457bfae6bd3c154747daf498e6ceb6f0d6caf084`. A fresh release was built and tested
from the actual merge, then deployed and accepted on the Pi. No earlier image
was relabelled. S10 fixture implementation is eligible; the S01–S11 programme
remains incomplete.

The initial implementation and actual overlap correction retain their red →
green evidence in [S09](S09.md) and [the review correction](S09_REVIEW_CORRECTION.md).
The corrected flow settles a never-started calendar action blocked by an already
verified overlapping block. It retains pending handling for executing or
uncertain competitors and readback of the original started effect.

## Exact accepted identity

Plan revision 5, `cos-postgres/external-env-v3` and
`cos-source-sync/github-pinned-v1` apply. Source push and Pi source sync are
verified. The Pi retains the matching clean detached source checkout.

- Release: `release-60ad9d5dd08d-20261005215838`.
- Source: `60ad9d5dd08d4dd4a64377745ad49a4cc22254fe`.
- Tree: `c6b2fdb5c1eb4069f32b79443aab931f07d19932`.
- Source ref: `refs/heads/codex/s09-merged-calendar-actions`.
- Manifest SHA-256: `e0e9e0b6137664321ea333984047f4778288e47f8b981dab71e940bcc312329a`.
- Archive SHA-256: `592e5c7b7b6756c7f1ecd3bd5ba031a108d4b020118f3fcdc50a2300cabd3e02`; 1,149,048,340 bytes.
- Host payload SHA-256: `c383bf35c162162de775026bb332146919b51275e51b40810912e1b4afd235b2`.
- PostgreSQL schema: 16; migration 16 remains `16ee0461d142e26db0cae6d4cc66f6e87347ea33a0776c9ff9f6243e54c34967`.
- SQLite compatibility: 22; all 20 required named migrations and applied-order maximum 20 verified.

| Artifact        | Tested image identity                                                     | Configuration digest                                                      |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Host            | `sha256:bc81e4ad4f991436b3fc5d39672ae2b9dfe7ef931520addc1b35b294da4bec88` | `sha256:638cac62ebb11b1eb284ced5e394e3d01cc2c424cad449b578324523cf2ad1a4` |
| Standard worker | `sha256:f4945b8d314b88b619e5a4e1b79d4a0f0bd7d041cc36e2cc7debab37a6a18bfc` | `sha256:a19a84d2efc24d03ef758345f5e9157332475c59f6627cb2bf90c7f99092672a` |
| Document worker | `sha256:06b453bc0322703213354860794917a4dca8305179715466fda45eab4ba82646` | `sha256:5df780116997e6b327636ea443e584b614d5b1808c46cf3d4209bd43ed8dfab3` |

Receipt documentation committed afterwards is distinct from this tested and
deployed application source.

## Local and final-image checks

All seven mandatory local release gates passed. Root checks passed 2,550 tests
in 249 files, typechecking, build, formatting and lint with zero errors and
321 existing warnings. Runner checks passed 209 tests in 28 files and
typechecking. Cumulative source contracts passed 316 tests without failures or
skips in 493,425.442221 ms. The native calendar demonstration passed ten checks.

Both exact final Linux/ARM64 host/worker pairs passed all 316 packaged contracts
without failures or skips, in 514,954.856029 and 475,890.896299 ms. Each worker
also passed 209 runner tests, seven native/RPC cases and seven offline subscription
scenarios. Final tests used baked code without checkout-source overrides. The
compiled offline action probe passed on the exact host image with no database
connections, provider requests, live model calls, real messages or calendar writes.

Tests selected only the separate protected external test database with
authenticated, verified TLS. Only its selected credentials reached trusted test
processes. Worker transports and accounts were synthetic. GitHub CI passed for
the reviewed PR head; merged-source workflows were skipped. The required local
and final-image gates ran anew against the actual merge.

## Actual Pi acceptance

The Pi verified the pinned source, complete archive, all images and extracted
prebuilt payload. All seven deployment phases and six health stages passed;
deployment completed at `2026-10-05T22:43:12.396Z`. Both actual Pi profiles passed
209 runner tests, seven native/RPC checks and seven subscription scenarios each.
Their native/RPC runs took 85,786.195393 and 73,567.283793 ms. Specialist isolation
and exact child stop preserved the sibling. Compiled calendar-action and clock
recovery probes passed. No Pi build, dependency installation or source repair ran.

All 694 original and 696 current-backup messages across 18 session databases were
preserved, with none missing or changed. Three approved records, complete proposal
rows, main conversation/continuation, ten replies, policy and ten charged attempts
were unchanged. Primary Codex login and service-environment seals matched fresh
pre-deployment snapshots. CoS remains paused.

The Pi-owned independence probe passed from `2026-10-05T22:50:18.001Z` to
`2026-10-05T22:52:24.473Z`, after the scheduling SSH connection closed and while
the Mac development container was stopped. Both exact profiles, specialist
isolation/stop checks and compiled probes passed; the service remained active.
The Mac container was restored and verified running. Physical Mac power-off
was not tested.

The paired backup covers 19 native databases, with digest
`1a5060b7ba857a7d15a7a4c2ec386ef7750dfb663c4199788f1f17f7d3df7886`.
Independent journal ownership, immutable action privileges and read-only runtime
access to writer consent passed. The immediately preceding S09 release
`release-27f1c7abe0f8-20261005111558` supports schema 16; its three images, payload
and clean pinned source remain verified and available for compatible recovery.
The earlier schema-16 S09 release and canonical S08 artifacts also remain
retained; S08 is ineligible at schema 16. No rollback, schema reset or old live
SQLite restore ran.

Before transfer, two unused schema-incompatible historical host carrier caches
(`0606b51d1165`, `a72be36a42f5`) and the duplicate preceding S09 transport archive
were retired after complete Mac archive/configuration verification. Free space
rose from 3,453,177,856 to 5,472,665,600 bytes, above the unchanged
5,133,064,272-byte staging guard. All payloads, worker images, active/compatible
recovery images, containers, volumes, sources, receipts, protected backups, data,
sessions and credentials were retained. Retirement did not mutate the service.

## Remaining live and programme gates

All six live action-table counts and eight mandate-table counts remain zero.
Writer profile/binding, production restore proof, team admission and mission
delegation remain unconfigured. Live writer admission is disabled. Protected
writer storage, account consent, an exact owned test calendar, production paired
backup/separate-test restore proof and a separately approved live calendar test
remain pending. The earlier finite model/channel grant is expired and unchanged.

This merged-release acceptance made zero real OAuth requests, live model calls,
real messages or real calendar writes. The Pi lifecycle remains
`implementation_disposable`. S10, S11, their reviewed merges, final release
acceptance and the protected-data transition remain unfinished.
