# Mac development → tested images → Raspberry Pi runtime

**Contract:** `cos-delivery/mac-to-pi-v2`  
**Plan revision:** 5. **Applies to:** S01–S11. **Status:** requirements, not an installed build or deployment utility.

## 1. Responsibilities

| Location | Owns | Must not do |
|---|---|---|
| Mac | Checkout/worktrees, coding goal/ledger, edits, dependency installation, tests, local Linux/ARM64 builds, source push and release coordination. | Run Pi bot identity, use Pi SQLite as fixtures, transfer untested artifacts or silently use a Pi/remote builder. |
| Pi | Existing NanoClaw service/Docker, live channels, agents, local runtime data/secrets, target/lifecycle receipts, migrations, verified source fetch and native smoke. | Source fixes, coding goal, application dependency install, compilation, image build or mutable application pulls. |
| Separate LAN server | Existing PostgreSQL and optional test/restore DBs. | Be installed/upgraded/restarted/administered by these slices. |

Pi must work with Mac off, without Mac code mounts, callback, active coding session or SSH tunnel. S01 verifies actual 64-bit Linux userspace, Docker platform, libc/runtime compatibility and existing service paths; do not infer these from Pi hardware. A 32-bit or incompatible installation is a blocker, not permission to reinstall OS.

Native Mac tests provide fast feedback. Final release tests run actual Linux/ARM64 artifacts in Mac-local Docker. Intel emulation is allowed when configured and recorded; never substitute Pi as builder. Inspect context, DOCKER_HOST and all Buildx nodes. Missing tooling is a real prerequisite, not waived testing.

## 2. Existing-code constraint and selected packaging

At the historical inspected commit, container/Dockerfile omits agent-runner source, container-runner mounts code/skills/instructions/research workflow from host, and per-group image builds can occur. Copying that worker image alone does not ship CoS host code or new runner source. See REPOSITORY_BASELINE.md and revalidate actual checkout.

Keep existing host-managed service rather than introducing Docker-in-Docker or privileged host-container migration. Build two artifact types on Mac:

1. Host-release carrier image: prebuilt Linux/ARM64 payload at documented `/release`, including host application, target-native dependencies, compatible Node executable, migration tools and required metadata/scripts/assets. Pi loads, creates a stopped temporary container and extracts into a versioned release directory. Never start that carrier with secrets/data/socket. Existing service executes the extracted payload.
2. Agent release images: runner code/bundle, locked dependencies, selected providers, skills/instructions and workflow assets baked into image. Extra profiles only for actual approved config; fresh mission groups reuse a recorded immutable profile.

Carrier, workers and pinned source belong to one manifest. Pi never runs pnpm/npm/bun install, compile or docker build to finish release. No Darwin executables/macOS node_modules in payload. Check native ABI/shared libraries against discovered Pi; do not install OS packages as a hidden fix. A different packaging architecture requires a recorded design decision.

## 3. Development mode versus release mode

Preserve isolated source-mounted Mac development. Pi release mode must:

- Use recorded prebuilt code/assets, not checkout overrides at /app/src, /app/skills, common instructions or research workflow paths. Audit every code mount. Data/config mounts remain separate and follow security contracts.
- Ship host metadata for discovery/composition with matching worker asset hashes. Missing assets fail, never fall back to a working checkout.
- Resolve provider/package profiles to preloaded verified image IDs. No per-new-group builds. Disable runtime dependency/image build paths; unavailable profiles report image_unavailable. Inventory legacy groups and keep required explicit existing images; do not silently change providers or disable groups.
- Prevent mutable latest/implicit pulls/self-update. CoS workers cannot alter release policy or use deployment credentials.

First cutover inventories service, paths, profiles and required images; preserves previous service invocation/code for compatible rollback. Stable data-root configuration must stop code-directory switches from selecting empty SQLite or different groups directories.

## 4. Database and local tests

Mac tests use isolated SQLite/workspaces/artifacts and fixture channels/models/connectors. Never transfer fixture state to Pi or consume the Pi live bot token. A separately approved real test bot must have distinct credentials/channel.

Preferred COS_TEST_PG* targets a separate external DB so Pi continues running. During implementation explicit runtime-disposable may target CoS DB only with Mac-supplied client env, current Pi-owned lifecycle/binding, Pi CoS quiescence/fencing and cross-host target lease. Do not extract Pi secrets. Tests run on Mac. Different scope IDs do not isolate schema changes.

Keep Pi CoS paused when tests move schema outside the active release range until compatibility is restored or a locally passing candidate is deployed. Never deploy a failing candidate to reopen shared DB. Mac filesystem lock alone is insufficient. Lost runner/SSH requires durable target receipt/lease recovery before resume; uncertainty stays closed.

First S01 shared-target tests may use validated existing Pi service/locking maintenance steps before the new helper is shipped; prove no CoS writer rather than assume absence. Without safe exclusion use separately admitted test DB or record blocker. After lifecycle protection closes, destructive runtime-disposable tests are refused. No local PostgreSQL server is added.

## 5. Mac release command

S01 introduces these new contracts:

```text
pnpm cos:release --slice S01 --target pi --db-profile test
pnpm cos:release --slice S01 --target pi --db-profile runtime-disposable
pnpm cos:deploy --target pi --release-manifest <tested-manifest>
pnpm cos:deploy status --target pi
pnpm cos:deploy rollback --target pi --release-id <compatible-release>
```

Release sequence:

1. Inspect instructions/Git/existing work/target and acquire Mac goal/release lock. Make a clean identified candidate without discarding other changes; mixed content is not HEAD.
2. Validate Mac-local builder/context/nodes and explicit linux/arm64.
3. Run actual TDD behaviour, root/runner regressions and slice fixture flow locally, coordinating shared DB when selected.
4. Build same source with lockfiles and deliberately pinned inputs. Allowlist contexts/dockerignore excluding secrets, Git auth, runtime/fixture DBs, logs, attachments and SSH material. Build processes receive no runtime account/DB credentials.
5. Test final image identities locally with no checkout overrides: host payload/native modules, workers, asset discovery, RPC/database ownership and applicable slice demonstration. Trusted host-orchestrator test may use local Docker with isolated daemon-visible paths; never give socket to workers. Test selected provider ARM64 binaries and label emulation accurately.
6. Export exactly those tested identities. No rebuild between tested image and transfer. Write hashes/manifest/evidence; only passing releases are transferable.
7. Push exact source to the fork; Pi fetch/verifies exact commit/tree in a separate detached source worktree under GITHUB_SOURCE_SYNC.md. Source sync is not activation. Transfer and run target cycle; Pi-native results are separate from Mac container tests.

Fixture/no-send testing must work without live provider/account credentials. Paid models/real messages require separately satisfied authority.

## 6. Artifact identity and transport

Default is SSH/SCP image archive, no registry prerequisite:

```text
release-<commit>-<build-id>/
  images.tar.gz
  release.json
  SHA256SUMS
  evidence/local-tests.json
```

Manifest: release ID; pinned fork/source_commit/source_tree/source_fetch_ref/source_sync_contract; build-input digest; platform; each image tag and actual Docker configuration ID; host payload digest; profile/assets hashes; real tests/times; RPC and supported PostgreSQL/SQLite schema ranges; migration checksums; previous-release compatibility. Image ID is not registry manifest digest; save/load may have no RepoDigests. A tag or commit-like name alone proves nothing.

Verified SSH host key/alias and target binding are mandatory. Reject unexpected/changed key, wrong machine, Mac target or traversal/symlink staging paths. No disabling verification, Docker TCP exposure, unrestricted sudo or new privileges. Existing Docker access is trusted host authority, not worker capability.

Stage manifest-declared artifacts in a versioned directory, validate sizes/hashes/path bounds before load. Retry interrupted copy under same ID; partial bundles never activate. SSH authenticates route; checksums detect alteration but are not signatures. Do not claim signing unless implemented.

## 7. Pi target transaction

Coding goal stays on Mac. A versioned narrow target helper performs only existing authorised operations. First helper installation is a tested hashed release artifact through existing access, not an unrelated internet installer.

1. Verify target/platform/service, free disk, legacy profiles, runtime secret presence, current release/schema and local test manifest. Read-only preflight may precede tests; candidate image transfer may not.
2. Fetch/verify exact fork commit/tree and separate clean detached source checkout without changing active checkout. Then verify/load archive, inspect loaded IDs/platforms and extract carrier from a stopped container. Validate hashes/ABI without starting live app.
3. Acquire Pi deployment lock and required DB maintenance lease; close/drain affected work. Back up protected local SQLite consistently with journals/WAL and associated binding/state manifest.
4. Invoke packaged migration explicitly using Pi-scoped migration environment via actual existing manager/protected launcher. SSH does not inherit service environment. No normal-startup DDL or migration secrets in daemon/image.
5. Activate host payload and matching worker map as one release. Preserve runtime roots/service identity/env. Verify resolved working-directory-relative paths. No recursive Mac repo/state rsync, empty replacement DBs or execution from fetched source.
6. Restart actual existing service. Verify one host/bot instance, exact source/payload/images, schema, legacy readiness and native fixture worker/RPC. S05 onward prove actual Pi isolation, not just Mac results.
7. Reopen only after health and maintenance/test reconciliation. Persist Pi receipt outside disposable DB and copy redacted summary to Mac. SSH uncertainty queries same release ID, not repeated unknown steps.
8. On failure keep unsafe admission closed and choose last schema-compatible recorded payload/images. No old SQLite over new messages, indiscriminate queue reset or blanket Docker prune. Keep compatible migrations or repair forward. Scoped disposable reset is exceptional under its contract, never generic rollback. Retain known-good artifacts.

After human merge, reconcile merged commit/tree. When source identity changes, build/test a release identified with that merge on Mac, verify matching Pi source and redeploy; do not relabel older images. Human merge still gates the next slice; operations retain standing approval.

## 8. Credentials, receipts and tests

DEPLOYMENT_ENV.example is placeholder-only. Private endpoints/keys/directories belong to protected ignored target config, not model-readable dumps or Git. Pi runtime/admin env stays on Pi; Mac tests use separately supplied credentials. Safe child env allowlists strip secrets from builders/providers/workers. CoS has no Mac SSH capability. Deployed runtime depends on neither Mac nor GitHub availability.

| ID | S01 behaviour, regressed thereafter |
|---|---|
| S01-REL01 | Failed/incomplete mandatory local checks prevent image transfer/deploy. |
| S01-REL02 | Remote/Pi builder rejected; output verified Linux/ARM64. |
| S01-REL03 | Final host/worker images execute without source mounts and include required assets. |
| S01-REL04 | Darwin modules, secret files, runtime data and SSH material absent from artifacts. |
| S01-REL05 | Archive/image/payload mismatch or incomplete transfer prevents activation. |
| S01-REL06 | Pi performs no dependency install/source fix/git pull/image build/mutable pull. |
| S01-REL07 | Release switch preserves data roots/SQLite ownership/provider state/unrelated groups. |
| S01-REL08 | Wrong key/target/platform/permission/disk failure stops safely. |
| S01-REL09 | Lost connection after activation reconciles same receipt and unknown effects. |
| S01-REL10 | Shared-target tests require Pi lease/quiescence; lost Mac cannot cause unsafe resume. |
| S01-REL11 | Failed health selects compatible prior code, not blind data restore/prune. |
| S01-REL12 | Mac off leaves healthy Pi independent of code mounts/tunnels. |

Also implement S01-REL13–S01-REL18 from GITHUB_SOURCE_SYNC.md. Each slice records Mac/native image/source sync/transfer/migration/Pi smoke separately; S11 exercises final release/retention/protected lifecycle/disaster recovery. Shared execution rules define the complete handover.

## References

Historical source: [Dockerfile](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/container/Dockerfile), [container runner](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/container-runner.ts), [package](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/package.json). Implementation references: [Docker multi-platform](https://docs.docker.com/build/building/multi-platform/), [save](https://docs.docker.com/reference/cli/docker/image/save/), [load](https://docs.docker.com/reference/cli/docker/image/load/), [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/). Revalidate actual versions/target; these plans do not claim a machine was inspected live.
