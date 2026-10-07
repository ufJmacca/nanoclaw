# S11: deterministic approval-fixture correction

**Status:** test-only correction ready for review. The accepted Pi application remains the exact reviewed `e916c4d1388a141ea6095a215742f39521d4b7b2` release, healthy and protected. Programme closure awaits this correction's human merge and the required acceptance of the resulting merged source.

[Final application acceptance documentation](https://github.com/ufJmacca/nanoclaw/pull/70) records all eleven implementation merges, the seven mandatory release gates, exact Linux/ARM64 artifacts, Pi-native checks, actual protection and preserved data. Its first CI run exposed a date-dependent test fixture after those release checks had passed. The final programme checkpoint was not executed.

## Reproduction and correction

The S09 calendar approval preview test fixed the event start at `2026-10-06T22:00:00Z` while calculating its approval expiry from the real clock. In the documentation PR's CI run after that instant, expiry was later than the event start. The production validator correctly rejected the malformed approval envelope, so no preview was produced and the test failed while reading the absent preview.

The unchanged test reproduced locally in the repository development container: six tests passed and one failed with the same missing-preview error. The original CI failure (2,743 passed, one failed) and local red log remain separate private evidence. This is independent of the earlier packaged-host calendar-disconnect failure, whose exact cause remains uncaptured.

The fixture now uses `2026-10-06T21:00:00Z` for both its expiry calculation and its per-test mocked clock. Each test restores the clock mock afterward. The event, exact-effect assertions and production validation/expiry guards are unchanged. A further regression advances the fixture clock to the exact expiry and verifies that no preview, acknowledgement or application occurs.

## Validation and delivery boundary

The eight outbox tests pass. The complete development-container host suite passes 2,745 tests across 270 files. Host type checking, affected-file lint and the full source-format check pass. These checks use fixtures and make no live model calls or real account effects.

This change modifies only test code and this receipt. It has not been built into or deployed as a replacement application release. The Pi's accepted source, protected lifecycle, service, messages, sessions and credentials remain unchanged. Following the [human merge and exact-source delivery contract](../../chief-of-staff-plans/GOAL.md), the next step is legitimate human review/merge, then fresh mandatory release gates and Pi acceptance of that merged identity. Do not relabel the existing images or infer programme completion from the test-only green run.
