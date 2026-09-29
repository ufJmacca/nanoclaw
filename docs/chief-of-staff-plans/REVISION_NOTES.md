# Revision 5 — GitHub-pinned source and repository plan bundle

**Date:** 29 September 2026. **Scope:** same eleven ordered slices. **Status:** documentation and templates only; no application implementation, live tests, migrations or deployment performed by this PR.

## What changed

GitHub now carries source from Mac to the Pi's existing repository. A detached release-source checkout verifies the exact manifest commit/tree. Fetching source never activates a release. Tested Linux/ARM64 images still transfer over SSH; the Pi does not compile/install dependencies, build images or override baked code with checkout mounts. New GITHUB_SOURCE_SYNC.md and S01-REL13–S01-REL18 specify this boundary and its failure tests.

All eleven slices, persistent goal/bootstrap, delivery/authority/database/interaction contracts, acceptance matrix and execution template are included as readable files under docs/chief-of-staff-plans/. Repeated per-slice development/deployment/checkpoint boilerplate is consolidated into SLICE_EXECUTION_RULES.md and explicitly inherited by each slice; it is not deferred to a later phase. Individual outcomes, implementation steps, failure tests and acceptance/rollback requirements remain explicit.

The detailed source-inspection baseline stays at 1a432912c00d96abf6c39cd19b1a312631d78a9c. Publication branches from main at dea16302f904ef57cf10e91b687a289d76c149f8, preserving intervening work. Source observations are not a new runtime audit.

## Unchanged decisions

Mac develops/tests/builds. Pi runs the always-on NanoClaw host and workers. PostgreSQL is an existing third LAN machine with trusted environment credentials. Private Mattermost is the primary interface; Telegram stays separate. The implementation DB is disposable only until the programme closes disposal; existing NanoClaw data and credentials are protected throughout.

Scoped migrations, Pi deployment/restart/health and compatible rollback keep the owner's standing approval after required checks. Tested candidates may deploy before PR review and must be labelled. Human review/merge gates each dependent slice. Runtime app approvals, account access, real messages and model costs remain separate; no worker receives administrative credentials or authority.

## Adoption

Review/merge the docs-only PR, fetch the plan files on the Mac and use BOOTSTRAP_PROMPT.md as the continuing goal. Preserve code, branches, receipts, private state and unknown ledger fields. Upgrade the active ignored ledger additively to v5; never overwrite progress with EXECUTION_STATE.json. Pi owns target/deployment/protection history. New source-sync fields begin unverified until actual execution supplies evidence. Do not redo already merged slices; necessary alignment gets a focused reviewed correction.

Publishing/merging plans does not start coding or activate the assistant. Proposed cos:* commands and target helpers must be implemented in S01. Documentation validation checks file inventory, local links, JSON, slice order, placeholders and hashes; it is not application testing.

## History

1. Eleven vertical slices, runtime/state/authority contracts and test-first delivery.
2. External LAN PostgreSQL and one resumable programme goal.
3. Disposable implementation database and pre-authorised scoped target operations.
4. Mac development, tested image delivery to Pi and Mattermost-first interaction.
5. Pinned GitHub source synchronisation, shared execution rules and complete docs-only PR bundle.
