# S02 — Answer from admitted knowledge with citations

**Status:** not started  
**Branch:** `cos/s02-grounded-knowledge`  
**Depends on:** S01 merged with its acceptance receipt.  
**Delivery unit:** one independently reviewable PR.  
**Outcome:** import selected notes, answer a project question with inspectable evidence, correct a source and revoke access.

Read [shared execution rules](SLICE_EXECUTION_RULES.md); all referenced security, external DB, release and handover contracts apply.

## Demonstration

Import two synthetic Pilot Alpha notes. Ask what blocks the project; cite exact source revisions/locators. Import a contradictory later note and show disagreement or supersession, not invented consensus. Revoke the first source; it cannot be retrieved or reused in a fresh answer.

## Scope

UTF-8 Markdown/text from an explicitly selected staging root or authenticated attachment; revisioned capture, deterministic extraction/chunking, PostgreSQL full-text search, evidence, correction and revocation/deletion. Binary PDF/Office parsing, embeddings, email/Drive and arbitrary host crawling are deferred and reported as unsupported.

## Implementation sequence

1. Add a host-owned artifact root outside Git and agent mounts. Canonicalise paths, reject symlink traversal, enforce size/encoding and scope. Never read an arbitrary model-supplied host path or recursively ingest the home directory.
2. Store source identity, content digest, immutable revision, actual locator, capture time, origin access policy and model-processing policy. Publish bytes atomically/checksummed before marking complete; reconcile orphan staged bytes and use a transactional outbox for subsequent work.
3. Extract text with heading/line or byte locators and scoped full-text indexes. Add `cos_knowledge_search` and `cos_source_get`, bounded snippets/pages/context, current access filtering before ranking and again before return.
4. Make source-derived claims cite evidence. Distinguish inference, quotation, missing/stale coverage and contradictions. Source instructions never become authority; whole sources are not added to every prompt.
5. Store derivation edges linking candidate summaries/answers to revisions. Corrections create new revisions or explicit supersession. Do not rewrite old citations or promote agent notes into approved strategic direction.
6. Add owner-controlled revoke/delete through the exact proposal path. Immediately block retrieval/publication/reuse, quarantine derivatives and stop/reset affected active contexts. Apply configured retention; append-only captures are still deletable under policy.
7. Expose inventory states: admitted, indexing, current, stale, revoked, failed and unsupported. Explain that delivered chat/provider inputs cannot be retracted and backup expiry is separate.

## Data and tools

Add Source, SourceRevision, Chunk, EvidenceRef, Artifact, DerivationLink and RevocationTombstone. Evidence contains a source revision digest and real locator. Source get returns authorised content, not arbitrary host paths. Filters cannot override host-derived scope. Future workers use the same API through a mission source allowlist; no DB mount/credentials.

Raw bytes stay local; metadata/indexes are external. A staged file is not admitted until its remote transaction is confirmed. Database-policy uncertainty blocks private content and historical artifact redisplay; an unchecked cache is not an availability fallback.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S02-T01 | Scope B sources are absent from scope A results, snippets, scores and logs. |
| S02-T02 | Cited locator/digest resolves to the supporting revision. |
| S02-T03 | Same bytes replay safely; changed bytes create a revision with intact history. |
| S02-T04 | Traversal, symlink escape, oversized and unsupported binary inputs fail safely. |
| S02-T05 | Instructions embedded in a source cannot invoke privileged operations. |
| S02-T06 | Revocation blocks search/get and prepared output publication, not just display. |
| S02-T07 | Contradictions remain visible; candidate summaries cannot overwrite goals. |
| S02-T08 | Artifact publication crash leaves no falsely complete record and recovers safely. |
| S02-T09 | Processing policy excludes sources from disallowed model providers. |
| S02-T10 | Fresh answers exclude corrected/revoked cached material. |
| S02-PG01 | Disconnect between file publication and remote commit reconciles one revision. |
| S02-PG02 | Database-policy unavailability blocks private retrieval and historical redisplay. |

Use synthetic canaries and inspect actual context construction; asking an LLM whether it saw a secret is insufficient. Citation validity blocks acceptance; semantic answer quality is assessed separately.

## Acceptance, rollback and handover

Complete import → ask → cite → inspect → correct → revoke with at least ten representative questions covering empty, conflicting and insufficient evidence. Record useful-answer judgements without claiming universal accuracy. Disable ingestion/retrieval independently while retaining S01 and all tombstones; rollback cannot resurrect revoked content.

Follow the common Mac tests, exact-image/pinned-source delivery, Pi smoke, review and checkpoint requirements. Receipt: `docs/chief-of-staff/evidence/S02.md`. Preserve live activation as a separate state and proceed to S03 only after verified human merge.
