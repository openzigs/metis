# ADR 0020 — Contextual symbol documents

- **Status:** Accepted — measured; the `own-file` documents ship
- **Date:** 2026-10-12 (pre-registered in commit `e88875a6`, measured the same day)
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

Measured on 2026-10-12 at commit `d3e82aa3`, with the harness written after the
pre-registration (`e88875a6`) and before any arm was scored. One run; the bootstrap is
seeded, so a re-run reproduces these figures.

    TRANSFORMERS_CACHE=<cache> EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 \
      pnpm eval:embed-retrieval --contextual-ab

The embedder runs in-process from cached weights. The run made no call to any model API.

### Reach

| Field | Corpus symbols carrying it (of 794) |
|---|---|
| signature | 671 |
| doc comment | 384 |
| package | 671 |
| callers | 175 |
| receiver | **0** |
| tables | **0** |

The 123 symbols with nothing are the schema's tables and columns, which have no own-file
context in production either. Tables were expected to be empty. The receiver was not: the
regex parser the corpus is built with emits no `method` symbols, so no corpus symbol has
one. Under the rule fixed above, neither field ships in a document.

### The decision channel: fused at `DEFAULT_WEIGHTS`

| Arm | nDCG@10 | Δ vs baseline | Paired 95% CI | Wins / losses / ties | Sign p | Verdict |
|---|---|---|---|---|---|---|
| `baseline` | 0.282 | | | | | |
| `contextual` (primary) | 0.395 | +0.113 | [+0.072, +0.156] | 51 / 18 / 58 | < 0.001 | **SHIP** |
| `lexical-cross` | 0.399 | +0.118 | [+0.077, +0.161] | 49 / 17 / 61 | < 0.001 | SHIP |
| `own-file` | 0.398 | +0.116 | [+0.075, +0.160] | 49 / 17 / 61 | < 0.001 | SHIP |
| `lexical-only` | 0.304 | +0.022 | [+0.003, +0.042] | 23 / 10 / 94 | 0.035 | DIRECTION-ESTABLISHED-MAGNITUDE-NOT |
| `vector-only` | 0.385 | +0.103 | [+0.062, +0.145] | 48 / 16 / 63 | < 0.001 | SHIP |

The baseline is 0.282, not the 0.276 quoted above from ADR 0005: #1159's tokenizer change
landed after that figure and moved it.

Costlier arm against cheaper:

| Comparison | Δ | Paired 95% CI | Wins / losses / ties | Sign p | Verdict |
|---|---|---|---|---|---|
| `lexical-cross` vs `own-file` | +0.002 | [−0.004, +0.009] | 1 / 1 / 125 | 1.000 | NOT-ESTABLISHED |
| `contextual` vs `own-file` | −0.003 | [−0.021, +0.014] | 14 / 11 / 102 | 0.690 | NOT-ESTABLISHED |
| `contextual` vs `lexical-cross` | −0.004 | [−0.022, +0.012] | 14 / 11 / 102 | 0.690 | NOT-ESTABLISHED |

**The rule's output: `own-file` ships.** The primary treatment is an established gain and
clears the bar, so the gate is open. `own-file` is itself an established gain, and neither
costlier arm is established better than it. Caller names did not earn the re-embedding
they would cost.

### Attribution

| Channel | base | own | full | own vs base | full vs base |
|---|---|---|---|---|---|
| Pure BM25 (`1.00 / 0.00`) | 0.109 | 0.236 | 0.232 | +0.126 [+0.072, +0.182], SHIP at the +0.05 bar | +0.122 [+0.068, +0.178], SHIP |
| Pure vector (`0.00 / 1.00`) | 0.286 | 0.390 | 0.386 | +0.105 [+0.066, +0.145] | +0.100 [+0.060, +0.142] |

Most of the fused gain comes through the embedding text. That is what the weights imply:
the vector channel carries 95% of the fused score.

### The cost: exact-name lookups

An exact-name probe asks for a symbol by its own name and counts whether it comes back
first. This was pre-registered as reported, not as a gate.

- **Pure BM25: 153 of 155 first before, 136 after.** Seventeen names lost and none
  recovered: `InMemorySamlRequestIdCache`, `LeaderElector`, `SSOStateStore`,
  `TeamsAadIdentityResolver`, `VaultService`, `absenceIsConfirmableForClaim`,
  `buildTraceabilityMatrix`, `checkReplication`, `columnWidthDirection`, `extract_usage`,
  `fetchRegistry`, `generateAndSendChargeback`, `runWebhook`, `safeFetch`,
  `scoreFaithfulness`, `tierForSection`, `validateCitations`.
- **Fused: 118 of 155 before, 117 after.** Eight lost (`_lineage_edges`,
  `aggregateDecisions`, `assertSafeUrl`, `columnWidthDirection`, `mirrorMessageToTeams`,
  `safeFetch`, `startForecastRecompute`, `traverseLineage`) and seven recovered
  (`InMemorySamlRequestIdCache`, `buildTraceabilityMatrix`, `fetchUpstream`,
  `planMigration`, `reconcileIdentity`, `scoreFaithfulness`, `toAdminSamlView`).

The pure-BM25 loss matters in one situation: a project whose symbols are not embedded yet
is searched on that channel alone. The mechanism is the one #1159 described for
`filePath`. A longer document gives the symbol's own name a smaller share of it, and a
neighbour whose doc comment mentions the name now matches too. Repeating the name to
weight it would likely recover most of these. It was not tried: it would be a change made
after seeing the result, and it needs its own measurement.

#### Addendum, 2026-10-13: where the lost names rank

Added in the review round of PR #1126. The counts above say a name is no longer first and
nothing about where it went, and no caller takes only the first hit: they take a pool of 6
(docs-gen) to 120 (impact seeding). `--contextual-ab` now follows each lost name. This is
reporting only. No bar, arm, cap or rule reads it, and nothing above this heading changed.

One re-run at the review-round tip, offline from cached weights, no model API. Every figure
in this Result section reproduced, including `own-file` at 0.398 and +0.116
[+0.075, +0.160] and both miss sets name for name. The documents of all 794 corpus symbols
are byte-identical to the ones measured on 2026-10-12.

**No name falls below rank 6 on either channel.** The deepest is rank 5, on pure BM25.

| Channel | Lost first rank | In a pool of 3 | In a pool of 6 | In a pool of 12 | Deepest rank |
|---|---|---|---|---|---|
| Pure BM25, `own` against `base` | 17 of 155 | 16 | 17 | 17 | 5 |
| Fused, `own-file` against `baseline` | 8 of 155 | 8 | 8 | 8 | 2 |

Pure BM25, by name:

- **Rank 2 (14):** `InMemorySamlRequestIdCache`, `LeaderElector`, `TeamsAadIdentityResolver`,
  `VaultService`, `absenceIsConfirmableForClaim`, `buildTraceabilityMatrix`,
  `checkReplication`, `columnWidthDirection`, `extract_usage`,
  `generateAndSendChargeback`, `runWebhook`, `scoreFaithfulness`, `tierForSection`,
  `validateCitations`.
- **Rank 3 (2):** `fetchRegistry`, `safeFetch`.
- **Rank 5 (1):** `SSOStateStore`.

Fused: all eight (`_lineage_edges`, `aggregateDecisions`, `assertSafeUrl`,
`columnWidthDirection`, `mirrorMessageToTeams`, `safeFetch`, `startForecastRecompute`,
`traverseLineage`) are at rank 2.

How it is read. The rank is the target's position in one search at limit 120. A pool is
searched at its own limit and not read off that rank, because on the fused channel the
vector candidates are twice the limit; here the two agree for every name. So a caller that
takes six hits still receives every one of these symbols, and one that takes three misses
`SSOStateStore` alone, on a project that has no vectors yet. That bounds the cost on this
corpus; it does not restore first rank, which is still the follow-up below.

#### Addendum, 2026-10-13: the snippet and the fused block's budget

The pre-registration says a snippet changes no ranking, which is true and was not the
whole of it. The blocks that quote fused hits have a budget (1,500 tokens for 12 symbols by
default) and dropped every hit after the first entry that did not fit. Entries were costed
with their snippet, so with snippets of up to 800 characters about six symbols fit where
twelve had. Two reviewers of PR #1126 found this independently; it was not measured here
and was in no test.

It is fixed in the same PR, not by raising a budget: every head line that fits is placed
first, costed alone, exactly as before #1072, and only what is left is spent on snippets,
best-ranked first, each cut at a line end or left out. Which symbols are listed is again
independent of whether any hit has a snippet. With twelve cap-size snippets at the default
budget all twelve locators are listed; the first five hits carry their whole snippet, the
sixth part of one, and the rest none.

### What the result does not show

These are limits of the measurement, not of the rule.

1. **The gain is the doc comment.** A split made after the result, which decides nothing:
   where a query's target has a doc comment (93 of 127 queries) `own-file` gains +0.161,
   CI [+0.108, +0.217]; where no target has one (34 queries) it is −0.006,
   CI [−0.041, +0.028]. Package and signature show no effect of their own.
2. **The corpus is better documented than most code.** 57% of its code symbols and 73% of
   its query targets have a doc comment. On Miniflux v2.3.3, 26% of symbols do (811 of
   3,106). The +0.116 is therefore an upper estimate for a typical repository.
3. **The corpus's baseline text is thinner than production's.** The regex parser gives 153
   of 671 symbols a one-line span, so their baseline embedding text is the header and one
   line where production (tree-sitter) has ten. Where a target has a one-line span the gain
   is +0.169; where none has, +0.077, CI [+0.032, +0.125]. The second figure is the better
   guide to production.
4. **The requirements were written by people who had read the code.** They do not copy the
   comments (a requirement shares a mean of 14% of its content words with its target's doc
   comment), and they may still echo them.
5. **Fields were measured as a bundle.** There is no per-field arm; point 1 is the only
   evidence about which field does the work.
6. **One corpus, one language family.** TypeScript and Python. Nothing here was measured
   on Go, where the receiver and the declared package would have had reach.

### What ships

- Ingest stores `signature`, `docComment`, `receiver` and `package` on each symbol.
- The BM25 document is name, qualified name, package, signature, doc comment. The embedding
  text gains `package:` and `doc:` lines. A test asserts that these are, symbol for symbol,
  the documents the `own-file` arm scored.
- A fused hit carries a bounded body snippet.
- Callers and tables are derivable from the graph's edges (`deriveCrossFileContext`) and
  are in no document. The receiver is stored and is in no document. Nothing in production
  reads them; the evaluation harness does, which keeps this result reproducible.

### Cost on the Miniflux fixture

Measured on a copy of a development database holding Miniflux v2.3.3 (3,533 symbol rows,
all embedded with `gte-modernbert-base`), upgraded by one incremental ingest.

| | Before | After |
|---|---|---|
| Symbols with an embedding text | 3,533 | 3,533 |
| Characters across all embedding texts | 1,186,675 | 1,310,933 (+10.5%) |
| Symbols embedded again by the upgrade | | 3,106 (every symbol but the 427 `module` rows) |
| Characters embedded again | | 1,177,806 |
| Wall time to embed them, in-process q8, warm | | about 85 s |
| Wall time to embed the whole graph, warm | 76 s | 79 s |
| Wall time of the backfill itself | | 1.3 s |

Embedding the first set in a fresh process took about twice as long (152 s to 163 s for the
whole graph). The backfilled graph equals a full re-ingest of the same tree row for row.

### Follow-ups this leaves open

Tracked in #1127.

- Measure the receiver and tables on a corpus that has them: Go source, built with lineage.
- Measure a name-weighted BM25 document against the exact-name losses above.
- `pnpm eval:embed-retrieval`'s other modes still build the pre-#1072 documents from the
  corpus. Its `own-file` arm is what production runs.
