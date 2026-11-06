# 0022 — Chat questions and answers do not go into the vector store

- **Status**: Accepted
- **Date**: 2026-11-05
- **Issue**: [#1844](https://github.com/openzigs/metis/issues/1844) (epic [#1829](https://github.com/openzigs/metis/issues/1829))
- **Relates to**: #1842 (prompt caching for the tool loop), #1843 (the content version and
  the tool-result cache), #1841 (approved requirements found by meaning in chat), #1845
  (measuring all three before any default changes)

## Context

Chat costs money and time every turn. One proposal was to embed each chat question and
answer into the vector store and serve a stored answer for any later question that is
close enough in meaning. METIS already has a narrower version of that idea: the semantic
answer cache (`server/src/lib/ai/semantic-cache.ts`, #651). It is in process, holds 1,000
entries for 30 minutes, and is off by default (`SEMANTIC_CACHE_ENABLED`).

Before #1844 that cache was keyed on the model, the system-prompt hash and the project. It
matched at cosine ≥ 0.92 and recorded neither the code version nor the document version,
so an answer computed before a re-ingest could be served after it.

What the system-prompt hash covers was traced for this decision (`routes/ai.ts`, the
`/chat` handler). It hashes every system-role message of the turn: the persona and
skills, any compaction summary, and the auto-RAG context retrieved for this question from
the project's documents. It therefore varies with the project's document context, but not
with the project's code, which chat reads only through tools, and not with the
conversation history, because user and assistant turns are not system messages.

## Decision

**We do not store chat questions and answers in the vector store.**

The in-process semantic cache stays, hardened by #1844 for a measured trial and still
**off by default**:

1. Every entry is scoped to the model, the system-prompt hash, the project, the project's
   **content version** (#1843: each code graph's commit and index time, the symbol
   embeddings, every document's indexing state, and the embedder model), the **caller**
   and a hash of the **conversation so far**. An entry stored before a re-ingest is never
   returned after it, and a follow-up question ("and the second one?") matches only in the
   same conversational context.
2. An exact match on the normalised question text is tried first. The similarity path
   needs **≥ 0.97** by default (`SEMANTIC_CACHE_THRESHOLD` still overrides it).
3. A turn whose answer used **any tool** is never stored, because the answer depends on
   what the tools retrieved.
4. A project whose content version is incomplete (a code graph with no commit SHA) is
   neither looked up nor stored.

## Why not store question and answer pairs in the vector store

- **Version drift.** A chat answer depends on the code graph, the document set, the
  caller's access scope and the conversation. A vector-store row keyed by the meaning of
  the question cannot express those dependencies. Invalidating it when any of them
  changes is the hard part, and a fuzzy key gives nothing exact to invalidate on.
- **Near-miss false positives.** Measured false-positive rates for semantic caches are
  roughly 3–7% at a 0.93 threshold and 7–15% at 0.90 (respan.ai, 2026). METIS's old
  default was 0.92. Questions that sit close together in embedding space can still need
  different answers ("which files handle refunds?" and "which files handle refund
  approvals?"), and for an analyst a confident wrong answer costs more than a slow right
  one. Precision matters more than recall (MeanCache, arXiv 2403.02694).
- **Derived content with no provenance.** A stored answer is model output, not source
  material. Indexing it beside documents would let chat and analysis retrieve it as if it
  were evidence. That is the same reason generated documents are excluded from docs-gen
  grounding ([0017](0017-generated-documents-in-the-rag-index.md)).

## What we do instead

- **Prompt-cache the tool loop (#1842).** Each tool-loop call re-reads the earlier
  transcript at the cached rate. The answer is computed fresh, so nothing can be stale.
- **Exact-key tool-result cache on the content version (#1843).** A repeated search on
  unchanged code and documents is not re-run. The key is exact, so it is safe in a way a
  similarity match is not.
- **Approved requirements found by meaning (#1841, epic #1828).** These are the "already
  known" answers. A person approved them and their code citations are validated, so they
  carry provenance and are kept fresh when code moves (#1827).

## Consequences

- The semantic cache stays off. #1845 measures its hit rate against its wrong-answer rate
  at 0.92, 0.95 and 0.97, before and after a re-ingest, and recommends whether to keep it
  off or retire it.
- Persisting the semantic cache or the tool-result cache to the database is not planned.
  It is recommended only if #1845's hit rates justify it.
- Because the conversation is part of the key, the cache mostly helps a question repeated
  at the start of fresh sessions, or asked again after the same exchange. #1845's hit rates
  will show whether that is enough to keep it.
