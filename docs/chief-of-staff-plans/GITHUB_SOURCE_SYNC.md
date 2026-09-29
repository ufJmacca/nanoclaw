# GitHub source synchronisation and release identity

**Contract:** `cos-source-sync/github-pinned-v1`  
**Plan revision:** 5.  
**Applies to:** every S01–S11 release; introduce the first complete path in S01.  
**Status:** implementation specification, not an already installed sync or deployment utility.

## 1. Three different things move differently

| Material | Transport and owner |
|---|---|
| Source, plans, migrations and lockfiles | The Mac pushes to `ufJmacca/nanoclaw`; the Pi fetches from that same GitHub repository. |
| Tested Linux/ARM64 host and worker images | The Mac transfers the exact tested image archive and manifest over authenticated SSH. |
| Runtime SQLite, conversations, provider state, secrets and private artifacts | Remain on their existing machines. Never synchronise through Git or the release archive. |

The existing full Git repository on the Pi is a source/history cache, not a second development machine or an automatic deployment trigger. Keep GitHub source synchronisation separate from activation. A fetch may update remote-tracking refs while the current release keeps running unchanged. Neither GitHub nor the Mac must be online for an already activated release to continue operating.

## 2. Pin one source identity to the whole release

The release invariant is:

```text
Pi release source commit/tree
    = Mac tested source commit/tree
    = source commit/tree recorded for the tested host and worker artifacts
```

The manifest additionally records actual Docker image configuration IDs, payload hashes, migration checksums and test evidence. An image tag that contains a commit SHA is not evidence of its contents, and source equality is not proof that an image was tested. Retain the existing artifact identity checks from [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md).

Add `source_repository`, `source_commit`, `source_tree`, `source_fetch_ref` and `source_sync_contract` to the release manifest. `source_commit` and `source_tree` are full Git object IDs. `source_fetch_ref` is a validated reference used to retrieve the objects, not the desired deployment version. The repository identity is pinned to this fork, never selected from model output. Do not put credentials into remote URLs or the manifest.

## 3. Mac authoring and publication

Only the Mac authors implementation changes, runs the coding goal, installs dependencies, builds images and pushes source. Create a clean identified candidate commit while preserving unrelated local work. Push its slice branch to the fork before attempting the release's Pi source-verification gate. Record the exact pushed commit and tree; do not infer identity from a branch name.

Run the mandatory local checks and build/test final Linux/ARM64 artifact identities against that same commit. If code or a build input changes, make an explicit new candidate and repeat affected checks. Private test evidence and runtime data do not belong in Git. Sanitised acceptance receipts can be committed later; record which commit was tested rather than retroactively labelling an earlier image with a later receipt-only commit.

The first planning-bundle PR is documentation only. It does not implement, run, or authorise bypassing the release commands specified in these plans.

## 4. Pi fetch and detached release checkout

The trusted target helper uses the Pi's existing repository after verifying its configured remote is the intended fork. Preserve the active checkout and all uncommitted/untracked files. Never run `git reset --hard`, `git clean`, an automatic merge/rebase, or `git pull` to make a release fit.

Fetch the validated source reference with the existing authorised read access. Verify the required commit object exists and that its tree matches the manifest. A moving branch may now point elsewhere: always check the manifest's exact commit, not the tip. If the exact commit cannot be retrieved, block the candidate without selecting another commit. Keep a release-retention ref or existing release checkout so later branch deletion does not erase rollback provenance; do not force-update a ref that already identifies different content.

Prepare a separate detached worktree for that exact commit in a versioned, path-validated source directory. Do not switch the live installation's working tree. An already existing matching checkout can be reused after checking its identity and cleanliness. A dirty or conflicting release checkout is a blocker, not permission to overwrite it. Serialise repository/worktree maintenance with the Pi deployment lock.

Fetch and worktree preparation are trusted deployment operations; they must not run package scripts, repository hooks, unreviewed Git filters or recursive submodule/LFS fetches with privileged credentials. Use controlled Git configuration and validate any required extra material during local build. Do not recursively synchronise the Mac checkout to the Pi. Use the fetched checkout as a read-only source reference, not an executable installer.

## 5. Source gate before activation

After local verification, the Mac release coordinator directs the Pi to fetch and verify the pinned source. The Pi then verifies the image archive and extracted host payload against the same release manifest. Source preparation may happen before artifact staging, but no candidate application image is transferred before mandatory local gates pass.

Before activation, require all of these to agree: fork identity, requested commit, fetched commit/tree, release manifest, local test receipts, loaded image IDs and host payload hash. A source mismatch or unavailable required commit leaves the active release untouched. Staging files or fetching source must not restart the bot, run a migration or change the `current` release pointer.

The service continues to run the prebuilt host payload and baked-code workers. Do not execute `src/` or install/build the fetched checkout. Do not mount checkout code over `/app/src`, skills, instructions or workflow assets in worker images. Run migration code from the packaged release, with its recorded checksums, not an independently changing repository path.

Record source-sync status and the verified commit/tree in the Pi deployment receipt, with a redacted copy in the Mac ledger. If SSH disconnects, reconcile the same release ID. Once activated, runtime startup needs no GitHub fetch. During a GitHub outage a new release can proceed only when its exact required source objects and clean matching checkout are already present and verifiable; never substitute `main` or skip identity checks.

## 6. Candidate releases, review and merge

The existing authority permits a tested candidate deployment before human PR review. Push its commit, deploy only its verified artifacts, and label the release `tested_unreviewed_candidate`. Human review/merge remains necessary before beginning the next dependent slice. No unattended GitHub webhook or branch update may deploy itself.

After merge, reconcile the actual merge commit and tree. If source identity changes, build and test a release identified with that merged commit on the Mac before recording it as the merged release; do not merely relabel the old image. Existing image layer caches can be reused, but final identities and receipts must still be verified. Any deliberately optimised same-tree provenance mapping needs an explicit tested contract change; it is not the default here.

Keep the source objects, clean source checkout, images and host payload for retained known-good releases. Garbage collection or worktree removal is a scoped retention operation and must not remove active/rollback release material, uncommitted work, or runtime data. Rollback selects an already verified schema-compatible release; it does not reset a live checkout or restore old conversations.

## 7. Authentication and scope

Use existing authorised GitHub access. The Pi only needs read access. For a public fork, anonymous HTTPS can be sufficient; if authentication is required, prefer existing repository-scoped read-only credentials. Provisioning a new deploy key or broader account token is not implied by this plan. Do not use the Mac's push credentials on the Pi or store a secret in a remote URL.

Keep Git and deployment credentials outside agent containers, model context, shared provider state and release artifacts. Host-key/TLS verification remains enabled. An access failure is a technical blocker, not permission to disable verification or expose the repository/data elsewhere. The CoS agents do not gain source publication, deployment or GitHub administration authority.

## 8. Required tests and slice integration

S01 introduces these deterministic delivery contracts; all later slices regress them when affected:

| ID | Required behaviour |
|---|---|
| S01-REL13 | Git fetch or a branch-tip update alone cannot activate, migrate or restart a release. |
| S01-REL14 | Wrong repository, unavailable commit or source-tree mismatch blocks the candidate without falling back to latest/main. |
| S01-REL15 | A dirty existing Pi checkout is preserved; release worktrees are detached and selected by exact commit. |
| S01-REL16 | Fetched source and final tested artifacts share the manifest identity; checkout code cannot override image code. |
| S01-REL17 | Interrupted source preparation/release retry reuses one release identity and leaves the active version intact until activation succeeds. |
| S01-REL18 | Pi Git access is read-only where authenticated, secrets stay out of workers, and already deployed operation survives GitHub/Mac unavailability. |

Fixtures can use a local bare Git remote to test branch movement, missing objects and dirty worktrees; that is not a local PostgreSQL server or a production source override. The live source-sync check uses the bound fork and Pi only through already authorised deployment access. No live bot messages or paid model calls are required for this gate.

Every slice receipt adds `source_push_status`, `pi_source_sync_status`, `verified_source_commit`, `verified_source_tree` and the source-checkout receipt reference. S11 tests retained-release recovery and confirms GitHub is not an ongoing runtime dependency. Upgrade existing ledgers additively; do not copy an empty template over progress or reset the Pi's data-protection latch.

## 9. Implementation references

- [Git fetch](https://git-scm.com/docs/git-fetch): retrieve objects and refs separately from branch integration.
- [Git pull](https://git-scm.com/docs/git-pull): fetch followed by integration; not the pinned release operation.
- [Git worktree](https://git-scm.com/docs/git-worktree): detached, commit-specific worktrees and their lifecycle.
- [GitHub deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys): repository-scoped read-only access when authentication is needed.

Verify installed Git behaviour while implementing the helper. These references do not establish that the Pi has been contacted or its Git authentication configured.
