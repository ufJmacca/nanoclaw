# Mac development → tested release images → Raspberry Pi runtime

**Contract:** `cos-delivery/mac-to-pi-v2`  
**Plan revision:** 5.  
**Applies to:** S01–S11; introduce the first complete release path in S01, regress it thereafter.  
**Status:** implementation requirements. No build, SSH connection or deployment has been performed by preparing this document.

## 1. Fixed responsibilities

| Location | Owns | Must not do |
|---|---|---|
| Developer's Mac | Git checkout/worktrees, coding goal and ledger, source edits, dependency installation, tests, Linux/ARM64 image builds, release creation, authenticated transfer and deployment coordination. | Run the live Pi bot identity, use Pi SQLite as a test store, publish untested artifacts or silently build through a Pi Docker context. |
| Raspberry Pi | Existing NanoClaw runtime and Docker daemon, channel connections, coordinator/workers, local SQLite/artifacts, runtime secrets, target deployment/lifecycle records, explicit migration execution and smoke checks. | Run the implementation coding session, edit source as a fix, compile/install application dependencies, build images or pull mutable application tags to recover. |
| Existing separate LAN database machine | External PostgreSQL service for CoS records, and optionally a distinct test database. | Be provisioned, restarted or otherwise administered by these slices. |

The deployed CoS continues running when the Mac is off. No runtime callback to the Mac, Mac-mounted code, developer SSH tunnel or active coding session may be required for normal CoS operation. S01 verifies the Pi uses a compatible 64-bit Linux userspace and `linux/arm64` Docker platform. Do not infer this from the model of Raspberry Pi. A 32-bit installation is a documented blocker, not permission for an OS reinstall.

Native Mac tests are the fast feedback loop. Final release tests also run the actual Linux/ARM64 artifacts in the Mac's local Docker engine. An Intel Mac can use configured local emulation; record that fact and do not silently select the Pi as a remote builder. Missing or incompatible local tooling is a real prerequisite, not grounds to skip local tests.

## 2. Why copying the current agent image is insufficient

At the inspected reference commit, `container/Dockerfile` explicitly omits runner source. `src/container-runner.ts` mounts runner code, skills, common instructions and the research workflow from host paths. The host module itself executes outside that worker image. The same runner also has a per-group image-build path. These are observations from code, not assumptions about the installed Pi [D01–D03].

Therefore a correct release must include **the matching host application and agent images** and eliminate untracked code overrides on the deployed path. An agent-image-only transfer would not deploy CoS host-module changes, and a stale host mount could override newly baked runner code.

### Selected initial packaging

Keep the existing **host-managed NanoClaw service** and its service manager. Do not introduce Docker-in-Docker or move the host orchestrator into a privileged container merely to make delivery image-shaped.

Build two versioned image artifact types on the Mac:

1. **Host-release carrier image**: contains a prebuilt Linux/ARM64 payload under a documented `/release` path: the host application, target-native dependencies, a compatible Node runtime, SQL/session migrations, required runtime metadata and packaged scripts/assets. On the Pi, load this image, create a stopped temporary container and copy its payload to a versioned release directory. Never start that temporary container or give it secrets, data mounts or the Docker socket. The existing service runs the extracted, prebuilt payload. This is an image-distributed host release, not a containerised host daemon.
2. **Agent release image(s)**: contain the runner source/bundle, locked dependencies, selected provider runtime(s), instructions, skills and required research workflow code. Produce additional profiles only when required by actual approved configuration. Containers use only the matching release images already loaded on the Pi.

The carrier, workers and pinned GitHub source reference belong to one release manifest. [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) permits fetch and detached source checkouts on the Pi; neither operation changes the active release or supplies executable code overrides. The target never performs `pnpm install`, `npm install`, `bun install`, compilation, `git pull` or `docker build` to finish a release. Include target-native dependencies built inside Linux/ARM64 build stages; do not copy macOS `node_modules` or Darwin executables. Verify the extracted host payload against the Pi's discovered libc, dynamic-library and runtime requirements. Block an incompatible release rather than upgrade the Pi OS or install libraries automatically. A different packaging architecture needs a recorded design change, not a silent fallback.

## 3. Release and development modes

Add a narrow, host-controlled release mode, preserving the existing source-mounted workflow for isolated Mac development where appropriate.

In Pi release mode:

- Code, MCP modules, instructions and skill implementations come from the loaded, recorded images or the immutable extracted host release. Do not bind old checkout source over `/app/src`, `/app/skills`, common instructions or the packaged research workflow.
- Audit every current shared-code mount; include the required content in the appropriate image. Preserving a read-only mount of **data/configuration** is different from overriding release code. Provider state, group working memory and session DB ownership remain as specified by the security contracts.
- Host-side discovery/composition uses metadata shipped in the host release, with compatible copies/hashes for worker assets. A missing asset must fail clearly, never be silently fetched from a working checkout.
- Map each approved provider/package profile to an image identity in the release manifest. New mission groups reuse immutable profiles; fresh group IDs must not cause image builds.
- Disable the per-agent package/image build path in release mode. An unavailable profile is `image_unavailable`/blocked. Existing non-CoS groups can keep explicitly inventoried preloaded images; a changed dependency profile must be built/tested on the Mac and delivered. Do not silently disable an existing group or substitute another provider.
- Verify effective image identities before a wake. No mutable `latest` deployment, implicit registry pull, package installation, or self-update of release code. Runtime CoS agents cannot author a release or alter this policy.

Before the first cutover, inventory the existing service, static paths, provider profiles and required images using redacted metadata. Prove ordinary NanoClaw behaviour still works in the release packaging. Preserve the previous service invocation and code for a compatible first-cutover rollback.

## 4. Mac test environment and database access

Use separate fixture roots for the Mac's local SQLite, agent workspaces and artifacts. Never synchronise these roots to the Pi. Default local tests disable all real messaging adapters, native production schedules, account connectors and paid models; use deterministic substitutes through the real interfaces. Test doubles do not replace the database/transport vertical flow.

Database-dependent local tests still connect to the **external** PostgreSQL machine:

**Preferred:** provision `COS_TEST_PG*` in the Mac test process for a separate test database on the same LAN server. Keep its protected target-marker check. This allows local development while Pi CoS continues running. The database administrator supplies network access and credentials; the agent does not open ports or expose the server publicly.

**Permitted during the disposable period:** explicitly select `runtime-disposable` against the configured CoS database. Supply the needed database client configuration securely to the Mac test process; do not extract the Pi's secret environment through SSH or copy a production `.env` into the repo. The Mac coordinates with the Pi's narrow trusted deployment helper to establish the existing target binding, verify the **Pi's** lifecycle record, quiesce/fence CoS and acquire the exclusive target lease before local integration tests touch that database. The tests execute on the Mac, not on the Pi. Keep local fixture SQLite/artifacts isolated. This is not a silent profile fallback.

If tests temporarily move the shared schema beyond the running release's compatibility range, keep Pi CoS paused until a tested candidate is deployed or a verified compatible disposable schema is restored. A failing local suite must not trigger deployment just to reopen the service. Ordinary unrelated NanoClaw functionality remains available where the existing service permits. Do not claim a different fixture `scope_id` prevents migration conflicts.

For the first S01 shared-target test, use the existing Pi service/locking facilities through fixed, validated SSH maintenance operations to establish quiescence; no new application image needs to be shipped before local tests. If CoS is not yet installed, verify absence of a CoS writer rather than assuming it. These narrow maintenance operations are not remote source development. If the existing facilities cannot prove exclusive access, shared-target testing is blocked until a separate admitted test target is supplied or a safe maintenance procedure is established.

The Pi's lifecycle/maintenance latch lives outside the disposable DB. A local advisory lock on the Mac alone is insufficient to stop an independently running Pi. Reconcile a crashed test runner using a durable target receipt and lease generation; do not automatically resume Pi CoS while test/migration state is uncertain. Missing Pi contact blocks shared-runtime tests; use a separately admitted test target instead if available.

After the programme closes disposal, runtime-disposable tests are refused. Further destructive testing requires the separate external test target. No local PostgreSQL server is added on either Mac or Pi.

## 5. Local verification and release construction

Implement the following as **new command contracts**, not currently existing commands:

```text
pnpm cos:release --slice S01 --target pi --db-profile test
pnpm cos:release --slice S01 --target pi --db-profile runtime-disposable
pnpm cos:deploy --target pi --release-manifest <path-to-tested-manifest>
pnpm cos:deploy status --target pi
pnpm cos:deploy rollback --target pi --release-id <known-compatible-release>
```

`cos:release` runs on the Mac and orchestrates, in order:

1. Check applicable instructions, Git state, existing work, target fingerprint and an exclusive Mac goal/release lock. Make a clean, explicitly identified candidate commit without discarding unrelated dirty work. Never label mixed/uncommitted content as the HEAD commit.
2. Verify the builder belongs to the Mac's local Docker engine. Explicitly target `linux/arm64`; inspect engine/context and builder endpoints so `DOCKER_HOST`, a remote context or a multi-node builder cannot move the build onto the Pi.
3. Run TDD behaviour tests, root/runner regressions and the current slice's full fixture flow locally. Record actual results. When using the shared disposable target, apply the coordination in section 4.
4. Build the host-release and required worker images from that same recorded source. Use lockfiles, explicitly pinned build inputs and `.dockerignore`/allowlisted contexts excluding secrets, Git credentials, state, private attachments, test databases, logs and SSH material. Build processes get no runtime database or account credentials.
5. Test the **final image identities** in the Mac's Linux/ARM64 container environment without source bind mounts. Verify host payload execution/native modules, worker startup, asset discovery, RPC, DB ownership and the applicable slice demonstration. Test trusted host orchestration against the local Docker engine with isolated daemon-visible paths. Never give worker containers the Docker socket. Validate architecture-specific executables for the selected providers. Emulated tests are labelled honestly.
6. Export only those tested images, generate checksums and a complete release manifest, and mark the release transferable only after all required local evidence is satisfied. Testing one build and rebuilding another for delivery is prohibited.
7. Ensure the exact tested source commit is pushed to this fork. Fetch and verify its commit/tree on the Pi using the pinned-source contract, then transfer and execute the target deployment cycle. Record Pi-native smoke evidence separately from Mac tests. A Linux container on the Mac does not prove the Pi's kernel/filesystem/network isolation behaviour.

A fixture-only first smoke test must be possible even when real provider/account credentials are absent. Later live smoke tests use only separately authorised account/model/channel access.

## 6. Release bundle, identity and transfer

Default transfer: **image archive over SSH/SCP to the Pi**, not a container registry. A registry can be a later optimisation; it is not a new dependency.

A proposed release directory is:

```text
release-<commit>-<build-id>/
  images.tar.gz                 # docker save of the exact tested image identities
  release.json                  # source, image IDs, platform, compatibility, test receipts
  SHA256SUMS                    # archive and metadata checksums
  evidence/local-tests.json     # sanitised actual evidence, no invented output
```

Manifest fields include release ID, source_repository, source_commit, source_tree, source_fetch_ref, source_sync_contract, build-input digest, `linux/arm64`, each image's tag and **Docker image configuration ID**, host payload digest, worker profile/asset hashes, tests and their timestamps, CoS RPC version, supported PostgreSQL/SQLite schema ranges, migration checksums, and permitted previous-release compatibility. Do not conflate a Docker image ID with a registry manifest digest. A save/load transfer does not require a populated `RepoDigests` list. Inspect the loaded IDs and payload hashes; a tag alone is not evidence.

Use a preconfigured SSH alias and verified host key. Reject unknown/changed host keys, an unexpected target machine or the Mac itself. Do not disable host-key checking, start a build daemon on the Pi, or expose a Docker TCP API. Use existing deploy-account permissions; Docker-daemon access is trusted host-level authority and never delegated to a CoS worker. Missing credentials or privileges are technical blockers, not justification for granting unrestricted sudo.

Transfer to a versioned **staging** directory. Bound and validate path components, reject traversal/symlinks in metadata and allow only manifest-declared artifacts. Verify checksums before load/activation. SSH transport plus the pinned target authenticates the route; checksums detect changed artifacts but are not independently a signature. Do not claim signed releases unless signing is actually implemented. Interrupted transfer can retry into the same staging identity; partial bundles never activate.

## 7. Automatic deployment on the Pi

The coding goal stays on the Mac. A narrowly scoped, versioned target-side helper performs only the pre-authorised operational steps. Its first installation is an in-scope tested deployment, not a request for extra human approval. Bootstrap that helper from a hashed, tested release artifact and a recorded target binding; do not run an unrelated installer from the internet.

1. Verify the tested manifest, target identity/platform, free disk, required loaded legacy images, target secret **presence**, and active release/schema state. Read-only target preflight can precede local tests; transferring candidate application images and deployment follow passed local gates.
2. Fetch/verify the manifest-pinned source from this fork into a separate clean detached worktree, preserving the active checkout. Stage, checksum and `docker image load` the archive without disturbing the active release. Inspect all loaded image IDs/platforms. Extract the host payload from a stopped carrier container into a new versioned release directory. Validate payload hashes and compatible runtime/ABI without starting the live application.
3. Acquire an independent **Pi-side deployment lock** and the required cross-host database maintenance lease. Close admissions and drain the affected workload using the existing shutdown semantics. Back up protected NanoClaw SQLite consistently, with associated manifests, configuration and state references. Never copy an active SQLite file while ignoring WAL/journals.
4. Invoke the packaged migration tool explicitly on the Pi with the Pi's runtime target and **separately scoped migration environment**. It must not rely on SSH inheriting a systemd service's environment. Use the actual service manager's secure environment injection or an existing protected launcher, without printing values. No DDL in ordinary daemon startup and no database credentials in release images.
5. Activate the prebuilt host payload and the matching worker-image map as one release. Preserve existing runtime data roots, service identity, credentials and configuration. Repoint the service only to immutable packaged code, using explicit stable data-root configuration. Verify resolved paths: existing NanoClaw uses working-directory-relative paths, so a code-directory swap must not silently point the service at empty databases or a new groups directory. No recursive rsync of the Mac repository/state into the deployment.
6. Restart the identified service using its actual existing manager. Confirm one active bot/host instance, exact release identities, remote schema health, legacy readiness and a Pi-native fixture worker/RPC round trip. For S05 onward, confirm effective isolation on the real Pi; do not substitute Mac results.
7. Reopen eligible work only after health succeeds and maintenance/test state is reconciled. Record a receipt on the Pi and copy only its redacted summary to the Mac ledger. If SSH disconnects, query the target receipt by release ID; do not blindly rerun migration/activation.
8. On failure, keep unsafe CoS admission closed and select the last **schema-compatible** recorded release. Rollback is not permission to restore old live SQLite over newer messages. Retain already-applied compatible migrations or roll forward; a destructive CoS reset is allowed only under the disposable contract and never as a generic rollback. Preserve the previous known-good images and payload until a later healthy release; no blanket Docker prune/volume deletion.

After human merge, reconcile the actual merged commit/tree. When source identity differs, build and test a release identified with that merged commit on the Mac, verify matching Pi source, and transfer it; do not relabel old images as having been built from the merge. Do not rebuild the same tagged image on the Pi. Deployments/migrations remain pre-authorised; human PR merge remains the next-slice dependency gate.

## 8. Secrets and target configuration

[DEPLOYMENT_ENV.example](DEPLOYMENT_ENV.example) contains non-secret placeholder variable names for the Mac release coordinator. Real SSH identity paths, endpoints and remote directories belong in an ignored private target file/environment, not Git or model-readable logs.

Pi runtime database and connector credentials stay in the Pi host service's environment. Mac tests use their own securely supplied test client profile, even when the DBA intentionally grants access to the same disposable database. Never fetch or dump the Pi environment as a shortcut. Database migration credentials are injected only into the selected trusted admin process. No target secret appears in a Dockerfile ARG/ENV, build context, image history, archive, PR, worker container or copied evidence.

Mac build/test tooling must strip secrets from child processes that do not need them. The goal's administrative SSH capability never becomes a CoS tool. Ordinary CoS operation has no reason to know the Mac's SSH alias or deployment key.

## 9. Required delivery tests

Introduce in S01 and regress where affected:

| ID | Behaviour |
|---|---|
| S01-REL01 | Failed/incomplete local mandatory checks prevent image transfer and deployment. |
| S01-REL02 | Builder/context validation rejects a Pi/remote Docker endpoint; build output is verified Linux/ARM64. |
| S01-REL03 | Final host and worker images execute locally without checkout-source mounts, and include required code/skills/workflow assets. |
| S01-REL04 | Mac-native modules, secret files, live databases and SSH material are absent from the release payload. |
| S01-REL05 | Archive/image-ID/host-payload mismatch or incomplete transfer cannot activate. |
| S01-REL06 | Target execution performs no dependency installation, source edit, git pull, image build or mutable-tag pull. |
| S01-REL07 | Release switching preserves existing data roots, SQLite ownership, provider sessions and unrelated groups. |
| S01-REL08 | Wrong SSH target/key, incompatible platform/runtime, missing permissions and disk failure stop safely. |
| S01-REL09 | Connection loss after target activation reconciles the same release receipt, without repeating unknown effects. |
| S01-REL10 | Shared disposable-db local tests require Pi quiescence/target lease; lost Mac runner cannot cause unsafe Pi resume. |
| S01-REL11 | Failed target health selects only a schema-compatible prior release, never blind data restore/prune. |
| S01-REL12 | Stopping the Mac leaves the deployed Pi operating independently; no Mac code mount/tunnel remains. |

S11 adds final-release, retention, protected-lifecycle and cross-host disaster-recovery replay. Every slice receipt records native Mac tests, Linux/ARM64 image tests, image IDs, bundle digest, target migration/release ID, Pi-native smoke results and any genuinely blocked live activation.

## 10. Primary evidence and implementation references

- **D01:** [inspected agent Dockerfile](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/container/Dockerfile): source omitted from current image; source bind mounts are expected.
- **D02:** [inspected container runner](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/container-runner.ts): shared-code mounts, per-group image builds and provider/runtime paths.
- **D03:** [inspected root package](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/package.json): TypeScript host scripts and native SQLite dependency.
- **D04:** [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/): explicit architecture targets, local emulation and its limitations.
- **D05:** [Docker image save](https://docs.docker.com/reference/cli/docker/image/save/) and [load](https://docs.docker.com/reference/cli/docker/image/load/): archive transport for images and tags.
- **D06:** [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/): mounts refer to daemon-host paths and can obscure image content. Validate paths against the actual Mac and Pi daemons.

Revalidate APIs and installed versions during implementation. Documentation evidence is not a claim that either machine has been inspected or that the proposed delivery commands already exist.

## Revision 5 source-synchronisation gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) and tests S01-REL13–S01-REL18 alongside the existing gates. The Pi may fetch and retain pinned source using read-only GitHub access. The fetched tree never replaces prebuilt release payloads, triggers deployments, installs dependencies or overrides image code. Record source-push/source-sync outcomes and the verified commit/tree in every slice/release receipt.
