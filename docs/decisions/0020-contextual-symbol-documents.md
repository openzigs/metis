# ADR 0020 — Contextual symbol documents

- **Status:** Pre-registered — not yet measured
- **Date:** 2026-10-12
- **Issue:** GitHub #1072 (epic #1068)
- **Related:** ADR 0002 (symbol-level granularity), ADR 0005 (the embedder is fixed; the
  baseline this is measured against), #1157 (the decision rule), #1159 (the previous change
  to the BM25 document, and the bars reused here), #1071 (Go receiver types)

## The question

Does code retrieval improve when a symbol's two search documents — the BM25 document and
the text that is embedded — carry more than its name?

Today (`main` at `578ddea2`):

- the BM25 document is `name + " " + qualifiedName` (`buildSymbolDocumentText`,
  `server/src/lib/code-graph/hybrid-search.ts`);
- the embedding text is `{kind} {name} in {filePath}` followed by the first ten lines of
  the symbol's source (`formatSymbolForEmbedding`, as `ingest.ts` calls it).

#1072 proposes adding the signature, the doc comment, the receiver, the package, the
callers and the tables touched.

## Pre-registration

This section was committed before any arm was scored. The commit that adds this file and
`server/src/lib/eval/embed-retrieval/contextual-ab.ts` contains no measurement code, only
the bars, the arms, the field bounds and the rule.

### What is compared

| | |
|---|---|
| Harness | `pnpm eval:embed-retrieval --contextual-ab` |
| Corpus | `embedretrieval-02-nl-to-code` — 127 hand-written requirements |
| Metric | nDCG@10, per query, paired |
| Embedder | `Alibaba-NLP/gte-modernbert-base`, CLS pooling, q8 — the default, the same in every arm |
| Rerank | off |
| Decision channel | fused at `DEFAULT_WEIGHTS` (`0.05 / 0.95`), through the wired production searcher |
| Baseline | the documents `main` builds; 0.276 on this channel (ADR 0005) |

The documents are the only free variable. Each arm is one choice of BM25 document and one
choice of embedding text, each of which is `base` (as `main`), `own` (plus the own-file
fields) or `full` (plus the cross-file fields):

| Arm | BM25 document | Embedding text | Role |
|---|---|---|---|
| `baseline` | base | base | what everything is compared with |
| `contextual` | full | full | **primary treatment** |
| `lexical-cross` | full | own | may ship instead of the primary |
| `own-file` | own | own | may ship instead of the primary |
| `lexical-only` | full | base | attribution only |
| `vector-only` | base | full | attribution only |

### The fields and their bounds

Own-file fields, taken from the file that declares the symbol:

| Field | What it is | Bound |
|---|---|---|
| signature | the declaration, from its first line to where the body opens | 300 characters |
| doc comment | the comment block directly above the declaration, or a Python docstring | 600 characters |
| receiver | the type a method is declared on | 120 characters |
| package | the declared package where the language declares one; otherwise the name of the directory the file is in | 120 characters |

Cross-file fields, derived from edges other files wrote:

| Field | What it is | Bound |
|---|---|---|
| callers | distinct names of the symbols with a resolved `calls` edge to this one, self-calls excluded, in ascending code-unit order | the first 5; 80 characters each |
| tables | distinct names of the tables this symbol has a `reads` or `writes` edge to (a column edge counts as its table), in ascending code-unit order | the first 8; 80 characters each |

Every field is repository text. Each is reduced to one line with control and zero-width
characters removed before it is stored or placed in a document.

The documents:

- **BM25, `own`:** name, qualified name, receiver, package, signature, doc comment, joined
  by spaces. **`full`** appends the caller names and the table names.
- **Embedding text, `own`:** the `base` header line; then one line each for `receiver:`,
  `package:` and `doc:` where present; then the `base` body lines. The signature is not
  repeated, because the first body lines already are the declaration. **`full`** adds a
  `tables:` line and a `callers:` line before the body.

N = 5 callers was chosen here and is not swept. The reasons are in
`server/src/lib/code-graph/symbol-context.ts`.

### The bars

- Fused channel: **+0.02 nDCG@10** (`MIN_IMPORTANT_CONTEXTUAL_FUSED_DELTA`). This is
  #1159's fused bar, unchanged: the bottom of the band epic #1156 expects a retrieval
  change to move the metric by.
- Pure-BM25 channel (`1.00 / 0.00`): **+0.05 nDCG@10**, #1159's BM25 bar, unchanged.
  Reported, not decisive.

### The rule

Classification is `classifyDelta` (`rerank-sweep.ts`), the rule `interval-report.ts`
prints, unchanged: the paired bootstrap 95% CI and the exact sign test.

- CI excludes zero, the sign test agrees, and the lower bound clears the bar: **SHIP**.
- CI excludes zero, the sign test agrees, lower bound under the bar:
  **DIRECTION-ESTABLISHED-MAGNITUDE-NOT**.
- Otherwise: **NOT-ESTABLISHED**.

`classifyDelta` does not look at direction, so a comparison counts as an *established
gain* only when it is one of the first two classes **and** its mean delta is positive.

The ship decision is `decideContextualShip` (`contextual-ab.ts`), applied to the fused
channel:

1. **The gate.** If `contextual` against `baseline` is not an established gain, nothing
   ships. That holds even if a cheaper arm classifies as a gain: three shippable arms are
   three chances at a false positive, and only the arm named here may open the gate.
2. **The cheapest sufficient documents.** Past the gate, take the first of `own-file`,
   `lexical-cross`, `contextual` that is itself an established gain against `baseline` and
   is not beaten, as an established gain, by a costlier one. Cross-file fields in the
   embedding text mean a symbol is re-embedded when a file that does not declare it
   changes; they ship only if they are shown to earn that.

Also fixed in advance:

- **A field the corpus cannot carry does not ship in a document.** The harness prints, per
  field, how many corpus symbols carry it. The corpus is built without the SQL-lineage
  sidecar, so it has no `reads` or `writes` edges and the tables field is expected to be
  empty in every arm. A field with no reach is unmeasured, and stays out of the documents
  until a corpus that carries it measures it.
- **The exact-name miss set is reported by name, per arm, on the fused and pure-BM25
  channels.** It is not a gate. A name lost from it is a cost the reviewer weighs.
- **The secondary arms are not corrected for multiplicity** and decide nothing on their own.
- **The fused-hit snippet follows the document decision.** A snippet changes no ranking,
  so this measurement says nothing about it; it is switched with the documents.
- **If nothing ships,** the stored fields stay only if they are inert by default, the
  document builders are left unused by production, and this ADR records the result.

## Result

Not yet measured.
