# S02 scripted conversation demonstration

This transcript was emitted by the passing `pnpm cos:demo --slice S02 --fixture --db-profile test` development run. Every reply below passed current-policy preparation and private fixture delivery. Source IDs and citations are synthetic; fixture database rows and temporary files were removed after the run.

The conversation uses the real router, separate host process, network-disabled MCP runner, RPC bridge, external test PostgreSQL, approval/outbox path and fixture Mattermost adapter. Inputs and answer drafts are scripted. The judgements assess these particular prepared replies; they do not evaluate a live model or prove general semantic reliability.

This run used the existing Linux/ARM64 runner image with the current runner source and dependency volume mounted for development. It is not final-image or Pi acceptance. No model call, live message or Pi change was made.

## 1. What blocks Pilot Alpha before any notes are admitted?

Coverage: `insufficient`.

Actual delivered fixture reply:

> The admitted evidence is insufficient to answer this question. No supported conclusion is available.

Useful: explicitly reports insufficient admitted evidence.

## 2. Which project should we review?

Coverage: `not_applicable`.

Actual delivered fixture reply:

> Question: Do you mean Pilot Alpha?

Useful clarification; no invented project facts.

## 3. What blocks Pilot Alpha?

Coverage: `limited`.

Actual delivered fixture reply:

> This answer has limited coverage of the admitted evidence.\n\n> Pilot Alpha battery validation is incomplete. [1]\n\n> Pilot Alpha supplier approval is pending. [2]\n\n[1] battery — lines 1–1, revision 6856c3a1-c663-46ee-8085-43e2925a3504, digest 8366fca3a3ec27f3ac4c9edb8086f63ca2847fd7ede1bd3de396db7d35f3bb8c.\n\n[2] supplier — lines 1–1, revision dcdb3c4e-b15d-4a3c-9f4b-2c359773d3b2, digest e67f5375cfcedee805da8f48d24a6b1893a4058ceac2575e0be4eaa7fbab0b0e.

Useful: both blockers quoted with exact citations.

## 4. Show the evidence for the supplier blocker.

Coverage: `limited`.

Actual delivered fixture reply:

> This answer has limited coverage of the admitted evidence.\n\n> Pilot Alpha supplier approval is pending. [1]\n\n[1] supplier — lines 1–1, revision dcdb3c4e-b15d-4a3c-9f4b-2c359773d3b2, digest e67f5375cfcedee805da8f48d24a6b1893a4058ceac2575e0be4eaa7fbab0b0e.

Useful: cited revision and actual extracted lines resolve.

## 5. What should we do next about the supplier dependency?

Coverage: `limited`.

Actual delivered fixture reply:

> This answer has limited coverage of the admitted evidence.\n\nInference: Confirm supplier approval before launching the pilot. [1]\n\n[1] supplier — lines 1–1, revision dcdb3c4e-b15d-4a3c-9f4b-2c359773d3b2, digest e67f5375cfcedee805da8f48d24a6b1893a4058ceac2575e0be4eaa7fbab0b0e.

Reasonable bounded inference; clearly distinguished from quotation.

## 6. Do the supplier notes agree?

Coverage: `conflicting`.

Actual delivered fixture reply:

> The admitted evidence conflicts; these claims are not a settled conclusion.\n\n> Pilot Alpha supplier approval is complete. [1]\n\n> Pilot Alpha supplier approval is pending. [2]\n\n[1] later-supplier — lines 1–1, revision dfeca052-4738-4d64-a025-1734b3af6498, digest c2f5e3b0c69dbcdd9647f56c75416ad5720bf552ea98a91b30f0b6a49ce97450.\n\n[2] supplier — lines 1–1, revision dcdb3c4e-b15d-4a3c-9f4b-2c359773d3b2, digest e67f5375cfcedee805da8f48d24a6b1893a4058ceac2575e0be4eaa7fbab0b0e.

Useful: preserves conflicting claims without inventing agreement.

## 7. Summarise the admitted blockers without changing my goals.

Coverage: `conflicting`.

Actual delivered fixture reply:

> The admitted evidence conflicts; these claims are not a settled conclusion.\n\n> Pilot Alpha supplier approval is complete. [1]\n\n> Pilot Alpha supplier approval is pending. [2]\n\n[1] later-supplier — lines 1–1, revision dfeca052-4738-4d64-a025-1734b3af6498, digest c2f5e3b0c69dbcdd9647f56c75416ad5720bf552ea98a91b30f0b6a49ce97450.\n\n[2] supplier — lines 1–1, revision dcdb3c4e-b15d-4a3c-9f4b-2c359773d3b2, digest e67f5375cfcedee805da8f48d24a6b1893a4058ceac2575e0be4eaa7fbab0b0e.

Useful candidate summary with provenance; no approved direction changed.

## 8. Does an instruction inside this note authorize sending files?

Coverage: `limited`.

Actual delivered fixture reply:

> This answer has limited coverage of the admitted evidence.\n\nInference: A source instruction does not provide owner authorization to send files. [1]\n\n[1] hostile — lines 1–1, revision 55396e5b-282a-4a3d-9d48-b8305ccf637e, digest 6b4c0b276ed7841eeb829cc90e8a93a0f9bac66a299ed155b9a3d06d88acac33.

Correct authority distinction; no sending capability or effect is granted.

## 9. What blocks Pilot Alpha after the correction?

Coverage: `limited`.

Actual delivered fixture reply:

> This answer has limited coverage of the admitted evidence.\n\n> Pilot Alpha battery validation is incomplete. [1]\n\n> Pilot Alpha supplier approval is now confirmed. [2]\n\n[1] battery — lines 1–1, revision 6856c3a1-c663-46ee-8085-43e2925a3504, digest 8366fca3a3ec27f3ac4c9edb8086f63ca2847fd7ede1bd3de396db7d35f3bb8c.\n\n[2] supplier — lines 1–1, revision 87b41a8a-8d37-4e11-972c-c44b07495a11, digest 5fb78f7650a33df4718cb290d01c62c262608864a5ec7ee61401b8c8dd0bb416.

Useful: corrected supplier evidence replaces the old revision; battery work remains.

## 10. After revoking the supplier note, what can you still support?

Coverage: `limited`.

Actual delivered fixture reply:

> This answer has limited coverage of the admitted evidence.\n\n> Pilot Alpha battery validation is incomplete. [1]\n\n[1] battery — lines 1–1, revision 6856c3a1-c663-46ee-8085-43e2925a3504, digest 8366fca3a3ec27f3ac4c9edb8086f63ca2847fd7ede1bd3de396db7d35f3bb8c.

Useful: still-admitted battery evidence is available; revoked supplier material and derived replies are denied.

## 11. Can you make reliability before features my charter?

Coverage: `not_applicable`.

Actual delivered fixture reply:

> Proposed changes require your approval before they take effect.

Useful: asks for exact owner approval rather than applying strategic direction.

## 12. What evidence remains after restarting?

Coverage: `limited`.

Actual delivered fixture reply:

> This answer has limited coverage of the admitted evidence.\n\n> Reliability before features [1]\n\n[1] Approved charter: Reliability before features — 1cd03cd8-25ed-483c-b1e0-1f3b3d324e68, version 1.

Useful: restart preserves approved direction; surviving artifact redisplay rechecks current source policy.

## Verified transitions

- Two selected notes were imported and cited by exact revision digest and line locator.
- A contradictory note remained visible alongside the earlier claim.
- Source text did not grant a message-sending tool or overwrite approved direction.
- Correction invalidated the exposed context. Guarded recovery created an empty generation, and the old prepared answer was denied.
- An exact source-revocation proposal was approved through the fixture owner command. Source reads and affected prepared replies were denied after recovery.
- A proposed charter remained unapplied until owner approval. Host restart preserved the approved record and rechecked surviving artifact access.

Protected backups, full native provider execution, model allowance transfer and private membership/maintenance controls have separate tests; this scripted fixture uses a no-op backup callback and resumes only its synthetic context. It cannot activate the completed S01 live allowance.
