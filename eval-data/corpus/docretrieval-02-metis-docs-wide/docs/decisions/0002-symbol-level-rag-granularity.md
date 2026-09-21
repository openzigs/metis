# ADR 0002 — Symbol-level RAG granularity

- **Status:** Accepted
- **Date:** 2026-07-08
- **Resolves:** GitHub #716 (Epic #712 stretch/spike)
- **Related:** #714, #713, #715, #717 (epic #712 shipped work); #507/#508/#509 (symbol index)

## Context

METIS grounds project-scoped chat, Spec-Kit, and analysis in three retrieval
surfaces:

- **Index #1 — source-as-RAG (document level).** `ingestSourceAsKnowledge()`
  (`server/src/lib/connectors/connector-ingest.ts` L408) walks a cloned/uploaded
  repo, wraps each whole source file in a markdown fence
  (`` # <relPath>\n```<ext>\n<content>\n``` ``, L426–429), and ingests it under a
  filename prefixed `connector:repo:<connectorId>:src/<relPath>` (L427). Those
  documents are then split by the shared chunker
  (`server/src/lib/rag/chunker.ts`) into **~2048-char (~512-token) overlapping
  chunks** (`DEFAULT_CHUNK_SIZE = 2048`, `DEFAULT_OVERLAP = 256`, L44–45). A
  chunk's `position` is a **chunk index, not a line range** — so a source-as-RAG
  hit knows *which file* and *which slice* it came from, but **cannot emit a
  `file:startLine-endLine` locator**. (The issue estimated "~1024-token" chunks;
  the verified default is ~512 tokens. Either way the granularity is a
  document slice, not a symbol.)
- **Index #2 — symbol records.** `CodeSymbol`
  (`server/prisma/schema.prisma` L3056) persists one row per parsed
  function/class/interface/type/module/method/table/column with **authoritative
  `startLine` / `endLine`** (L3064–3065), `qualifiedName`, `filePath`,
  `language`, and `contentHash`.
- **Index #3 — symbol embeddings + hybrid search.**
  `SymbolEmbeddingPipeline` (`server/src/lib/code-graph/symbol-embeddings.ts`
  L124) embeds each symbol's formatted name/signature/docstring/body-preview
  incrementally (SHA-256 skip). `HybridCodeSearch.search()`
  (`server/src/lib/code-graph/hybrid-search.ts` L243) fuses **BM25 (keyword)**
  over symbol name/qualifiedName/signature/docstring with **vector similarity**
  via Reciprocal Rank Fusion, returning ranked symbols.

The spike question: should the **document RAG store** *also* gain symbol-level
granularity, or does the symbol index (#2/#3) already deliver the tight, citable
spans the epic wanted? Three options were on the table:

- **(a)** re-chunk source at symbol boundaries inside `ingestSourceAsKnowledge()`
  so RAG chunks align to functions instead of 2048-char windows;
- **(b)** persist each `CodeSymbol` as a first-class RAG chunk (dual-write symbols
  into the document vector store);
- **(c)** rely solely on the symbol index (#2/#3) for tight spans, leaving
  source-as-RAG as a coarse document fallback.

### What changed since the issue was filed

Option (c) is **no longer hypothetical** — it shipped across epic #712 while this
spike sat in the backlog:

- **#714 (fused passive retrieval).**
  `server/src/lib/rag/fused-code-context.ts` (`fuseCodeContext` +
  `buildFusedCodeBlock`) queries `HybridCodeSearch` and merges the top symbol
  hits into the retrieved-knowledge block for **both** chat
  (`buildAutoRagContext`, `server/src/routes/ai.ts`) and Spec-Kit
  (`buildSpecKitRagContext`, `server/src/lib/spec-kit/rag-context.ts`). Each hit
  renders a **`filePath:startLine-endLine` locator** sourced from the
  `CodeSymbol` row (L152–157). It **dedupes** symbol hits against source-as-RAG
  chunks by parsing the `connector:repo:<connectorId>:src/<relPath>` filename
  (`extractRepoRelPath`, L128–132; `isCoveredByRag`, L139–150) so the same file
  is **never double-injected** from both indices, and it is token-budgeted so RAG
  doc chunks are never dropped. Env-gated `CHAT_FUSED_CODE_RETRIEVAL`, OFF by
  default (`server/src/routes/ai.ts` L331).
- **#713 (agentic tools).** Chat/stream sessions can execute
  `search_code_graph` (exact qualified-name / caller / callee traversal) and the
  new `search_code_symbols` (hybrid BM25+vector,
  `server/src/lib/analysis/tools/search-symbols.ts`), each returning
  `filePath:startLine-endLine` locators (L96–102). Env-gated
  `CHAT_CODE_SEARCH_TOOLS`, OFF by default (`server/src/routes/ai.ts` L864).
- **#715 (citation policy)** makes the model *use* those locators; **#717**
  is the epic's regression guard that a grounded answer cites a **derived**
  `CodeSymbol` locator, not a reconstruction.

So the real question this record must answer is **narrower** than the issue's
original framing: not "does METIS need symbol-level retrieval?" (it has it, via
#2/#3/#714/#713), but "**what is the marginal value of also giving the document
RAG store symbol granularity, on top of the symbol index that already serves
tight, citable spans?**"

## Evaluation rubric

| Criterion | (a) symbol-boundary RAG chunks | (b) `CodeSymbol` as RAG chunks | (c) rely on symbol index (#2/#3, shipped via #714/#713) |
| --- | --- | --- | --- |
| Citable `file:line` span | Partial — chunk carries a line offset only if the chunker is taught line ranges (it is not today) | Yes, if `startLine`/`endLine` copied into chunk metadata | **Yes today** — locators render from `CodeSymbol` (fused-code-context L152) |
| New production code | Re-chunker + line-tracking in `chunker.ts` + `connector-ingest.ts` | Dual-write pipeline + new chunk source + dedupe | **None** — already merged |
| Storage / index cost | ~same doc volume, more chunks | **Doubles** symbol storage (LanceDB doc store *and* symbol embeddings) | No change |
| Duplicate-hit risk | High — same source now in doc + symbol index | High — literally the same symbols in two vector stores | **Solved** — #714 dedupes symbol hits vs source-as-RAG (`isCoveredByRag`) |
| Ranking quality | Loses BM25-over-signature/docstring; falls back to generic doc chunk text | Re-embeds symbols with the *doc* embedder, losing the symbol-tuned formatting | Uses symbol-tuned BM25 + vector RRF (`hybrid-search.ts`) |
| Incremental re-index | Full re-chunk on file change | New hash-skip path to build | Already incremental (`SymbolEmbeddingPipeline` SHA-256 skip) |
| Retrieval breadth | Symbol-only; loses whole-file/context-window docs | Adds symbols, keeps docs (redundantly) | Keeps coarse docs *and* adds symbol precision — complementary, not either/or |

## Decision

**NO-GO on options (a) and (b). Adopt option (c): rely on the symbol index
(#2/#3) — already wired into chat + Spec-Kit by #714 (passive fused retrieval)
and #713 (agentic tools) — for tight, citable spans. Leave source-as-RAG as the
coarse whole-file document fallback it is.** No production code change is
required to close #716.

The document RAG store and the symbol index are **complementary layers, not
competitors**: the symbol index answers "show me *this function*, cited to
`file:line`," while source-as-RAG answers "give me surrounding whole-file
context." #714's dedupe (`isCoveredByRag`) already lets them coexist without
double-injecting the same source. Bolting symbol granularity onto the document
store would collapse that separation, duplicate storage, and re-solve — worse —
the ranking and dedupe problems the symbol index already handles.

## Rationale

1. **The precise-citation goal is already met by a different index.** The epic's
   driving pain — "RAG hits are broad and hard to cite" — is fixed by #714/#713
   *emitting `CodeSymbol` line spans*, not by re-chunking the document store.
   Options (a)/(b) would chase a capability METIS already ships.
2. **Structural granularity fact (verified, not opinion).** Source-as-RAG
   chunks carry `position` = **chunk index, not line numbers**
   (`fused-code-context.ts` L47–48, L145–146 document exactly this: "their
   `position` is a chunk index, not a line range"). A document chunk therefore
   **structurally cannot** produce the `file:startLine-endLine` locator the epic
   wanted, whereas a `CodeSymbol` row carries `startLine`/`endLine` natively
   (`schema.prisma` L3064–3065). Option (a) would need a new line-tracking
   contract threaded through `chunkMarkdown`; option (b) is a strictly redundant
   copy of index #2 into the doc store.
3. **Option (b) doubles cost for a copy.** It re-embeds the same symbols a second
   time (with the document embedder, which is *not* tuned on
   name/signature/docstring the way `formatSymbolForEmbedding` is), doubling
   vector storage and creating exactly the duplicate-hit problem #714's dedupe
   was built to prevent — except now the duplicate is *inside* one store.
4. **Ranking regression.** `HybridCodeSearch` scores BM25 over
   symbol-specific fields (name, qualifiedName, signature, docstring —
   `hybrid-search.ts` L166–171) and fuses with vector similarity via RRF.
   Symbol-boundary *document* chunks would lose that structure and fall back to
   generic prose BM25, a likely retrieval-quality regression for code queries.
5. **No measured semantic precision is trustworthy on this box (stated
   honestly, not hidden).** The local default embedder falls back to the
   **deterministic hash stub `metis-offline-hash-v1`** whenever the Xenova /
   sidecar backend can't load (`server/src/lib/rag/embedder.ts` L510–525:
   "Vectors written … will not match real semantic embeddings"). Hash vectors
   have **no semantic structure**, so any "precision@k" measured locally for the
   *vector* half of retrieval would be noise — comparing options (a)/(b)/(c) on
   local semantic numbers would be **fabrication dressed as evidence**. This
   record therefore rests on the **structural / lexical facts above** (all
   verified in source with cited line ranges) plus the BM25 lexical path that
   *is* deterministic, and explicitly declines to invent precision figures. See
   **Evidence** below for exactly what was and was not run.
6. **Reversibility & cost of waiting.** (c) is the zero-cost default (it is
   already live behind flags). If a measured eval later shows the coarse document
   layer hurting *non-symbol* code retrieval, (a)/(b) remain open — nothing here
   forecloses them. Choosing (c) now avoids speculative index work before the
   #712 features have any production telemetry.

## Evidence

Per the issue's non-negotiable evidence requirement, and being explicit about
the local constraint:

- **What could NOT be measured locally, and why.** Real semantic
  retrieval-precision (precision@k over an ingested corpus with true embeddings)
  is **not measurable on this box**: the embedder degrades to the offline hash
  stub `metis-offline-hash-v1` (`embedder.ts` L510–525), whose vectors are
  semantically meaningless. Reporting precision numbers from a hash-embedded
  index would be dishonest. **No semantic precision figures are fabricated in
  this record.**
- **What the decision rests on instead (structural evidence, each verified):**
  1. Source-as-RAG chunks lack line spans (`position` = chunk index) —
     `connector-ingest.ts` L426–429; `chunker.ts` L44–45;
     `fused-code-context.ts` L47–48, L145–146. ⇒ document RAG cannot cite
     `file:line`.
  2. `CodeSymbol` carries authoritative `startLine`/`endLine` —
     `schema.prisma` L3064–3065. ⇒ the symbol index can, and #714/#713 render it
     (`fused-code-context.ts` L152–157; `search-symbols.ts` L96–102).
  3. The two layers are already de-duplicated so they compose without
     double-injection — `fused-code-context.ts` `isCoveredByRag` L139–150.
  4. Symbol ranking uses symbol-tuned BM25 + vector RRF —
     `hybrid-search.ts` L166–171, L243–349 — which options (a)/(b) would not
     inherit.
- **Commands run:** `pnpm lint && pnpm typecheck && pnpm test` — see
  **Consequences → Verification** for raw results. The BM25 lexical path is
  deterministic and covered by `hybrid-search.test.ts`; the fused merge / dedupe
  / budget contract by `fused-code-context.test.ts`; the citation locator by
  `search-symbols.test.ts` — all green in the suite below. No bespoke
  precision-benchmark script was run, because a trustworthy one requires real
  embeddings this environment cannot provide; the honest alternative is the
  structural argument above plus a **measured follow-up trigger** (below) rather
  than invented numbers.

## Consequences

### Positive

- Zero new code, storage, or index-maintenance burden. The symbol index and its
  chat/Spec-Kit wiring (#714/#713) already deliver tight, citable spans.
- The document RAG store and symbol index stay cleanly separated
  (whole-file context vs cited symbol spans), with #714's dedupe keeping them
  from double-injecting the same source.
- No duplicate symbol embeddings; no ranking regression from prose-chunking code.

### Negative

- Source-as-RAG hits remain **un-citable to a line range** on their own — the
  coarse document layer stays coarse. This is acceptable because precise
  citation now flows through the symbol index; it is only a gap if a query needs
  a citable span for something the symbol parser doesn't capture (e.g. config
  files, non-parsed languages), which is out of the symbol index's scope either
  way.
- We forgo any (unproven) precision gain from symbol-aligned document chunks
  until there is real telemetry to justify it.

### Follow-ups

- **No implementation issue is created.** The recommendation is that no
  production change is warranted now, so filing a speculative "add symbol RAG
  chunks" issue would be noise.
- **Revisit trigger (the measured follow-up condition).** Reopen options
  (a)/(b) only if, once #714/#713 run in production with **real** embeddings, a
  measured eval (extend `pnpm eval:codegraph`, the #717 harness) shows that:
  (i) code-symbol questions are being answered from coarse source-as-RAG chunks
  *instead of* cited symbol hits at a material rate, or (ii) precision@k for
  code queries is materially higher with symbol-boundary chunks than with the
  symbol index. That eval — not local hash-embedded numbers — is the evidence
  that would flip this decision. If that data appears, file the implementation
  issue then, scoped to whichever of (a)/(b) the data favours (estimate: ~5 pts
  for (a) line-tracked re-chunking; ~3 pts for (b) dual-write with dedupe).
- Revisit at the **v1.2 planning checkpoint** alongside the rest of epic #712's
  production telemetry.

## Sources

- `server/src/lib/connectors/connector-ingest.ts` — `ingestSourceAsKnowledge()` (L408), source-chunk filename/body (L426–429)
- `server/src/lib/rag/chunker.ts` — `DEFAULT_CHUNK_SIZE` / `DEFAULT_OVERLAP` (L44–45)
- `server/prisma/schema.prisma` — `CodeSymbol` model + line spans (L3056, L3064–3065)
- `server/src/lib/code-graph/symbol-embeddings.ts` — `SymbolEmbeddingPipeline` (L124)
- `server/src/lib/code-graph/hybrid-search.ts` — `HybridCodeSearch.search()` (L243), BM25 fields (L166–171)
- `server/src/lib/rag/fused-code-context.ts` — dedupe + locator rendering (L128–157) [#714]
- `server/src/lib/analysis/tools/search-symbols.ts` — `search_code_symbols` locators (L96–102) [#713]
- `server/src/lib/rag/embedder.ts` — offline hash-embedder fallback (L510–525)
- Issue #716; Epic #712; shipped PRs #720 (#714), #721 (#713), #722 (#715), #723 (#717)
