# Gmail reply drafts

G05 adds saved, plain-text replies to the selected owner's Gmail mailbox. The owner reviews and sends in Gmail. The writer is separate from the [Mail reader](MAIL.md), with its own Desktop OAuth client, compose grant, encrypted credential profile and access-denial journal.

This guide describes the implemented G05 interfaces and operating boundaries. [G05 evidence](evidence/G05.md) identifies the exact tested/deployed source and the remaining live and review gates.

## Use and limits

Ask in the existing private CoS channel for a reply to a selected Inbox or Sent message. CoS searches the captured selection, prepares a reply and verifies the saved draft before claiming success. Its answer cites the source and includes Mail's recorded refresh time and coverage limits. A partial capture does not establish that every message has been reviewed.

The standing policy permits at most five new drafts per Australia/Sydney calendar day, including owner-requested drafts. An uncertain submission reserves a place in that limit. Restarting, retrying or restoring a checkpoint does not refund it. Model attempts have a separate owner-issued allowance: failed model turns still consume that allowance, and a draft-policy change cannot renew it.

Replies use the source message's validated reply recipient, subject, thread and reply headers. G05 excludes reply-all, attachments and unrelated new messages. An existing open draft or a later sent reply causes a skip. The host exposes no send, update or delete operation, and it does not overwrite human edits.

Only the current owner's retained main conversation can use the writer. Specialist and scheduled origins are denied in G05. Daily Mail reviews require the separately reviewed G06 implementation.

## Trusted owner setup

Use the installed `cos_owner` wrapper and protected administration process described in [operations and recovery](OPERATIONS_AND_RECOVERY.md). Obtain the current payload and settings from its healthy deployment receipt. Project dependencies and builds remain on the Mac devcontainer.

Pause CoS, drain ordinary work and hold one recorded maintenance request before setup or policy changes. Use a fresh valid UUID for a new administrative request and retain that UUID to reconcile its uncertain result. A model or specialist cannot invoke these owner commands.

The setup sequence is:

1. Verify the existing read-only Mail binding and selected mailbox.
2. Supply the separate Desktop client through the trusted private stdin workflow, then obtain the owner's separate compose consent. Keep client secrets, authorization links, codes and tokens out of chat, command arguments, ordinary Pi staging and logs.
3. Verify a combined schema-20 state and complete-credential recovery against an admitted isolated test target. Preserve the independent draft journal.
4. Configure the sealed standing grant derived from that consent, recovery proof and current owner identity. Configuration uses the explicitly selected migration profile; it cannot substitute runtime or test credentials.
5. Enable the separate `COS_MAIL_DRAFTS_ENABLED` service switch, verify the actual running process and complete the current encrypted backup. Resume only the recorded owned pause through the guarded same-policy procedure.

These are the installed command forms; uppercase values are recorded IDs or private canonical paths supplied by trusted setup:

```sh
cos_owner mail-draft-setup --scope "$COS_OPERATOR_SCOPE" \
  --request-id SETUP_UUID

cos_owner mail-draft-link --scope "$COS_OPERATOR_SCOPE" \
  --request-id LINK_UUID \
  --reader-binding READER_BINDING_UUID --writer-binding WRITER_BINDING_UUID \
  --manifest /absolute/private/mail-selection.json

cos_owner mail-draft-configure --scope "$COS_OPERATOR_SCOPE" \
  --request-id POLICY_UUID --manifest /absolute/protected/sealed-writer-grant.json
```

The link selection contains only `mailboxEmail` and `processingProviders: ["codex"]`. It must match the linked reader's mailbox. Reader and writer client identities and credential references must differ. Setup and linking preserve the pause and do not enable writes.

The standing grant is protected proof metadata produced by trusted owner setup, not an editable policy shortcut. Configuration checks the actual consent, recovered reader/writer identities, independent history, original owner/context and complete recovery proof. It commits the immutable SQL policy before publishing host authority. An uncertain SQL acknowledgement leaves host authority unpublished; reconcile the original request.

The service switch defaults off. Enabling it alone grants no write authority. Valid database policy, host grant, current source permissions, credentials, native owner, conversation, model allowance and independent journal are all required.

## Receipts and uncertain results

The main coordinator discovers writer binding references through `cos_context_get`.

| Tool                    | Parameters                                             | Purpose                                                |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| `cos_mail_draft_create` | `writer_binding_id`, `source_message_id`, `reply_text` | Save and independently verify one bounded reply.       |
| `cos_mail_draft_status` | `operation_id` from the original receipt               | Reconcile that operation without issuing a new create. |

The outer coordinator `request_id` is a valid UUID. The returned draft `operation_id` is a separate 64-character hexadecimal identity; copy it from the receipt. Owners can ask naturally and need not generate either identifier.

| Draft result                               | Operator interpretation                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `verified`                                 | The current provider readback matches the intended saved reply.                     |
| `skipped` / `open_draft`                   | A draft already exists in the thread; CoS has not replaced it.                      |
| `skipped` / `already_answered`             | A later sent reply prevents another draft.                                          |
| `uncertain`                                | Preserve the reservation and original operation ID; reconcile with status.          |
| `edited`, `missing`, `sent` or `collision` | Report the observation and preserve independent history. Do not recreate the draft. |

`pending`, `unavailable`, `denied` and `conflict` are not saved-draft confirmations. A timeout after submission does not prove that Gmail rejected the write. Do not invent a new operation to retry an uncertain save. The corrected request-ID validation error explicitly says when no operation was submitted; it contains no private arguments.

## Disable and recover

To stop draft writes, pause admission and use the held owner-maintenance procedure, then disable the selected writer:

```sh
cos_owner mail-draft-disable --scope "$COS_OPERATOR_SCOPE" \
  --request-id DISABLE_UUID --binding WRITER_BINDING_UUID
```

Local disable needs no database connection, Google token or NAS access. It preserves credentials, independent history, conversation and allowance counters, and leaves native admission paused. It does not delete drafts or revoke Google's grant. Resume and any later re-enable require their current guarded authority.

Complete state and credential backups cover the selected writer alongside the reader and other protected profiles. The effect journal remains independently owned outside restorable checkpoints. Restore cannot activate credentials, restore admission, enable the writer, rewind the daily count or recreate that journal. Missing or replaced history closes draft writes; do not initialize replacement history as a repair.

The combined restore command selects an explicit test profile before the admin delimiter:

```sh
"$COS_OPERATOR_PAYLOAD/node/bin/node" \
  "$COS_OPERATOR_PAYLOAD/dist/modules/chief-of-staff/ops/target-owner-admin.js" \
  --settings "$COS_OPERATOR_SETTINGS" \
  --database-environment /absolute/private/marked-test.env \
  -- mail-draft-restore-check --scope "$COS_OPERATOR_SCOPE" \
  --request-id STATE_RESTORE_UUID \
  --backup-operation-id STATE_QUEUE_UUID --backup-release CAPTURE_RELEASE_ID \
  --snapshot-digest LOGICAL_STATE_DIGEST --writer-binding WRITER_BINDING_UUID \
  --capture-operation-id CREDENTIAL_CAPTURE_UUID \
  --credential-request-id CREDENTIAL_RESTORE_UUID
```

Use the recorded state queue UUID, logical snapshot digest, capture release and complete credential capture UUID. The two restore request UUIDs, state queue UUID and credential capture UUID must all differ. The logical digest is not the remote archive's SHA-256.

The test target must have its admitted marker, verified TLS, expected schema/checksums and a database identity distinct from runtime. Preserve existing restored scopes and independent histories; do not clear a database to force a mismatch to pass. Creating another server resource needs the database administrator's authority.

G05 requires PostgreSQL 20 and native SQLite 22. A G04 schema-19 release is not a compatible rollback after migration 20. Choose only a recorded release compatible with the current schemas, RPC and worker assets. Never restore old runtime data or budget records to force a downgrade.

Normal Google use relies on the local encrypted vault and sealed offline recovery proof. NAS availability is not a per-draft dependency. NAS outages leave bounded encrypted backlog and visible backup age; they do not permit plaintext staging or a claim of successful remote backup.
