# Mail reader

G04 adds a host-only Gmail reader for the selected owner's Inbox and Sent mail. Its separate Desktop OAuth client uses only `gmail.readonly`. Calendar credentials and grants do not provide mail authority. Owner account selection, Google consent and model data-control verification remain prerequisites for live use.

The implementation is in progress. The collector, store, evidence publication, read adapters, encrypted profile, host scheduler and disabled-service maintenance have fixture coverage; owner setup and G04 deployment/recovery acceptance remain pending. The accepted G03 installation does not yet expose these mail tools.

## Encrypted profile

Mail has its own `mail-reader` child beneath the existing protected Google/Calendar directory, with a separate OAuth client, credentials marker and denial journal. This keeps complete mail configuration in the existing encrypted Google-state capture without widening Calendar tokens or changing the vault's v1 area policy.

`COS_MAIL_ENABLED` defaults to `false`. Runtime opening uses existing state only and holds verified directory descriptors until explicit shutdown. A profile proof binds its filesystem, credential/denial folder identities and client digest. Replaced folders or client files are refused after restart as well as during an active operation. Every credential and denial operation rechecks the held vault and memory proof. Lost protection cannot redirect a rotated token or new denial into a replacement directory.

Backup copies include the separate mail client, credentials and denial journals as private recovery material. Archived profile proofs and journals do not grant live access or replace current authority.

The recovery snapshot reader records the immutable client/profile configuration and pages up to ten permanent access-denial records into the existing encrypted credential queue. Stable identities make unchanged retries reuse their snapshots. It never enumerates token files or contacts the NAS. Held file descriptors, metadata and storage proofs remain checked through each awaited queue write, and temporary buffers are cleared afterward. Transient read-check ownership is counted separately and remains part of full Google-state captures; it creates no credential snapshot source for each poll. Hourly job integration remains pending.

Retention work is in progress because independent credential-change archives do not establish a complete recovery set. The new complete-set manifest binds every selected source event to its archive path, byte count and digest within existing credential and archive limits. Capture completion requires an independently selected current inventory; a token-only archive cannot pass when configuration is also required. Equal-version content conflicts and concurrent source changes are rejected. The format round-trips through the existing archive transport, whose payload checks remain mandatory. These metadata checks grant no restore or prune authority; live source collection and retained-repository coverage checks remain pending.

The owner-only initializer requires current administration authority and holds a lock on the encrypted parent directory. It verifies that the supplied client differs from the existing Calendar client and pins Calendar's client identity throughout setup. Setup writes through pinned descriptors and records an operation-bound intent before the client file. It seals child directory identities before writing secrets, publishes the final profile proof after its markers are complete, and leaves interrupted profiles closed to runtime use. An exact retry can finish corroborated partial writes. A completed profile is checked without rewriting it; installed tokens and independent denials are preserved. Changed clients, foreign files and replaced directories are refused. The owner command, separate Google consent and queued configuration/denial snapshots are still being implemented.

## Captures and retention

Each capture covers the most recent 30 days and holds at most 1,000 messages and 16 MiB of normalized text. A separate 48 MiB encoded checkpoint budget accounts for raw records, citation chunks and provenance within the existing coordinated checkpoint limit. Limits are explicit in coverage. Captures retain individual Inbox/Sent messages; Spam, Trash, drafts, older messages and unselected thread members are excluded. HTML conversion loads no external content or attachments. Mail text remains untrusted evidence.

History cursors advance only in the same transaction that publishes the capture and its knowledge evidence. Stable attempt IDs reconcile uncertain commits. Unchanged message text preserves source revisions across ordinary polling. Selection withdrawal uses the existing source tombstones, context invalidation and purge machinery. An owner's source denial also suppresses raw message copies in later captures.

The host refresh connector uses PostgreSQL's observation clock and rechecks the binding, exact read grant, storage proof and polling admission around asynchronous work. One binding has one refresh in flight, bounded to four minutes. An uncertain publication returns private recovery material to the trusted host; retrying that exact capture reconciles its receipt without repeating a completed provider read. Access loss latches the independent mail denial journal before a database update, so a database outage cannot reopen cached mail.

The host scheduler checks due bindings during the existing service tick and atomically claims each five-minute poll using PostgreSQL's clock. A claim cannot advance the history cursor, create a successful capture or imply a fresh read. Polling runs in the background with at most one active mailbox refresh, so it does not hold up ordinary messaging. Host retirement aborts polling and waits for the actual database and provider operations before releasing pinned credential resources or the shared database pool.

Polling requires the current native owner binding, an active Mattermost subscription, unpaused native admission, the installed release and its current host lease. These checks do not consult model sign-in or spend inference allowance. Retention uses a separate tightening-only authority that still checks the owner binding, installed release and host lease while allowing a paused or closed native session. Closed or historical mail bindings remain in the paged retention inventory; no mailbox addresses, credentials or message text are returned by that inventory.

Retention can tighten a stored selection without a provider request or model call, including while the scope is paused or access is closed. Its separate capture does not advance the provider's refresh time or cursor. Read checks enforce the rolling wall-clock boundary even before physical cleanup runs. Tiny selection anchors preserve immutable selection identity; superseded unreferenced capture inventories become bodyless receipts and age out after 30 days.

When the entire CoS service is disabled, the installed host uses a separate maintenance owner. It verifies current target and owner registration before opening runtime-role storage, opens only the protected mail denial profile, and cannot poll providers or start model, RPC, specialist or messaging work. It applies the same retention and source-purge machinery. Required cleanup of retained native conversation history stays pending until the existing protected maintenance procedure completes; disabling the service does not waive that boundary. Unconfigured or unadmitted installations open no maintenance database.

An unchanged retention check creates no new capture and preserves provider freshness. Actual message or queued-metadata expiry, owner withdrawal and the first recorded access closure still create the required atomic retention checkpoint.

## Read tools and answers

`cos_context_get` includes mailbox binding references and a host-generated freshness notice when the mail adapter is configured.

| Tool                  | Input                                                                      | Result                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cos_mail_search`     | `binding_id`, local text `query`, optional `limit` and `offset`            | Up to five checked source chunks, with captured message/thread IDs and freshness. Mailbox and source-kind restrictions apply before ranking and pagination.                              |
| `cos_mail_thread_get` | `binding_id`, exact hexadecimal `thread_id`, optional `limit` and `offset` | Up to five currently captured, readable messages. Each includes at most two cited chunks. `next_offset` continues messages; `next_ordinal` continues a message through `cos_source_get`. |

Both tools read the committed selection; neither can choose an account, call an arbitrary URL, refresh Google, retrieve attachments or write mail. The host rechecks the capture, source permissions, account binding, current context and access fence before returning evidence. A concurrent selection change yields a conflict instead of mixed results.

Mail-influenced answers include the recorded selection, last successful refresh, latest attempt and coverage limits. This notice is generated by the host, including for mail exposed through specialist evidence. Partial or stale captures do not establish an empty inbox or complete review. Historical answers retain their original as-of notice while their account and evidence permissions are revalidated.

Ordinary refreshes update freshness without replacing the main conversation. A change to account or access authority closes contexts that saw mailbox metadata, even when no message body was returned. Source withdrawal continues to invalidate contexts that saw the withdrawn evidence.
