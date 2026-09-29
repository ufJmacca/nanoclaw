# Revision 5 — GitHub-pinned source and plans-only PR

**Date:** 29 September 2026.  
**Scope:** add the agreed GitHub source-synchronisation workflow to the complete revision-4 bundle; S01–S11 order and authority remain unchanged.  
**Status:** documentation and template changes only. No application implementation, live tests, migrations or deployment are performed by this PR.

The Mac pushes source to the fork. The Pi fetches the exact manifest commit into a separate detached checkout, preserving the active installation and dirty work. GitHub source sync never triggers deployment. Tested images still travel from Mac to Pi over SSH; no build or package installation runs on Pi and no checkout mount can override image code. Source, artifacts and verification receipts must agree before activation.

New file: GITHUB_SOURCE_SYNC.md. Updated: delivery, goal, bootstrap, architecture/authority references, all slice release gates, acceptance matrix, environment examples and the versioned execution template. Existing v4 requirements for external PostgreSQL, the disposable implementation period, pre-authorised migrations/deployments, private Mattermost interaction and human-reviewed merges are retained.

Adopt by merging this documentation PR and fetching the updated plan files on the Mac. Preserve existing branches, worktrees, receipts and the active ignored ledger; upgrade it additively to v5. The Pi-owned protection/target history is not replaced by a template. Publishing or merging these plans does not begin implementation or activate the assistant.

The repository publication base is recorded separately from the historical code-inspection baseline. Plan validation covers complete file inventory, relative links, JSON metadata, expected slice order, placeholder-only examples, checksums and the docs-only change scope; it is not an application test result.

---

# Revision 4 — Mac development, Pi image deployment and Mattermost CoS

**Date:** 29 September 2026.  
**Scope:** the same eleven vertical slices, in the same order.  
**Status:** plan-file changes only; no source implementation, builds, tests, SSH connection, database migration or deployment was performed by this revision.

## Changes

Development, dependency installation, testing and builds occur on the Mac. Only the exact locally tested Linux/ARM64 artifacts are transferred to the Pi over SSH. The Pi verifies, loads and activates them, runs its separately credentialled migrations and performs native smoke tests. No Pi-side builds, source hot fixes or package installs. The deployed system has no dependency on the Mac being online.

Source review identified why the current agent image alone is insufficient: runner code is bind-mounted, host application code is outside the image and per-group builds can happen at runtime. The new release contract ships a matching prebuilt host payload in a carrier image and baked-code agent images, with immutable runtime profile mapping and no checkout-source overrides. Preserve the host service instead of introducing Docker-in-Docker or a new privileged host container.

The initial CoS interface is one private Mattermost channel, with owner-bound approval/control handling and stable mission IDs. Natural language is the primary experience; deterministic controls provide exact approvals and emergency actions. Rich buttons are used only when implemented and tested. Threads do not become mission-isolation boundaries. Telegram stays separate; a new web/mobile UI is not required.

Remote PostgreSQL and disposable-data authority are retained. Mac tests use an explicitly supplied external test profile, or coordinate Pi quiescence/lifecycle and a shared-target lease for permitted runtime-disposable tests. Pi credentials are not copied to the Mac. Authoritative deployment/disposal state remains on the Pi; the coding ledger is on the Mac.

All eleven slices, shared architecture, goal, bootstrap, authority, DB contract, acceptance matrix and execution template are aligned. New files: MAC_TO_PI_DELIVERY.md, INTERACTION_MODEL.md and DEPLOYMENT_ENV.example. S01 includes the first complete release and interaction path. S11 closes the cross-host verification/recovery loop.

## Unchanged permissions

Migrations, Pi deployments/restarts and compatible rollback remain pre-authorised after mandatory local tests. Tested candidates may be deployed before PR review, with that status explicit. Human PR review/merge still gates dependent implementation. Business-action approvals, channel/account activation and model spending remain as previously granted, not implicitly expanded.

Only CoS records are disposable until the programme closes disposal. Existing Pi NanoClaw SQLite/messages/sessions, credentials, unrelated groups, foreign schemas and later valuable records remain protected. Do not copy runtime state through release archives or restore old live data just because code rollback is needed.

## Adoption

Install the folder under the Mac checkout's docs/chief-of-staff-plans/ after comparing local plan edits. Reuse BOOTSTRAP_PROMPT.md as the same continuing goal. Preserve previous code/PRs/receipts and upgrade the active ignored ledger to v4 additively. Do not restart completed slices or replace progress with the template. Reconcile Pi-side authoritative target/lifecycle/deployment records before using runtime-disposable tests. If earlier implementation assumed local builds on the Pi, make a focused alignment correction on the Mac and verify it before continuing.

## History

- Revision 1: eleven ordered vertical slices and explicit runtime/authority contracts.
- Revision 2: external LAN PostgreSQL and persistent implementation goal.
- Revision 3: disposable CoS implementation database and pre-authorised target operations.
- Revision 4: Mac development and tested image delivery to the Pi; Mattermost-first interaction.

The proposed cos:* command names and release helper are implementation requirements, not utilities installed by generating this bundle. Tests performed while assembling the plan bundle verify document links, metadata and archive contents only—not application functionality.
