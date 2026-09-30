# Calendar awareness implementation

S03 is in progress. The calendar reader and snapshot collector exist; account linking, durable snapshots, evidence integration and conversational coverage are not connected yet. No real calendar account has been linked or queried.

## Read contract

The host reader exposes access status, event listing and event lookup. It builds fixed Google Calendar HTTPS GET requests and refuses redirects. An owner's selected calendar IDs constrain every request even if the supplied token has broader scopes. Tokens are supplied through a host-only callback and never appear in returned events or operational errors.

The intended authorization scope is `calendar.events.readonly`. Calendar selection uses explicit IDs, so the implementation does not need CalendarList or calendar-write permission. The OAuth operator flow remains to be implemented and tested. Google documents event-read scopes separately from calendar-management scopes. [Scope reference](https://developers.google.com/workspace/calendar/api/auth).

## Snapshot and time policy

The default window covers 30 calendar days back and 90 forward in the configured IANA zone. One frozen window is used across pagination. The reader requests expanded recurring instances and cancellation markers, follows opaque page tokens, and does not use incremental sync tokens. The collector returns only after all pages and access checks succeed. Empty pages with a continuation token are followed. Repeated tokens, conflicting duplicate revisions, changed access roles and excessive pages fail closed. [Events list reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

All-day values remain dates with an exclusive end date. Timed values become instants displayed in the configured zone. A zone-only local time must resolve uniquely; DST gaps and overlaps are rejected. An explicit numeric offset must agree with its supplied zone. Moved recurring instances retain their original occurrence identity. Minimal cancelled events are retained as content-free tombstones. [Event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events), [Temporal time-zone policy](https://tc39.es/proposal-temporal/docs/zoneddatetime.html).

Each page is bounded to 250 events and a 1 MiB response; a snapshot is bounded to 20 pages, 5,000 distinct events and 8 MiB of normalized content. Each request permits at most three HTTP attempts, a 10-second per-attempt transport deadline and a 30-second overall request deadline. Rate limits and selected transient server errors use bounded backoff. A provider retry hint above the available wait budget stops the operation rather than retrying early. Authentication and access failures are not retried. [Google error handling](https://developers.google.com/workspace/calendar/api/guides/errors).

These are local capture limits, not a claim that Google's pages form a transactionally consistent external snapshot. Database publication and retirement of unseen observations must be atomic and are still outstanding. The collector alone does not provide that guarantee.

## Pending operator flow

The planned operator flow uses a desktop OAuth client, a loopback callback, PKCE S256 and a single-use state bound to the exact callback. Host-only token storage, refresh/revocation and the Pi administration path still need implementation and fixtures. The operator runbook will document account consent, selected-calendar admission and revocation before any live connection is offered. Google supports loopback callbacks for desktop clients and documents the PKCE exchange. [Installed-app authorization](https://developers.google.com/identity/protocols/oauth2/native-app).
