# S07 merged-source acceptance — technical and operator gates passed

The owner authorised the S07 merge. PR [#62](https://github.com/ufJmacca/nanoclaw/pull/62) merged as `903f5dba9afbc3053eb37dfa634632ebde61daf8`; the test-only calendar correction [#63](https://github.com/ufJmacca/nanoclaw/pull/63) merged under that same S07 authorisation as `a72be36a42f53f38256d47f9b3b18564e27f3f73`. Both reviewed trees match their merge trees. The final source is healthy on the Pi. S07's technical and operator gates pass. The owner rated all four labelled proposals useful, with no false positives identified (count 0), so S08 is eligible. The programme remains incomplete.

- Final source: `a72be36a42f53f38256d47f9b3b18564e27f3f73`; tree: `28569a1e2dd03d0fc68d72cd3c4ba57c59464553`.
- Pi release: `release-a72be36a42f5-20261004004600`; source push/fetch, detached checkout and artifact identities verified.
- All seven local gates passed on this source: 2,287 root tests plus typecheck/build/lint/formatting; 199 runner tests plus typecheck; 247 source contracts; the native synthetic week; 247 packaged-host contracts and 199 runner tests per profile; native isolation and six offline subscription scenarios per profile.
- All seven deployment phases and all six health stages passed. Both Pi-native profiles passed. The Pi-owned independence probe passed after SSH disconnected and the Mac development container stopped; physical Mac power-off was not tested. The development container was restored.
- PostgreSQL remains schema 14, with all fourteen checksums verified. Migration 14 checksum: `530d5647dec1a856e66d38dbaa66b53a3742bfcc169f2199ad810d9f155243f2`. SQLite compatibility level 22 and all 20 required named migrations passed; the maximum applied sequence is 20.
- Separate protected test database, verified TLS and selected credentials only; plan revision 5 and `cos-postgres/external-env-v3`.
- Pi lifecycle is `implementation_disposable`; no runtime reset or protected-data transition occurred.

The failed `903f5dba9afb` release is preserved in [S07 recovery evidence](S07_RECOVERY.md). It was never exported or deployed. The correction candidate `57c67d59f304` passed all local gates but was not deployed; its source identity was not relabelled. The final release was rebuilt and fully tested from the actual `a72be36a42f5` merge.

Archive: 1148563615 bytes, SHA-256 `07a2f2c958a01b7a3bf9ff79ab33f584e9c270c72b5ea6cf24dceec6af90bc98`. Manifest SHA-256: `88bd4385833890ba6c16463a773dffbaea5d5c7ba72baf1dee6aacc0d7bbcc26`. Host payload digest: `0d435026c143f1ec4500b6f155ba97a35dbd42f532a9c9c0a497b3c4ca7a43a0`. Worker-assets digest: `639ef35c28f9d114a2a01bf345833d1c6a879249bfaee7526eff44f16f24f28c`.

| Role / profile                                 | Loaded Docker image ID                                                    | Verified configuration ID                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| host / host                                    | `sha256:b644145bae46c5f34f2b10f9fa34b55778537deda0b2e00255328b013bf1367a` | `sha256:c7acaab6b559139c7c02de76e4dbf1581559f4c50ed7c491dab0245d704222f6` |
| agent / codex-0b43e694a934994cb6ab2dd6a90b1d85 | `sha256:834ec58e889e538818283b38e45efd9d7cb54a871df44e7056d4d28841b39ac5` | `sha256:9febc38ea67d7cdf2a9b52f811f33035c713a0b02bba7f1e84dcfe601b77eeff` |
| agent / codex-b9663cffdc82c3772ac06b2ac1c0c7cb | `sha256:1a5fdc0f6468bf4e3b540bde22572bb7fab24da611cbaab8eee7993c291016ef` | `sha256:0d3759e28a92d1316601e3d29856a5953ac3f8a1e9ec20483ab823d9f3ad57f5` |

These are Docker image identities and independently verified configuration hashes, not registry manifest digests.

All 694 original messages in 18 session databases, three approved records, full existing proposal rows, main conversation/continuation, model policy, ten charged attempts, credentials and service environment were preserved. No old SQLite backup was restored. The retained `release-16f4b142f4f9-20261003101915` payload, all three images and pinned source were verified as schema-14 compatible. Guarded recovery keeps generation/notifications paused and preserves owner dispositions and authorised missions. Schema-13 S06 code remains ineligible after migration 14; its artifacts remain retained.

CoS remains paused. Proactive policy, mission/team admission, knowledge and calendar flags remain unconfigured or disabled. No live model allowance, real account action or real message was enabled. The preserved native conversation's expanded tools have not been tested with live inference; offline guarded tool-refresh recovery passed. Subscription live consent remains expired, with ten of twelve attempts already charged.

The owner's assessment of the labelled [A–D proposal set](S07_PROPOSAL_REVIEW.md) is recorded separately from technical test success and merge approval. A, B, C and D were all rated useful; no false positives were identified (count 0). This clears S07's fixture assessment gate without claiming live-model quality. Later receipt-only commits do not change the tested/deployed source identity above.
