# Calendar awareness implementation

S03 is in progress. The calendar readers, snapshot collector, PostgreSQL snapshot store, guarded S02 evidence integration, host connector and bounded model read tool exist. Operator account linking and the complete preparation conversation remain pending. No real calendar account has been linked or queried.

## Read contract

The host reader exposes access status, event listing and event lookup. It builds fixed Google Calendar HTTPS GET requests and refuses redirects. An owner's selected calendar IDs constrain every request even if the supplied token has broader scopes. Tokens are supplied through a host-only callback and never appear in returned events or operational errors.

The intended authorization scope is `calendar.events.readonly`. Calendar selection uses explicit IDs, so the implementation does not need CalendarList or calendar-write permission. The OAuth operator flow remains to be implemented and tested. Google documents event-read scopes separately from calendar-management scopes. [Scope reference](https://developers.google.com/workspace/calendar/api/auth).

## Snapshot and time policy

The default window covers 30 calendar days back and 90 forward in the configured IANA zone. One frozen window is used across pagination. The reader requests expanded recurring instances and cancellation markers, follows opaque page tokens, and does not use incremental sync tokens. The collector returns only after all pages and access checks succeed. Empty pages with a continuation token are followed. Repeated tokens, conflicting duplicate revisions, changed access roles and excessive pages fail closed. [Events list reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

All-day values remain dates with an exclusive end date. Timed values become instants displayed in the configured zone. A zone-only local time must resolve uniquely; DST gaps and overlaps are rejected. An explicit numeric offset must agree with its supplied zone. Moved recurring instances retain their original occurrence identity. Minimal cancelled events are retained as content-free tombstones. [Event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events), [Temporal time-zone policy](https://tc39.es/proposal-temporal/docs/zoneddatetime.html).

Each page is bounded to 250 events and a 1 MiB response; a snapshot is bounded to 20 pages, 5,000 distinct events and 8 MiB of normalized content. Each request permits at most three HTTP attempts, a 10-second per-attempt transport deadline and a 30-second overall request deadline. Rate limits and selected transient server errors use bounded backoff. A provider retry hint above the available wait budget stops the operation rather than retrying early. Authentication and access failures are not retried. [Google error handling](https://developers.google.com/workspace/calendar/api/guides/errors).

These are local capture limits, not a claim that Google's pages form a transactionally consistent external snapshot.

## Durable publication

Schema 3 records operator bindings, credential references, selected calendars, processing permissions, refresh attempts, completed snapshots and event revisions. Network collection runs outside database transactions. A single transaction publishes a complete capture, records its observed access role and retires missing observations within its coverage window. Events outside that window are retained. An incomplete or failed attempt keeps the previous completed view and reports incomplete coverage. No successful snapshot means unknown coverage, even when the returned event list is empty.

Stable snapshot identities reconcile retries and lost acknowledgements. Concurrent duplicate publication creates one revision per changed event; an older refresh cannot overwrite a newer attempt. Revoked, expired or disconnected bindings hide cached observations immediately at this store boundary. Reconnection requires a newly authorised binding. This store is not yet exposed to the coordinator.

When constructed with the evidence publisher, a complete snapshot admits immutable source revisions, exact-line citations and observation links in the same transaction. Corrections, cancellations and successful omissions invalidate exposed contexts and derived answers. Source revisions remain historical records; owner revocation tombstones cannot be undone by a later refresh. File imports cannot overwrite connector-owned sources. Private evidence bytes are captured under the existing artifact lease before metadata publication, so interrupted transactions leave only unadmitted bytes eligible for ordinary orphan cleanup.

Knowledge retrieval checks both the current database binding/observation and a host-supplied local access guard. Missing guards deny calendar evidence. The guard applies before search ranking and pagination, on direct reads, exposed contexts, historical answers and final answer publication, including uncited context dependencies. Durable local denial therefore closes cached disclosure even when the database has not yet recorded access loss. Runtime configuration must supply the protected denial journal before enabling calendar retrieval.

The external test database has schema 3. The Pi remains on the accepted S02 schema 2 release. S03 release registration stays closed until its full acceptance flow exists.

The host refresh coordinator checks the durable binding before fetching pages, reconciles an already committed request without refetching, and retains a prepared capture for an uncertain publication retry. Prepared captures are private recovery material, never model responses or logs. Detected access loss requires a host denial before the database update. The append-only denial journal survives reconstruction; unsafe, missing or corrupt journals fail closed. Runtime startup cannot initialize or reset it. Explicit setup and inclusion in protected host backups are still part of the pending operator integration. The journal contains binding references and denial reasons, never OAuth tokens. Actual coordinator/knowledge disclosure must consult this journal before S03 can be enabled.

## Pending operator flow

The OAuth protocol module uses a desktop client, an exact IPv4 loopback callback, PKCE S256 and single-use state. Consent attempts expire after ten minutes and cannot be restored after process restart. Token exchange and refresh use only Google's HTTPS token endpoint, without redirects or automatic replay. Responses are bounded and validated; refresh rotation and time-based refresh expiry are retained. Provider error text, identity tokens and unknown response fields are excluded. These behaviors pass synthetic-response tests. Google supports desktop loopback callbacks and documents the PKCE exchange and refresh fields. [Installed-app authorization](https://developers.google.com/identity/protocols/oauth2/native-app).

The loopback listener now checks the actual bound host/port, callback path, method and state. It closes on timeout or cancellation, aborts an in-flight exchange when cancelled, and refuses overlapping callbacks without cancelling the first valid exchange. Browser responses contain no credential or provider-error text. Tests use a real local HTTP listener with synthetic Google responses.

The host credential owner stores validated token fields in private files outside Git. References are bound to one scope, connector and OAuth client. A kernel lock excludes concurrent owners; one owner coalesces concurrent requests. Refresh is journalled before dispatch, and rotation is saved and synced before the access token is released. An interrupted or uncertain refresh stops reuse and records a durable access denial. Private permissions do not establish disk encryption: the operator workflow must configure and verify storage encryption and protected backups.

The Pi administration path remains pending. The operator runbook must cover account consent, selected-calendar admission, host storage/backup protection and revocation before live linking is enabled. These components do not enable an account-link command by themselves.

## Host integration in development

The host store now constructs the calendar connector on its existing bounded PostgreSQL pool when `COS_CALENDAR_ENABLED=true`; the default is false. It first verifies the bound target and schema, then opens existing private `calendar/credentials`, `calendar/access-denials` and `calendar/oauth-client.json` under the target-state directory. Runtime startup never initializes these directories or repairs their ownership. Missing, permissive, linked or repository-contained roots fail closed. Client configuration stays in a host-only private file, outside worker mounts and the environment forwarded to workers.

The connector rereads scoped binding metadata before requests and after asynchronous credential acquisition and provider responses. Google requests use the fixed read-only reader; the fixture reader requires explicit test injection. Repeating a completed snapshot does not refresh credentials. Operator disconnect writes local denial before database revocation and remains available when refresh admission is disabled.

Before a provider check, the host takes a kernel lock and durably records that the check is in progress. Only the owning fence instance permits reads while that check runs. A settled check with no observed access loss removes the record; access loss or an interrupted check retains it. Failed denial writes also close the running process immediately. A reconstructed host refuses an interrupted check even if no denial file was successfully created. Such uncertainty requires a new authorised binding; startup never clears the record or replays the uncertain request. An actual killed-process test and a database-backed cached-answer test verify this behavior.

These development components do not establish storage encryption, backup coverage or live readiness. Operator setup/storage verification, backup integration, the complete preparation conversation and final release acceptance remain required before calendar activation on the Pi.

## Bounded model reads

`cos_context_get` includes up to ten selected-calendar coverage entries with binding IDs, calendar IDs, configured zones, snapshot windows and last-attempt/last-success timestamps. Follow `calendar.next_offset` using the request's `calendar_offset` field. An unconfigured connector reports `not_configured`; a processing profile with no selected calendars reports `not_connected`. Neither means an empty day.

`cos_calendar_read` accepts those binding/calendar IDs, explicit `time_min` and `time_max` instants, a limit of one to five events and an offset. It cannot choose another scope/provider, call an arbitrary endpoint, link an account, refresh the provider or write calendar events. Results preserve all-day dates and exclusive ends, order by the event's start in the configured zone, and carry exact S02 evidence references. A bounded preview is published as the first source chunk; complete provider details remain available through ordinary guarded source retrieval. Preview serialization is stable across PostgreSQL JSONB key ordering, and the returned preview must exactly occur in its cited chunk.

Unknown, disconnected, out-of-window or withheld event evidence produces a coverage warning. A snapshot change during a read returns a conflict or context denial rather than a stale empty result. Local and database permissions are checked again before disclosure.

For calendar preparation answers, `cos_answer_prepare` accepts `calendar: "coverage"`. The host appends the current selected-calendar coverage, configured zones, recorded windows and refresh timestamps. The model cannot supply or override those facts. The notice describes snapshot completeness within the recorded window, never current availability or an empty day. It lists at most ten entries and identifies omitted entries explicitly. Event claims still require ordinary checked citations.

Calendar views record a write-once, hash-only dependency for the native conversation generation before disclosing metadata. Subsequent answers inherit the checked notice even when they cite no event or omit the calendar option. Preparation, replay, historical reads and final publication recheck the dependency. Refreshes, local access loss, configuration changes or withdrawn evidence invalidate an exposed generation; a fresh generation is required. Dependencies include up to 100 selected-calendar entries across admitted bindings, including entries outside the ten-entry notice. Larger inventories fail closed rather than recording a partial dependency. This limit counts retained bindings, including disconnected ones.

These checks pass database-backed tests for empty calendars, late revocation, unchanged replay, owner/provider isolation and changes outside the displayed notice page. The complete packaged preparation conversation and release acceptance remain pending.
