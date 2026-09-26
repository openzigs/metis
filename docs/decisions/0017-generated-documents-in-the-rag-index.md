# 0017 — Generated documents stay in the RAG index as labelled, derived, reviewable material

- **Status**: Accepted
- **Date**: 2026-09-25
- **Issue**: [#189](https://github.com/openzigs/metis/issues/189)
- **Relates to**: #1353 (the SQL-authoritative primary-evidence gate this relies on)

## Context

Every finished document generation publishes the document into the project's RAG index
as a synthetic `gendoc-<generatedDocumentId>:<revisionId>` document
(`server/src/lib/docs-gen/generated-doc-publication.ts`). #189 found that this ingest
had never completed. The embedding blocked the server's main thread, and every
earlier generated document was stuck at `processing`. The issue asked for a decision:
should generated documents be embedded at all? If they should, they must never become
source truth, and above all never a grounding source when the next generation is
fact-checked.

## Decision

**Yes, keep publishing them, under four rules that already hold or that #189 adds:**

1. **Never primary evidence for docs-gen.** Every docs-gen retrieval path (section
   grounding in `grounding/grounding-retrieval.ts`, and the input fingerprint in
   `generation-inputs.ts`) passes through `filterPrimaryEvidence`
   (`evidence-filter.ts`). That filter drops generated evidence by any of six markers:
   the `gendoc-` id prefix, `generated/` storage, the `docsgen:` chunker identity,
   `metadata.source = "generated-doc"`, `metadata.generatedDocumentId`, and the current
   document's own id. The faithfulness judge reads only that filtered grounding
   context. An explicit shared-reference allowlist cannot override it. #189 adds an
   end-to-end test that publishes and approves a generated document, then shows the
   filter rejects its real persisted chunk rows while it still accepts an ordinary
   document's chunk.
2. **Labelled as derived.** Each chunk now carries
   `metadata.evidenceClass = "derived-generated-doc"`, together with the generated
   document's `status` (`ready`/`degraded`) and `scope` (`full`/`module`/…). Any
   consumer can tell a degraded or scoped document from a source. The synthetic
   filename, `generated-doc-<id>.md`, already names the file as generated in every
   citation.
3. **Reviewed, not trusted.** The synthetic document is created with
   `autoApproveTrusted: false`. It goes live only when an operator approves it, or when
   the project opts into auto-approving trusted sources. Until then it waits in
   quarantine and now shows as `ready` (pending review), as an upload does, not as
   `processing`.
4. **Bounded to ingest.** Chunks are at most 1,500 characters (chunker `docsgen:v2`).
   They are embedded in batches of 32 in the embed worker thread, never on the event
   loop.

## Why not drop generated documents from the index

Chat, analysis and Spec-Kit users ask questions that the generated documentation
answers well, such as "what does module X do?" and "where is Y configured?". Removing
the documents would remove that, and removing them would not make docs-gen any safer:
rule 1 already stops the self-reinforcing loop, and it is enforced in SQL.

## Consequences

- **Known gap:** chat's system prompt (`routes/ai.ts`) calls every retrieved excerpt
  "the authoritative source". It does not yet print the derived label next to a
  generated-document excerpt. The label is persisted by this change, so fixing the gap
  is display work only. It is left to a follow-up because `routes/ai.ts` is under
  active change in another PR.
- A generated document that is `degraded` is still published. It is labelled, not
  withheld.
