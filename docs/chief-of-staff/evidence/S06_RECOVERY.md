# S06 deployment recovery correction

PR #60 was human merged as `074befc0f421290855ca5878ce6a918b2fe9aa33`.
Its exact merged-source release passed all seven local gates, but the Pi health
gate failed and automatically restored the compatible schema-13 S06 candidate.
The ordinary service is running and CoS admission remains closed. Protected
SQLite, sessions, credentials and release receipts were retained. No old SQLite
backup was restored.

The original health error was discarded by the helper, so its cause is not
established. Subsequent read-only schema/profile/image checks and an isolated
native smoke test against the same merged image passed. These checks do not turn
the failed deployment into an accepted release.

This correction records the precise health gate and a fixed, sanitised error
classification before compatible rollback. Process readiness uses the existing
bounded startup helper; unrelated process failures are rejected immediately.
It also fixes a separate regression: S06 was incorrectly treated as older code
when permanent specialist state existed. S01–S04 and legacy code still refuse
that state, without deleting it.

The compatibility regression was red before the fix. The focused compatibility,
health, process-readiness, target-effects and deployment suite passed 49 tests.
Full release gates, Pi acceptance and human review of this correction remain
pending. Tests use fixtures; live model/message authority is not renewed by this
change.
