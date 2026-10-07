# Gmail, Calendar and encrypted storage for NanoClaw CoS

- **Contract:** `cos-google-mail-storage-plan/v1`
- **Goal ID:** `nanoclaw-google-mail-storage`
- **Plan revision:** 1
- **Planning date:** 7 October 2026
- **Status:** agreed specification; publication does not establish implementation, account consent or deployment.

Use [the execution goal](GOOGLE_MAIL_AND_STORAGE_GOAL.md) to implement this extension. Preserve the completed S01–S11 programme and its evidence; G01–G07 have their own ledger and acceptance receipts.

## Summary and agreed behaviour

Extend the existing CoS agent group with Gmail reading, reply drafts saved directly in Gmail, and read-only Google Calendar planning. Keep its existing Mattermost channel and persistent main context; specialists retain their separate contexts.

| Area               | Selected behaviour                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Mail access        | Inbox and Sent; exclude Spam and Trash                                                                   |
| Drafts             | Save without individual approval; the owner reviews and sends in Gmail                                   |
| Regular reviews    | 08:00 and 15:00 every day, Australia/Sydney                                                              |
| Draft allowance    | Up to five new CoS drafts per Sydney calendar day                                                        |
| Credentials        | Encrypt new Google and backup credentials; retain existing NanoClaw credential storage                   |
| Local storage      | Automatically unlocked encrypted Pi vault                                                                |
| Backup destination | The NAS selected by the existing private `omi-qnap` host profile, with a dedicated CoS account and share |
| Models             | Existing NanoClaw Codex subscription runtime and the currently valid model allowance                     |

Sending email, modifying mailbox labels, downloading attachments and changing Calendar events are outside this extension. Existing Calendar action approval rules remain in force; this programme does not activate a Calendar writer.

The credential scope includes the new Google OAuth clients and tokens, NAS credentials and repository encryption credentials. It does not move existing database, Mattermost or Codex sign-ins into the vault. Encryption of these credentials and backup copies is not a claim that every live Pi or external PostgreSQL record is encrypted.

Installed endpoints, service/data bindings and credential recovery material belong in private configuration. Resolve and revalidate the selected NAS through trusted host tools; do not publish its LAN address or copy Omi account credentials or backup exceptions.

## Vertical implementation slices

Implement G01–G07 sequentially, with one PR per slice. Each slice must deliver the stated outcome, pass its tests, have a deployment/demonstration receipt and receive a legitimate human-reviewed merge before its dependent slice starts.

### G01 — Encrypted vault with a working recovery check

**Outcome:** CoS can verify its credential storage is encrypted and report its health.

- Provision a 1 GiB LUKS2/ext4 volume on the Pi, mounted at `/var/lib/nanoclaw-cos/vault`. Require at least 2 GiB free on the Pi after allocation and the required utility installation. Do not format an existing disk or delete unrelated data to make room.
- Provide private directories for Google credentials, backup credentials, credential journals, staging and backup cache. Use real bind mounts for the existing Calendar credential path; preserve canonical-path and ownership checks.
- Reuse the current encryption proofs without weakening Calendar's storage contract. Pin directory handles during credential reads and writes so a lost or replaced mount cannot cause a plaintext fallback.
- Configure automatic unlock with a root-protected Pi key and independent recovery material in the owner's Mac Keychain. Exclude credential-bearing host/admin and backup processes from core dumps and disk-backed swapping using scoped process/service controls, without changing global swap settings.
- Install only the required OS storage utilities on the Pi, initially `cryptsetup-bin` and `cifs-utils` when absent. Pin and record their compatible versions. Deploy the provisioner as a locally tested, pinned artifact; this is not permission to install project dependencies or build source on the Pi.

**Acceptance:** An encrypted canary survives remount and recovery. Missing mounts, wrong ownership, symlinks and mount races deny credential access without leaving plaintext copies. Verify scoped memory controls, cold-start mount ordering and ordinary NanoClaw health. A vault failure must report Google functionality unavailable without silently recreating credential directories on plaintext storage.

Automatic unlock retains the owner's accepted limitation that possession of the whole Pi can expose its vault.

### G02 — Dedicated NAS account and encrypted backups

**Outcome:** A consistent CoS checkpoint reaches the NAS as ciphertext and can be restored in isolation.

- Create non-admin account `nanoclaw-cos-backup` and share `nanoclaw-cos-backups`, rooted at `/share/CACHEDEV1_DATA/homes/nanoclaw-cos-backups`. Refuse unexplained name/path collisions; do not adopt somebody else's directory.
- Allow the account access to that share; deny other existing shares and applications. Leave any QTS-created private home unused. Preserve Omi's account, permissions, jobs and directories and the NAS-wide home-folder configuration.
- Use the NAS's existing signed SMB 2.1 capability, with mandatory signing and a private credential file. QTS restricts SSH to administrators, so the existing administrator SSH connection is used only for bounded provisioning and inspection. Do not install that admin key on the Pi. [QNAP SSH permissions](https://docs.qnap.com/operating-system/qts/5.1.x/en-us/editing-ssh-access-permissions-9E9CFBD6.html)
- Use a pinned, locally tested Linux/ARM64 restic binary and repository v2. Keep its password and SMB credentials in the local vault, with independent recovery copies in Mac Keychain. Encrypt content and metadata before storage on the NAS. Verify the mount's configured host/share and repository identity before every upload; reject a missing mount or local underlay. [Restic repository documentation](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)
- Extend the coordinated checkpoint workflow so all sensitive staging occurs inside the vault. Include scoped PostgreSQL state, necessary native SQLite snapshots, CoS conversations, missions, artifacts, credential snapshots and recovery journals. Select the required database/recovery files rather than copying whole native workspaces. Preserve backward-compatible readers for existing receipts.
- Capture under the existing quiescence and maintenance contracts. Preserve the owner's pause state and current context/allowance; resume only work the maintenance operation itself held. Complete restart and health checks before uploading. A slow or unavailable NAS must not prolong the checkpoint interruption or prevent Gmail/Calendar use.
- Schedule checkpoints at 03:30 Sydney time and before relevant deployments. Credential changes create durable encrypted local snapshots/journal entries, queued for upload at least hourly. Retain 14 daily and four weekly state and credential snapshots, grouped by snapshot kind.
- Bound full-checkpoint staging to 512 MiB, backup cache to 128 MiB and queued credential snapshots/journals to 128 MiB within the vault. Bound the repository to 20 GiB and retain a 1 TiB NAS free-space floor. Keep one pending full checkpoint during outages; skip further full captures visibly while that slot is occupied. Do not fall back to plaintext staging.

**Acceptance:** Verify allowed and denied share access, real signed-SMB/restic compatibility, interrupted uploads, unavailable NAS, exhausted local queue/capacity, repository integrity and isolated restore. Verify no plaintext canary on the NAS or unencrypted staging paths. Check that checkpoint admission/resumption preserves a later owner pause, current model counters and ordinary messaging. Retention and pruning must affect this repository only.

### G03 — Connect Google Calendar securely

**Outcome:** CoS answers questions about selected upcoming meetings.

- Reuse the existing Calendar reader, OAuth flow, account binding and revocation controls with the new vault.
- Configure an organisation-owned Google Cloud project with an Internal audience and a dedicated Desktop OAuth client. Internal apps require an organisation-owned project and may need administrator approval. Do not use an external Testing app as the permanent setup: Google's Testing authorisations and refresh tokens can expire after seven days. [Internal-app guidance](https://support.google.com/cloud/answer/13464323?hl=en), [app audience](https://support.google.com/cloud/answer/15549945?hl=en)
- Obtain owner consent on the Mac through the existing secure Pi loopback/tunnel workflow. Keep tokens on the Pi and request only `calendar.events.readonly`.
- Bind explicit owner-selected Calendar IDs. Back up credentials and denial journals, then demonstrate a grounded meeting answer in the existing CoS channel.

**Acceptance:** Test refresh, wrong-account rejection, selected-calendar restrictions, revocation, NAS outage and restart recovery. Failed reads show incomplete coverage rather than zero meetings. Account linking alone is not evidence of a successful live read.

### G04 — Gmail reading and grounded answers

**Outcome:** CoS finds relevant mail and answers with message references and freshness information.

- Add a host-only Gmail reader with its own Desktop OAuth client and `gmail.readonly` grant, bound to the intended Workspace mailbox. Keep Calendar, mail-reader and draft-writer profiles separate; do not widen or reuse Calendar tokens to obtain mail authority.
- Capture the most recent 30 days, bounded to 1,000 messages and 16 MiB of normalized text. Enforce rolling retention and report selection or size limits explicitly.
- Poll every five minutes without model calls, subject to current source/admission controls. Use Gmail history for incremental updates; expired history triggers a bounded resync and incomplete coverage until it finishes. Persist cursors only with the corresponding published capture. [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)
- Enforce Inbox/Sent selection at the individual-message level, including thread reads. Exclude Spam, Trash and unselected thread members before publishing content to CoS.
- Normalize plain text and safe HTML text without loading external images, following links or retrieving attachments. Treat mail content as evidence, never as authority or executable instructions.
- Publish mail through the existing knowledge, citation and revocation machinery. Withdrawal invalidates previously exposed evidence through existing context-recovery controls.
- Add mailbox bindings, sync cursors, coverage and message references to migrations and coordinated backups. Verify capture bounds remain compatible with checkpoint limits; do not silently omit new mail tables or records from recovery.

**Acceptance:** Fixture tests cover pagination, expired history, concurrent changes, excluded thread members, oversized content, malicious instructions, revoked access, retention and cross-account isolation. Demonstrate a cited answer using owner-authorised test mail. Partial or stale captures must never support a claim that the inbox is empty or every message has been reviewed.

### G05 — Save reply drafts in Gmail

**Outcome:** CoS prepares a reply and confirms that it exists in Gmail.

- Add a separate draft-writer Desktop OAuth client and `gmail.compose` grant, bound to the same mailbox as the reader.
- Permit fixed draft-create and bounded reconciliation operations only. Google's compose scope also permits sending, so the trusted host must enforce the draft-only boundary independently of OAuth. No send, mailbox mutation, forwarding/settings or arbitrary-URL operation may be exposed. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- Record the owner's standing draft authority. Individual saves need no approval; existing approval rules for other actions remain intact. Apply the five-new-drafts-per-day limit to all CoS draft creation, including owner-requested drafts. Reserve uncertain submissions against that limit rather than treating them as free retries.
- Create plain-text reply drafts addressed to the source message's validated reply recipient, with correct subject, thread ID, References and In-Reply-To headers. V1 excludes reply-all, attachments and unrelated new-message composition. [Gmail thread replies](https://developers.google.com/workspace/gmail/api/guides/threads)
- Skip threads with an existing open draft and those already answered by a later sent message. Do not update/delete drafts or overwrite human edits. Use bounded draft metadata for collision checks without exposing unrelated draft bodies to the model.
- Journal intent before submission and verify the saved draft before claiming success. Use a stable opaque correlation identity. After a timeout or crash, reconcile the original operation; never blindly repeat an uncertain creation. [Gmail draft lifecycle](https://developers.google.com/workspace/gmail/api/guides/drafts)
- Preserve draft effects and reconciliation state independently of restorable checkpoints. A deleted, edited or sent draft must not be automatically recreated from a replayed run or restored snapshot.

**Acceptance:** Verify threading, readback, header validation, recipient binding, duplicate prevention, uncertain outcomes, edited/deleted/sent drafts, daily limits and blocked send endpoints. The live demonstration ends with a draft visible in Gmail; the implementation agent does not send it.

### G06 — Morning and afternoon mail reviews

**Outcome:** CoS reviews mail twice daily, prepares useful drafts and posts a clearly structured briefing.

- Create two native schedules, at 08:00 and 15:00 every day, rather than changing the existing one-occurrence-per-schedule daily contract. Bind both schedules to the owner-approved mail-review policy and existing private CoS channel.
- Review at most ten candidate threads per run, with at most three model attempts per run and five new drafts per Sydney calendar day. All attempts, including retries, also consume the existing global subscription allowance.
- Prioritise unanswered requests and follow-ups. Exclude bulk mail, newsletters, automated receipts and no-reply messages. Choose the newest relevant candidates within the selected capture; acknowledge threads excluded by the run limit.
- Permit scheduled draft creation only through the specific owner-bound mail-review policy. Generic scheduled briefs and specialists cannot write drafts. Specialists may supply analysis from explicitly authorised source manifests.
- Use the existing persistent CoS main context and global model-attempt ledger. A visual reply thread, scheduled occurrence, restart, retry or restore must not create an independent main model context or replenish allowance.
- Present briefings under Needs attention, Drafts ready and Upcoming meetings, with source references, freshness and coverage limitations. Do not imply draft text makes a commitment or reserves Calendar time.
- Coalesce missed occurrences through the existing native scheduling policy; do not replay every missed run. Pause, revoked source access and expired/exhausted model authority stop affected work. Status and backup administration remain available without inference.

**Acceptance:** Test both daily schedules, DST, daily caps, overlapping owner conversations, source revocation, pause, allowance exhaustion, missed runs and absence of useful changes. Demonstrate the complete mailbox-to-draft-to-Mattermost flow without sending email or resetting the main context for a mail thread.

### G07 — Recovery, operating controls and handover

**Outcome:** The combined system is usable and recoverable without reviving stale authority.

- Add owner controls for `cos status mail`, `cos status backups`, `cos mail pause` and `cos mail resume`, alongside source disconnection through the existing trusted owner administration path. Mail pause closes automatic reviews and draft creation; resume requires current source/draft authority and does not resume a globally paused CoS or renew its model allowance.
- Show connection state, last successful sync, coverage, draft count, next review, backup age and actionable failures without requiring a model call. Keep tokens, raw mail, private paths and provider error bodies out of status output.
- Verify restoration into isolated Pi directories and the admitted test PostgreSQL database, using installed trusted administration artifacts. Do not overwrite live stores or export real conversations/account secrets to the Mac as fixtures.
- Prove independent recovery using a synthetic NAS canary and Mac Keychain material. The recovery kit must work without the original Pi; a key stored only in the encrypted vault or NAS repository does not satisfy this check.
- Test that restores cannot reactivate revoked tokens, replay uncertain drafts, reset model counters, restore old approvals/admission or overwrite newer independent journals. Relink an account explicitly when credential validity cannot be established.
- Document account relinking, key/password rotation, retention, capacity limits, checkpoint interruption and compatible rollback. Rollback may leave new functionality closed when an older release cannot safely read its schema/journals.

**Acceptance:** Complete the combined failure scenarios, verify ordinary NanoClaw messaging, and record the final reviewed source, deployed release, schema, backup and restore identities in sanitized receipts.

## Interfaces and security contracts

- Add typed host tools `cos_mail_search`, `cos_mail_thread_get`, `cos_mail_draft_create` and `cos_mail_draft_status`. Inputs use scoped message/thread references and validated draft content; they cannot select arbitrary endpoints, accounts, SQL or credentials.
- Introduce owner-bound mail-access, draft-authority and review policies, durable draft intent/receipt state and mail coverage in grounded answers. Extend status categories, migrations and recovery manifests compatibly.
- Keep Google tokens, NAS credentials, database access and arbitrary network requests outside agent containers. Trusted host connectors use fixed verified-TLS Google endpoints; the trusted backup process accesses only the configured NAS share. Workers retain their existing network restrictions.
- Before live mail enters model context, disclose its use by the existing Codex runtime and verify the account's data-sharing controls exclude general model training. Google limits transferred data to the consented feature and prohibits unrelated model training; subscription authentication follows ChatGPT's applicable data controls. Do not substitute an API-key policy for subscription evidence. [Google data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy), [OpenAI authentication guidance](https://learn.chatgpt.com/docs/auth)
- Keep the private owner-only channel, exact membership checks, native AgentGroup and shared main context. Tool-catalogue or evidence changes use existing context-recovery procedures while carrying forward consumed allowance.

## Delivery and completion

For every slice: follow red → green → refactor, run appropriate tests in the Mac devcontainer, build the exact Linux/ARM64 artifacts, push their source identity, deploy a checked candidate, and produce its demonstration, sanitized receipt and PR. Wait for legitimate human review and merge before starting the dependent slice. Reconcile the merged source and deployed release before proceeding.

Use fixtures for local account and model tests. Real account linking requires owner OAuth consent and selected Calendar IDs; credentials enter through trusted private setup paths. Live demonstrations use the current valid model allowance. If it expires, record that precise blocker while continuing eligible fixture work.

The [execution goal](GOOGLE_MAIL_AND_STORAGE_GOAL.md) supplies the bounded extension authority and persistent ledger rules. Completion requires all seven reviewed merges, mandatory local/image/Pi checks, successful live Gmail and Calendar reads, verified saved reply drafts, both scheduled reviews, encrypted NAS backups and isolated recovery evidence. Pending consent, live evidence or a human review gate is not programme completion.
