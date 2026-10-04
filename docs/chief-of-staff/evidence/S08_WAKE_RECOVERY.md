# S08 review correction — retired mandate wake recovery

PR [#64](https://github.com/ufJmacca/nanoclaw/pull/64) was merged by the repository
owner on 5 October 2026. Its actual merged source is
`c52dd08a9ec963e969ec987d470a4452dcee3c27`, with the same tree as its reviewed
head. A [P1 review finding](https://github.com/ufJmacca/nanoclaw/pull/64#discussion_r4179592987)
requires a correction before S08 merged-release acceptance and S09.

When an active mandate temporarily loses eligibility, the host retires its
native wake. Previously, restoring eligibility with the same revision and wake
time could not stage that clock again. The retained completed row and ownership
marker prevented recovery, including after a host restart.

The correction restores an exactly verified completed host clock to `paused`
inside the existing SQLite transaction. It preserves the task identity, content,
source-evaluation digest and ownership marker. It creates no pending model
message. The pump must still obtain a fresh PostgreSQL grant before evaluation;
clock repair cannot authorize a mission or revive an obsolete mandate revision.
Altered rows and foreign bindings remain rejected. No migration is added or
modified.

## Red → green evidence

The repository development container ran the two mandate native/pump test files
against unchanged merged production code. Three tests failed and six passed:
re-staging a retired clock after restart, resuming the same wake after temporary
ineligibility, and obtaining a new grant on recovery. The private red log is
retained.

After the correction, all nine tests passed. They verify retained identity and
evaluation history, quiet future clocks, overdue evaluation, fresh grant denial,
rejection of altered/foreign rows, no duplicate native row, no due model message,
and the existing emergency-pause behavior.

Full source/contract/demo checks, final Linux/ARM64 image checks, exact Pi delivery
and native/preservation evidence are **pending for this correction**. The previous
healthy schema-15 candidate and its recovery artifacts remain retained. Its
evidence is in [the original S08 receipt](S08.md). No correction artifact has been
transferred or activated yet.

The correction needs its own reviewed merge because PR #64 is already merged.
After that merge, build/test and deploy the actual final merged source before
starting S09. S08 live activation remains separately pending: CoS stays paused,
no mandate is active, and this correction makes no live model call or real
message. The programme is incomplete.
