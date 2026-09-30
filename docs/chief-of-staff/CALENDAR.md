# Calendar awareness implementation

S03 is in progress. The calendar readers, snapshot collector and PostgreSQL snapshot store exist; account linking, evidence integration and conversational coverage are not connected yet. No real calendar account has been linked or queried.

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

Stable snapshot identities reconcile retries and lost acknowledgements. Concurrent duplicate publication creates one revision per changed event; an older refresh cannot overwrite a newer attempt. Revoked, expired or disconnected bindings hide cached observations immediately at this store boundary. Reconnection requires a newly authorised binding. Integration with S02 source/answer invalidation remains pending, so this store is not yet exposed to the coordinator.

The external test database has schema 3. The Pi remains on the accepted S02 schema 2 release. S03 release registration stays closed until its full acceptance flow exists.

The host refresh coordinator checks the durable binding before fetching pages, reconciles an already committed request without refetching, and retains a prepared capture for an uncertain publication retry. Prepared captures are private recovery material, never model responses or logs. Detected access loss requires a host denial before the database update. The append-only denial journal survives reconstruction; unsafe, missing or corrupt journals fail closed. Runtime startup cannot initialize or reset it. Explicit setup and inclusion in protected host backups are still part of the pending operator integration. The journal contains binding references and denial reasons, never OAuth tokens. Actual coordinator/knowledge disclosure must consult this journal before S03 can be enabled.

## Pending operator flow

The OAuth protocol module uses a desktop client, an exact IPv4 loopback callback, PKCE S256 and single-use state. Consent attempts expire after ten minutes and cannot be restored after process restart. Token exchange and refresh use only Google's HTTPS token endpoint, without redirects or automatic replay. Responses are bounded and validated; refresh rotation and time-based refresh expiry are retained. Provider error text, identity tokens and unknown response fields are excluded. These behaviors pass synthetic-response tests. Google supports desktop loopback callbacks and documents the PKCE exchange and refresh fields. [Installed-app authorization](https://developers.google.com/identity/protocols/oauth2/native-app).

The actual callback listener, host credential owner/storage and Pi administration path remain pending. The credential owner must serialize refresh, durably publish rotated tokens before returning access tokens, and stop reuse after an uncertain exchange. The operator runbook must cover account consent, selected-calendar admission, host storage/backup protection and revocation before live linking is enabled. No account-link command is enabled by this protocol module alone.
