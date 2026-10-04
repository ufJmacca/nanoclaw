# S07 calendar fixture correction — release acceptance pending

PR #62 was merged under the owner's explicit authorisation on 4 October 2026.
The reviewed head was `f8abac0d0b563c8537bc9254658dc2c16b316667`; the merge
was `903f5dba9afbc3053eb37dfa634632ebde61daf8`, with the same tree
`54ae1d30f88f83a39db547962eff525170c16636`.

Its exact-source release attempt,
`release-903f5dba9afb-20261003234432`, passed root and runner checks,
all 247 source contracts, the synthetic-week demonstration, worker checks,
native isolation and the first packaged profile's 247 contracts. The second
packaged profile passed 246 contracts and failed S04-T07's calendar-staleness
assertion. No bundle was exported or transferred and this source was not
activated on the Pi. The earlier healthy S07 candidate remains deployed.

The fixture generated its brief at a fixed instant but recorded the calendar
refresh at the actual database time. Its expected stale classification changed
when the real clock crossed midnight. The correction sets only that namespaced
test calendar's last-success time relative to the fixture clock, verifies fresh
coverage, then ages it two hours and retains the existing stale, disclosure and
revocation checks. Production freshness logic, source permissions and migrations
are unchanged.

Red: the original brief suite reproduced the failure, with 10 of 11 contracts
passing. Green: the corrected brief and proactive suites passed all 22 contracts
against the separate protected test database using verified TLS. Both S07 review
regressions also passed in the failed merged-source release.

Full exact-source ARM64 image tests, candidate delivery and Pi acceptance for
this correction remain pending. The correction requires its own reviewed merge
and actual merged-source release before S08 becomes eligible. The operator's
labelled A–D usefulness/false-positive assessment remains pending; approval to
merge PR #62 did not supply those ratings.

The Pi remains paused for CoS. No live model allowance, proactive policy,
mission/team admission or real account action was enabled. Protected messages,
sessions, credentials and all active S07 and S06 artifacts remain preserved.
Four obsolete S01/S02 payload caches and the completed S07 transport archive
were retired only after independent Mac backups and digest verification;
deployed images, runtime data and unrelated workloads were unchanged.
