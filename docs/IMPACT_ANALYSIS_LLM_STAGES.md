# Impact Analysis — which stages are LLM-backed, which are deterministic, and why

**Status:** current as of issue #1025 (epic #999), 2026-07-22.
**Audience:** anyone about to add, remove, or re-tune an LLM call in Impact Analysis.

> **#1025 — four of these stages now default ON.** An impact analysis on an
> install with an AI provider configured makes **five provider calls and costs
> roughly $0.05 and ~18 s per changed requirement**, where before it cost nothing
> and ran in well under a second. Read
> [Defaults, and what they cost](#defaults-and-what-they-cost-1025) before
> deploying, and disable any stage you do not want with its `=0` kill-switch.

This document exists so the question *"is this stage LLM-backed?"* never has to be
re-derived by grepping every provider call site again. It also records the
**reasons** for each side of the split, because the reasons are what stop a
well-meaning change from re-opening a measured regression.

## How to re-derive this inventory in one command

The pipeline reaches an LLM **only** through the `AIProvider` abstraction
(`server/src/lib/ai/types.ts`) — never a raw SDK. So the authoritative check is:

```bash
grep -rln "AIProvider" --include=*.ts \
  server/src/lib/impact-analysis server/src/lib/traceability | grep -v test
```

If a file in those two trees does not appear in that list, it makes **no** LLM
call. If you add a stage, this document is stale — update it.

## The LLM-backed stages

Every one of these is **injected** into the engine (`ComputeImpactDeps`), never
imported by it. That is deliberate: `computeProjectImpact` stays runnable with
zero LLM collaborators, which is what makes the deterministic result the baseline
rather than a degraded mode.

| Stage | File | Flag | Default | Grounded against | On failure |
|---|---|---|---|---|---|
| Code-symbol seeder/reranker (#931) | `traceability/requirement-code-mapping.ts` (`LlmCodeSymbolSearcher`) | `IMPACT_LLM_SEEDING` | **off** | the BM25 wide pool (union, never a replacement) | deterministic BM25 top-K |
| Entity-seed recall union (#1002) | `traceability/requirement-entity-seeds.ts` | `IMPACT_LLM_ENTITY_SEEDS` | **off** | the project's code-graph entity vocabulary (exact name match) | base searcher unchanged |
| Edit-candidate check (#1756) | `impact-analysis/edit-candidate-verifier.ts` | `IMPACT_LLM_EDIT_VERIFY` | **off** | integer index into the hybrid FILE pool (about 30 files: the deterministic edit candidates, then the next files of the same ranking); a promotion's line must fall inside a named symbol of that file in the code graph (never the file's whole-file `module` symbol, #1781), checked without a model. Additive only (the #931 rule below): it may append a verified file and mark a candidate doubtful, never remove, move or re-score one; a promoted file carries its own hybrid score. The pool (code identifiers and signatures, which can carry comments) is fenced as untrusted data like the requirement | deterministic edit candidates unchanged |
| Edit-candidate re-order (#1798) | `impact-analysis/edit-candidate-reranker.ts` | `IMPACT_LLM_EDIT_RERANK` | **off** | integer index into the same hybrid FILE pool, shown without `[EDIT]` marks; up to 10 picks, most likely first, each with a line that must fall inside a named symbol of that file in the code graph (never its `module` symbol), checked without a model; an unchecked pick is dropped and counted. The **bounded exception to the #931 rule** below: the model may move files into the head of the files to edit, never remove one and never score one. The order is a reciprocal-rank fusion (`k = 60`, model weight `RERANK_MODEL_WEIGHT` = 1, fixed on the in-sample set) of the deterministic order and the model's checked order; its top 5 plus every deterministic candidate are the files to edit. Fenced as untrusted data like the #1756 check | deterministic edit candidates and order unchanged |
| Code-agent citations lead (#1759) | `impact-analysis/agent-seeder.ts` | `IMPACT_AGENT_SEEDS` | **on** (#1823) | no model call in the impact run: it reuses the Analysis code agent's stored citations of the requirement (`analysis-grounding` links), read for the requirement and the project; a citation counts only when the project's code graph still holds its file, else it is dropped and counted. The seeded symbols are the graph's rows. The second **bounded exception to the #931 rule** below: the first 5 cited files lead the files to edit, run after the #1756 check and the #1798 re-order; every other candidate stays one, with its score | seeds unchanged |
| Stale-citation demotion (#1832) | `impact-analysis/agent-seeder.ts` | `IMPACT_DEMOTE_STALE_CITATIONS` | off (#1939) | no model call: with `IMPACT_AGENT_SEEDS` on, a citation re-validation marked `stale` (#1831) seeds nothing and is counted as set aside, and the rest lead `fresh`, then `moved`, then `unverified`. Off by default: A7SD − A7S cost Recall@5 −0.097 on Sonnet (#1915) | every citation seeds in confidence order; the out-of-date ones are counted (`outOfDateCitations`) |
| Table-relevance output filter (#936) | `impact-analysis/table-relevance-filter.ts` | `IMPACT_LLM_TABLE_FILTER` | **ON** (#1025) | integer index into the crossing's own candidate rows | unfiltered crossing |
| Additive column DDL proposal (#1001) | `impact-analysis/additive-column-proposer.ts` | `IMPACT_LLM_ADDITIVE_DDL` | **ON** (#1025) | integer index into the crossing's own tables + a closed type allowlist; a column already in the live schema or the code graph is dropped (#1003). Since #791 it is shown the lineage writers and answers with covering writers, a justification and a `coveredBy` per proposal; a deterministic gate (`column-proposal-gate.ts`) then decides. In a **covered** request (bounded by an age or a date, with a lineage writer that filters on a time column) no field a model chose can make a column core: every proposal is optional or not proposed, and core comes only from what the user wrote in the request (an `ALTER TABLE`, or an add-a-column sentence the #923 fast path reads). Coverage is decided on the writers of every table the crossing reached, looked up before the #936 table filter is applied, so that filter's answer does not change it; the #1029 judge runs only when the proposer does not. The one limit: with `IMPACT_LLM_SEEDING` / `IMPACT_LLM_ENTITY_SEEDS` on, a model shapes the seeds, and so which tables the crossing reaches. The cost: a genuinely new column in a covered request shows as optional. In an uncovered request the gate does not rule: a proposal is core and marked `unchecked` with the reason, except one the proposer itself labels `user-preference`, which is optional (a demotion only). The write-path block is repository text: fenced as untrusted like the requirement, every field capped | no proposals appended |
| Clause-vs-impact reconciliation (#1005) | `impact-analysis/clause-coverage-reconciler.ts` | `IMPACT_LLM_CLAUSE_RECONCILE` | **ON** (#1025) | integer index into the project's **unsurfaced** tables | no advisories |
| BA narrative, per item + per run (#932/#949/#984) | `impact-analysis/impact-summarizer.ts` | `IMPACT_LLM_SUMMARY` | **ON** (#1025) | identifier-level allowlist built from engine facts only | `summary = null` |

Every default-ON flag is a **kill-switch**: `=0` or `=false` disables that stage
and only that stage (`v !== "0" && v !== "false"`, the idiom `IMPACT_QUERY_DENOISE`
already used). The two default-OFF flags are opt-in as before (`=1`/`=true`).

Adjacent but **not** on the impact-analysis run path: `traceability/suggest-mappings.ts`
(#893) is a route-driven requirement→data mapping suggester with its own budget
discipline. It does not participate in an impact run.

Shared properties, all unit-tested per stage:

- **Kill-switch flag** named `IMPACT_LLM_*`, read through a tiny `…Enabled(env)`
  function so tests can drive it without mutating `process.env`.
- **Deterministic passthrough, never throws.** Flag off, provider missing/offline,
  no candidates, or malformed output all degrade to the deterministic result. A
  fault in an advisory stage must never sink an impact run.
- **Closed-vocabulary output.** Four of the six bind the model's answer to an
  **integer index** into an array the deterministic pipeline built. The model's own
  spelling of a name is never used, so fabrication is structurally impossible
  rather than filtered after the fact.
- **OWASP LLM01.** Requirement text is UNTRUSTED: fenced in explicit delimiters,
  declared non-authoritative in the system prompt, and — critically — it is
  **never** a grounding source. A prompt-injected requirement cannot widen an
  allowlist and thereby launder a fabricated name (`collectItemFactNames` in the
  summarizer is the reference implementation of that rule).
- **Metered and time-bounded** (#1021/#1024). Every stage receives its provider
  from `impact-llm-runtime.ts`, never `buildProvider()` directly. See the two
  sections below.

### Correction: requirement-query denoise is NOT an LLM stage

Issue #1005's original inventory listed "query denoise" as an LLM touchpoint. It
is not. `denoiseRequirementQuery` (`traceability/requirement-code-mapping.ts`,
#943) strips a **static stopword list** — English function words, requirement
boilerplate, and generic attribute nouns — from the query before BM25, and falls
back to the raw query if every token is a stopword. `IMPACT_QUERY_DENOISE` is a
kill-switch on that list, and until #1025 it was the *only* impact flag that
defaulted **ON** — precisely because it is cheap and deterministic. It is still
the only default-ON impact flag that makes **no provider call at all**, and its
`v !== "0" && v !== "false"` reader is the idiom the four #1025 flips copied.

That mistake is the reason this document leads with the `grep` recipe.

## The deterministic stages, and why they stay that way

| Stage | File | Why it must not become an LLM call |
|---|---|---|
| DDL risk classification | `impact-analysis/ddl-risk-classifier.ts` (`classifyDdlRisk`) | It is a **safety signal**. A BA decides whether a change is breaking from it. A safety signal must be reproducible: the same input must yield the same class today and in six months, and must be explainable to an auditor without "the model said so". Non-determinism here would be a regression, not a feature. |
| Write-path coverage gaps | `impact-analysis/impact-analysis-read.ts` (`computeWritePathGaps`) | A pure set intersection over graph edges. The ground truth is *in the graph*; asking a model to infer it can only add error. #1000 showed the failure mode is a **graph** defect (the java/sql symbol-identity split), and the fix belonged in the graph. |
| Affected-test matching | `analysis/traceability-matrix.ts` (`isTestFilePath`) | A path predicate. Cheaper, faster and **exact**. |
| Documentation-file filtering | `isDocumentationFilePath` (#1003) | Same reason: a path predicate is exact, and #1003 removed the noise by tightening the predicate, not by asking a model to judge relevance. |
| Symbol ranking | `code-graph/hybrid-search.ts` (`BM25Index`) | Lexical, explainable, and the yardstick every LLM lever is measured against. It is also the fallback every LLM stage degrades to. |
| Additive-column *intent* fast path | `impact-analysis/schema-impact.ts` (`detectAdditiveColumnIntent`, #923) | Still first in `crossToSchema` and untouched by #1001. It fires instantly for a developer imperative; the LLM proposer only covers the business-analyst obligation phrasings it cannot match. Since #1036 it also reads a column the request states as DDL (`ALTER TABLE entries ADD COLUMN read_at …`), taking only the two identifiers. It reads what the request asks (primary request + sub-aspects), not its context sections, so DDL quoted under "Alternatives considered" proposes nothing; a heading the parser does not know is a sub-aspect, so DDL under "Workaround" does count. These three forms (the DDL and the two prose ones) are how a column becomes core in a request the #791 gate calls covered. |
| Change extraction (#1036) | `impact-analysis/change-request.ts` (`parseChangeRequest`) | Reading a pasted issue as one change is a question about the text's SHAPE (a title, then template headings), which a parser answers exactly and for free. The model's share of the failure it fixes was nil: run 7 split each issue into 5 to 12 fragments before any model saw it. An LLM extractor can still replace it behind `ChangeExtractor`. |
| Seeding and the edit/blast split (#1036) | `impact-analysis/change-seeds.ts`, `impact-roles.ts`, `structural-twins.ts` | Seeding is the chat path's `HybridCodeSearch` (BM25 fused with symbol embeddings — a local embedder, not a provider call), ranked by file. When a project's symbols are not embedded yet it degrades to BM25 and records `retrievalMode: "bm25-only"`, which the run summary states. The cut sizes are provisional: tuned on six Miniflux issues, to be revisited at run 8. Which symbols are edit candidates is then decided by rules over retrieval, lineage and the schema result, so the list a caller scores on precision is reproducible. The opt-in LLM seeders above still take a BM25 base and are used as-is when their flag is on. |

### The #931 seeder must not be revived as-is

An LLM **seeder** — one that picks the code symbols BM25 will expand from — was
built (#931) and measured: table precision fell **0.42 → 0.29**. The mechanism is
recorded because it generalises: the seeder scored its own picks 1.0 and the
deterministic top-K 0.2, below `DEFAULT_MIN_CONFIDENCE` (0.3), so good BM25 seeds
were *dropped*. It shipped flag-off and is still flag-off.

The rule that came out of it: **prefer an LLM at the OUTPUT, or as a strictly
additive union, over an LLM at the SEED.** #936 (prune the output) and #1002
(union that preserves the base scores) both follow it. Any future seed-side lever
must leave the base candidates' original scores untouched — changing the max
silently re-normalises every deterministic confidence.

**#1756 follows this rule.** The edit-candidate check judges the hybrid FILE pool
(not #931's BM25 pool) and is additive by construction: `applyEditVerification`
returns every deterministic edit candidate as the same object, in the same place,
with the same score, whatever the model answers (an empty answer, garbage, every
file marked doubtful, or an injected "promote everything"). A promotion is kept
only when its line is inside a named symbol of that file in the code graph (the
`module` symbol every parser emits from line 1 to EOF does not count, #1781), and its
symbol carries the file's best HYBRID score, never a model score; a dropped
promotion is counted in the run summary. A doubtful candidate stays listed, with
the model's reason next to its base score in `seedEvidence`. Off by default until
`pnpm eval:localization --arms A0,A4` shows a held-out gain: a statistically
significant Recall@5 gain over A0, edit precision no lower, table precision no
more than 0.03 lower, at no more than about $0.25 per requirement.

**#1759 is the second bounded exception, and it adds no model call.** The Analysis
code agent's citations of a tracked requirement (stored by "Evaluate new
requirements" as `analysis-grounding` links, each already resolved to the code graph)
put up to 5 files at the head of the files to edit. It keeps the same guarantees as
#1798: no candidate is dropped or re-scored (`leadWithAgentCitations` returns each as the
same object), a cited file the graph no longer holds is dropped and counted, and a new
file's symbols are the graph's own rows at the citation's stored confidence. It runs
last, so the #1798 fusion cannot undo it. Measured as arm A3A (#1755): Recall@5 +0.31
over A0 pooled on 29 held-out items on `claude-sonnet-5-5`; appending the same files
(A3) moved Recall@5 by +0.000. #1818 made the order explicit (the surer citation first,
then citation order, which the writer now stores deterministically), capped the cited
files that follow the candidates at 5 (any further one is listed under related, not
seeded), and measured the SHIPPED path as arm A7: a real "Evaluate new requirements" run
on each held-out item, then `computeProjectImpact` on the requirements it persisted.
Recall@5 +0.256 [0.16, 0.35] over A0, pooled on 39 held-out items on `claude-sonnet-5-5`
(p < 0.001; one run, $14.58). The cited files become blast-radius seeds that reach the
schema crossing, so #1823 measured the table-precision guard. A real analysis ran on each
`impact-recall-01-jpetstore` requirement against the repository the fixture models
(mybatis/jpetstore-6), and the citations it stored were read onto the fixture. The table
precisions are on `deepseek-flash`, with 3 runs and the live #936 filter, 2026-11-05:

| Reading | Table precision |
|---|---|
| A0 on the split seeding (the requirement's own text) | 0.685 |
| A7O (the analysis's requirements, flag off) | 0.432 |
| A7 (the analysis's requirements, flag on) | 0.453 |

Against A0, A7 fails the 0.03 guard: −0.23, 95% CI [−0.41, −0.05] over the 11
requirements. (Each interval pairs the requirements' table precisions, averaged over the 3
runs, with a t-interval: `guardPairedDifferences` in
`server/src/lib/eval/localization/table-guard-agent.ts`, which the guard prints. A test
reproduces these from the run's committed records, #1847.) The flag does not cause that drop: A7O, with the flag off, drops by the
same amount (−0.25). The analysis splits each requirement into about 4.5 tracked
requirements, and the union of their tables is wider than the one requirement's label.
The flag's own effect, A7 against A7O on the same changes, is +0.02 [−0.02, +0.06].

The owner chose to gate the flag on its own effect (2026-11-05, option A): A7 against A7O,
with A7's average table precision within 0.03 of A7O's or better. The ~0.2 drop on the
analysis path, flag on or off, is tracked as #1848. The Sonnet reading
(`claude-sonnet-5-5`, 3 runs, live #936 filter, 33 analyses, 2026-11-06, $7.52 under an
$8 cap):

| Reading                                     | Table precision |
| ------------------------------------------- | --------------- |
| A0, mapper path (the floors' path)          | 0.732           |
| A0 on the split seeding                     | 0.556           |
| A7O (the analysis's requirements, flag off) | 0.374           |
| A7 (the analysis's requirements, flag on)   | 0.367           |

**A7 − A7O: −0.007 [−0.043, +0.028]**: the average is within 0.03 of A7O; the 95%
interval's lower bound is −0.043, so the interval itself does not clear −0.03. The flag is
**on by default** since #1823 (`IMPACT_AGENT_SEEDS=0` turns it off). Against A0 on the
split seeding, A7 is −0.189 [−0.266, −0.113] and A7O −0.182 [−0.277, −0.087]: the analysis
path's drop, not the flag's. The run's records are committed
(`server/src/lib/eval/localization/__fixtures__/table-guard-sonnet-2026-11-06.runs.jsonl`),
and a test reads these intervals from them.

**#1848: the drop on the analysis path was the measurement.** Each analysis persists
its restatement of the requirement first, then about 3.5 to 4.7 further requirements,
mostly elicited non-functional ones (#1613), such as "Transactional order persistence",
"Schema verification" or "Authenticated checkout access". Each of those is its own
impact item in production, with tables of its own, and the guard unioned all of their
tables against the one label. The guard now records each persisted requirement's own
tables. It scores A7 and A7O on the analysis's **first persisted requirement** and still
reports the union beside it.

- **The first requirement is never an elicited one.** It leads the analysis's own
  requirement set, which is written before the elicited requirements. It is functional in
  32 of 33 DeepSeek analyses and 25 of 33 Sonnet ones. The others state the requirement
  as the gap the code leaves, for example "Prevent negative inventory on concurrent
  orders" for "Track inventory stock levels for each item".
- **Matching by title words is no substitute.** Picking the persisted requirement whose
  title shares the most words with the label agreed with the first requirement in only 36
  to 38 of 66 runs.

These readings are from the analyses #1823 already stored, with 3 runs and the live #936
filter, re-read on 2026-11-06:

| Reading (table precision) | `claude-sonnet-5-5` | `deepseek-flash` |
|---|---|---|
| A0 on the split seeding | 0.556 | 0.585 |
| A7O, first persisted requirement | **0.702** | **0.760** |
| A7, first persisted requirement | **0.731** | **0.648** |
| A7O, every persisted requirement unioned | 0.373 | 0.466 |
| A7O, each requirement on its own (mean) | 0.615 | 0.685 |

Paired over the 11 requirements (each one's mean over the 3 runs; 95% t-interval):

| Comparison | Sonnet, first persisted requirement | Sonnet, unioned | DeepSeek, first persisted requirement |
|---|---|---|---|
| A7O − A0 (split) | **+0.146 [+0.042, +0.250]** | −0.184 [−0.275, −0.093] | +0.174 [+0.010, +0.338] |
| A7 − A0 (split) | **+0.175 [+0.073, +0.276]** | −0.190 [−0.266, −0.113] | +0.063 [−0.106, +0.231] |
| A7 − A7O | +0.029 [−0.052, +0.109] | −0.006 [−0.040, +0.028] | −0.112 [−0.227, +0.004] |

- **Measured, not real.** Read on its own restatement, the analysis path raises table
  precision over the requirement's raw text, by +0.15 with the flag off and +0.18 with it
  on (Sonnet). The whole ~0.2 drop came from unioning the further requirements.
- **The further requirements are on topic.** Alone, a non-functional one scores 0.58 to
  0.66 against the original label (A7O), at or above A0's 0.556 to 0.585. Their extra tables belong to the
  scope they add, such as `inventory` for "Inventory consistency during order placement".
  The restatement surfaces fewer tables than the raw text: 2.2 against 3.1 on Sonnet.
  Nothing in the impact path needs a fix.
- **The flag holds on the corrected measure.** On Sonnet, the production model, A7 −
  A7O is +0.029 on the first persisted requirement, so `IMPACT_AGENT_SEEDS` stays on. On
  DeepSeek it is −0.112, and its interval includes zero. There, A7's citations lead
  mapper files whose statements touch sibling tables: `AccountMapper` brings `profile` and
  `signon` to "Add a status flag to account". This gap between the models is not resolved.
- The records are committed (`__fixtures__/table-guard-{sonnet,deepseek}-2026-11-06-pieces.runs.jsonl`),
  and a test reads these intervals from them. The Sonnet re-read cost $2.15: six A7/A7O
  runs, with no new analysis.

**The flag's gate reads both scorings (#1890).** Against A7O, both arms carry the same
further requirements, so the union's artefact mostly cancels: on Sonnet A7 − A7O is
−0.006 unioned and +0.029 on the first persisted requirement. `IMPACT_AGENT_SEEDS` seeds
impact for every persisted requirement, and about 4 in 5 of them are not the first, so a
regression confined to the further requirements would pass a gate that read only the
first requirement. A7 is therefore gated against A7O on **both** scorings: its average
table precision must be within 0.03 of A7O's on the first persisted requirement **and**
on the union, and the report names the scoring that decided the result
(`tableGuardGate` in `runner.ts`). The A7O − A0 and A7 − A0 comparisons, where the
artefact is one-sided, stay on the first requirement alone. When either A7 or A7O was
recorded before #1848 and has no per-requirement tables, only the union can be read, and
the gate reads only the union. Read from the committed records:

| Model | First persisted requirement (A7 against A7O) | Unioned (A7 against A7O) | Gate |
|---|---|---|---|
| `claude-sonnet-5-5` | 0.731 against 0.702 | 0.366 against 0.373 | **held on both** |
| `deepseek-flash` | 0.648 against 0.760 | 0.461 against 0.466 | **failed on the first requirement** |

#1823's decision stands: the flag is gated on the production model, where it holds on
both scorings, so `IMPACT_AGENT_SEEDS` stays on. On DeepSeek, the iteration model, the
guard row now reads as failing.

**DeepSeek's A7 − A7O of −0.112, from the committed records (#1890).** The records hold
each run's tables per persisted requirement, not the citations behind them. Paired per
requirement (mean of 3 runs, first persisted requirement), the gap comes mostly from 5 of the 11
requirements (two smaller losses, "Place an order" 0.411 to 0.328 and "Compute the checkout
total" 0.556 to 0.522, are offset by a +0.167 gain on "Track inventory"):

| Requirement | A7O | A7 | What A7 adds |
|---|---|---|---|
| Add a status flag to account | 1.000 | 0.556 | `profile`, `signon` (2 of 3 runs) |
| Update product details in the catalog | 0.833 | 0.500 | `category` (every run) |
| List items by product for the storefront | 1.000 | 0.778 | `category` (2 of 3 runs) |
| Add a discontinued flag to product | 0.667 | 0.500 | `category` (1 run) |
| Introduce a loyalty programme | 0.889 | 0.778 | `profile` (2 of 3 runs) |

- **Every loss is an extra table.** A7 never loses a labelled table that A7O found. Each
  loss is a sibling table of a mapper that A7's citations lead: `AccountMapper` adds
  `profile` and `signon` to an account change, and the product and category statements
  add `category` to a product change.
- **Sonnet shows the same shape, less often.** On Sonnet, A7 adds `category` to the two
  product requirements (−0.111 each). There, A7O already surfaces `signon` (all 3 runs)
  for the account flag, and A7 gains elsewhere: +0.333 on "Compute the checkout total for
  an order".
- **Not explained by the file-level translation.** Most citations reach the fixture as
  their file, with no symbol (#1823's translation: the fixture's lines are not the
  repository's), so they seed every statement of the cited mapper. Of the citations kept,
  that share is about 60% on DeepSeek (402 of 665 over the 3 runs) and about 67% on Sonnet
  (490 of 735). It is *lower* on the model with the larger
  gap, so file-level widening alone does not account for the difference between the
  models.
- **Not yet localized to a code path.** Telling which files each model cites, and whether
  a symbol-level citation would keep the sibling statements out, needs the stored
  citations in the materialized eval database. That means a DeepSeek re-read of the
  stored analyses, which has not been run. Whether to confirm on Sonnet depends on that
  result: only if a DeepSeek fix changes the code path.

**#1832's demotion of stale citations, measured (#1834).** The staleness slice reads the
same analyses as A7 four ways. Each item's committed patch edits every function of one
answer file (one comment line each), renames one file and deletes one file. It is then
re-ingested, which re-validates the stored citations (#1831). The arms:

- **A7K:** no staleness, demotion off (the shipped default since #1939). With no re-ingest every citation is `unverified`, so it reads the same as A7.
- **A7S:** after the patch, without demotion. Since #1939 this is the shipped behaviour.
- **A7SD:** after the patch, with demotion (`IMPACT_DEMOTE_STALE_CITATIONS` forced on).

**Demotion is off by default since #1939.** On the #1915 reading (`claude-sonnet-5-5`, 39
held-out items) demotion never helped: A7SD − A7S was −0.097 on Recall@5 (p = 0.004) after
the code changed, and A7RD − A7R was 0.000 after a routine re-ingest that left every
citation `fresh`. It now runs only with `IMPACT_DEMOTE_STALE_CITATIONS=1`. Off, the
citations are ordered by confidence and then stored order, stale ones kept, and the run
summary counts the out-of-date ones (`agentCitations.outOfDateCitations`) without
calling them set aside. The eval's A7, A7S and A7R run the stage with the flag off;
A7SD and A7RD force it on.

Pooled on the 39 held-out items, `claude-sonnet-5-5`, one run, 2026-11-06:

| Pair                                   | Recall@5                             | MRR                       |
| -------------------------------------- | ------------------------------------ | ------------------------- |
| A7K − A7 (no staleness)                | +0.000                               | +0.000                    |
| A7S − A7 (staleness, no demotion)      | −0.017 [−0.07, +0.03], n.s.          | +0.001                    |
| A7SD − A7S (demotion, under staleness) | **−0.061 [−0.11, −0.02], p = 0.002** | **−0.189 [−0.28, −0.11]** |

- **A7K equals A7 by construction, so it does not measure demotion.** With no re-ingest,
  every citation is `unverified`, and hiding freshness can neither reorder nor set
  aside anything. #1832's default is therefore not supported by A7K − A7 = 0 (#1899).
  The production case is a routine re-ingest that changes nothing. Its re-validation
  gives every citation a verdict, which lets the freshness tier reorder them. Most read
  `fresh`: line drift within a file is `fresh`, and `moved` means the symbol is now in
  another file. A few can still read `stale` (a file-level link past the end of its
  file, or a missing or ambiguous symbol, #1925). Arms A7R and A7RD (a no-op
  re-ingest at the pinned commit, read without and with demotion) measure that case,
  and they have not been run yet.
- **Under this staleness, demotion costs ranking.** The patches left 346 citations stale
  and 167 moved (of 1,316 read), and A7SD set all 346 aside.
- **This patch is the worst case for demotion.** A comment-only edit changes a cited
  symbol's content hash but not what the change must edit, so the answer file stays the
  answer while its citations go stale. Real code drift that moves the behaviour elsewhere
  is the case demotion is for, and this slice does not model it.
- **Table precision** (`deepseek-flash`, 3 runs, live #936 filter, scored on the first
  persisted requirement, #1848): A7S − A7 is +0.018 [−0.083, +0.118] and A7SD − A7S is
  −0.028 [−0.123, +0.067]. Neither has a measurable effect.

The run records are committed (`__fixtures__/staleness-sonnet-2026-11-06.partials.jsonl`,
`__fixtures__/staleness-table-guard-deepseek-2026-11-06.runs.jsonl`), and
`staleness-results.test.ts` reads these figures from them. How the slice runs:
eval-data/README.md, "Stale citations".

**#1798 is a deliberate, bounded exception to this rule.** Nothing additive raised
Recall@5 (an appended file lands after the deterministic picks), so the edit-candidate
re-order lets one model call move files UP the list of files to edit. It keeps what the
#931 lesson protects:

- **The model writes no score or confidence.** It returns an ordered list of pool
  indices, each with a cited line and a reason. A pick whose line is not inside a named
  symbol of that file in the code graph is dropped and counted, never used.
- **No deterministic candidate is dropped.** `applyEditRerank` returns every
  deterministic edit candidate as the same object, with the same score. The files to edit
  are the top 5 of the fused order plus every deterministic candidate, so the blast radius
  still starts from every deterministic seed and cannot shrink. A file the model moved in
  carries its symbol's own hybrid confidence (channel `edit-reranker` in `seedEvidence`).
- **The order is a fusion, not a replacement.** Reciprocal-rank fusion of the
  deterministic order and the model's checked order means a file both rank high stays
  high. The model weight bounds how far down the pool a model-only pick can reach. A
  model-first pick at deterministic rank `r` outranks the deterministic first file the
  model left out when `w > 1 - 61/(60 + r)`: about 0.08 at `r = 6`, about 0.13 at
  `r = 10` and about 0.32 at `r = 30` (the pool's last file). To push the search's first
  file out of the top 5, five files must outrank it. The search ranked only four files 2nd
  to 5th, so one of the five must be a file it ranked 6th or lower, and that needs
  `w > 5/66 ≈ 0.076`. Below that weight, the search's first file stays in the top 5
  whatever the model answers. The threshold stops a file from being lifted **above the
  search's first file**. It does not stop a file from being lifted **into the top 5**: at
  `w = 0.05`, a model-first pick the search ranked 6th fuses to 3rd. Below
  `1/62 ≈ 0.016`, the model cannot change which file comes first. So a weight that keeps
  the guarantee and still lets the model change the first file lies between about 0.016
  and 0.076. The in-sample sweep below started at 0.1, so that range is not measured yet
  (#1806). `fuseEditOrder`'s tests pin these thresholds. At weight 1 (`k = 60`) a
  model-first pick displaces the search's first file even when the
  search ranked that pick 30th: the guarantee the stage does keep is that no
  deterministic candidate leaves the list, not that the search's best stays in the top 5.
- **The weight was fixed in-sample, before either held-out set was read.**
  `RERANK_MODEL_WEIGHT = 1` (plain RRF). On the six run-7 issues (`deepseek-flash`,
  2 runs per weight, 2026-11-05) A13's Recall@5 rose with the weight to a plateau and was
  flat after it: 0.64 at 0.1, 0.70 at 0.3, 0.72 at 0.6, 0.75 at 1 (5 runs), 0.73 at 2,
  0.75 at 4 (4 runs), against A0's 0.62. Between two runs at one weight it moved by up
  to 0.12 (the model's answer varies), so nothing above 0.6 is distinguishable, and the
  plateau's plain-RRF value stayed. `pnpm eval:localization --rerank-weight <w>` sets it
  for a tuning run, and the report's configuration names the value.

It ships **off**. The fused order survives only in `seedEvidence` (the persisted
affected-symbol list is sorted by depth then confidence), and since #1762 the impact
page lists the files to edit in that order, each with what found it and, for a checked
pick, the model's reason and line. The markdown export still lists them by depth then
confidence. The bar for turning it on: a significant Recall@5 gain over A0 on the
pooled held-out set (`pnpm eval:localization --arms A0,A13,A13C`), table precision no
more than 0.03 below A0 on the same (split) seeding (`--table-guard`), and no more than
$0.05 per requirement on `claude-sonnet-5-5`. `A13S` shows the pool shuffled and reads
whether Recall@5 depends on the order the model is shown.

**Measured 2026-11-05 (held-out, `claude-sonnet-5-5`, 2 runs per set, weight 1):** the
bar is met.

| Arm | Miniflux R@5 (24) | Fixture R@5 (15) | Pooled ΔR@5 vs A0 (39) | Pooled Δ edit precision | $ / req |
|---|---|---|---|---|---|
| A0 | 0.52 | 0.54 | — | — | $0 |
| A12 | 0.52 | 0.73 | +0.073 [0.01, 0.14] | +0.141 | $0 |
| A13 | 0.67 | 0.74 | **+0.166 [0.09, 0.25], p < 0.001** | +0.011 (n.s.) | $0.020 to $0.023 |
| A13C | 0.69 | 0.72 | **+0.170 [0.10, 0.25], p < 0.001** | +0.084 [0.06, 0.11] | $0.020 to $0.023 |
| A13S | 0.70 | 0.70 | +0.171 [0.09, 0.26], p < 0.001 | +0.015 (n.s.) | $0.021 to $0.023 |

- **Recall@10 and MRR rise too** (pooled A13 +0.081 and +0.164, both significant), and
  every model-named file resolves to the code graph (graph resolution 1.00 on every arm).
- **Against A12** (computed one-off with the runner's own statistics; `--reference A12`
  now prints this pairing, #1806): A13C, the re-order
  on A12's base, adds pooled Recall@5 +0.097 [0.02, 0.18] with edit precision not
  measurably different (−0.057, n.s.); A13 has edit precision −0.130 below A12, because
  A0's cut keeps more files than A12's.
- **Table guard held:** A13 on the split seeding 0.531 against A0 on that seeding 0.511
  (`impact-recall-01-jpetstore`, 3 runs each).
- **No position bias in Recall@5:** A13S against A13 pooled (`--reference A13`),
  Recall@5 +0.005 (p 0.75).
  Which file comes first does depend on order on the small fixture set (MRR −0.096,
  p 0.004), so the deterministic presentation stays.
- **About 6 s per requirement on Miniflux and 12 s on the fixture set** (one call per
  change and repository; the fixture items each search three repositories).

The flag stays **off** until #1762 renders the edit order (above): until then a gain
in the fused order changes nothing the analyst reads. When it flips, A13C's base needs
`IMPACT_REQUEST_EDIT_RANKING`, which is itself off pending #1795, so A13 (A0's base) is
the configuration production has today.

## Two measurement lessons that invalidated earlier numbers

Both are the reason several figures quoted during epic #999 were wrong. They are
recorded here because they are properties of the *harness*, not of any one issue.

### 1. Measure the configuration you actually ship (#1016)

`pnpm eval:impact-recall` used to default to the #936 filter **off**, which
described a configuration nobody deploys — the shipped `.env` sets
`IMPACT_LLM_TABLE_FILTER=1`.

| Configuration | Macro table precision |
|---|---|
| old harness default (filter off) | ≈0.40 |
| production (`IMPACT_LLM_TABLE_FILTER=1`) | ≈0.78 |

A "must not drop below 0.40" gate had been set from the unfiltered number and was
therefore ~0.38 too lenient — it would have waved through a large real regression.
Since #1016 the harness **defaults to the production configuration**, names the
configuration in every report, resolves thresholds per configuration, runs 3 times
and gates on the mean, and **fails loud** if the filter is on while the resolved
provider is an offline stub (which would silently emit unfiltered numbers under a
production label).

Corollary, from `scorer.ts`: an empty `found` set scores **precision 1.00** by
convention. So a requirement the engine misses entirely is *vacuously* precise —
adding a genuinely failing regression case pushes macro precision **up**, and
fixing the miss pushes it **down**. Always decompose a macro move per requirement
before calling it a regression.

### 2. Check the corpus still models the world ingest produces (#1016)

The eval fixture encodes qualified-name conventions (`path/File.ts::Type::member`
vs `pkg.Type.member`). If ingest changes and the fixture does not, the harness
keeps reporting confident numbers about a world that no longer exists.
`src/lib/eval/impact-recall/name-convention.ts` now self-checks the corpus against
the conventions the emitters actually produce, and **throws** before any
measurement rather than quietly measuring the wrong thing.

## #1005 — clause-vs-impact reconciliation

### What it is

The summarizer was already doing this *incidentally*: on the JPetStore
order-cancellation requirement it noted, unprompted, that the requirement talks
about returning items to stock while no inventory table had been surfaced. Made
explicit and structured, that becomes a real "**this analysis may be incomplete**"
signal instead of a lucky sentence.

`reconcileClauseCoverage` takes the requirement, the tables the analysis surfaced
(primary **and** the #936 secondary bucket — a demoted table is still on screen),
and the project's table vocabulary, and returns
`{ tableName, clause, rationale }[]`: obligations with no home among the surfaced
tables, each naming a real project table that was not surfaced.

### The inverted grounding vocabulary

Every other stage grounds on the impact result's own rows, because their job is to
prune or annotate what was *found*. This stage's job is to name what was
**missed**, so grounding on the result would make it structurally incapable of
ever firing. It grounds on the **complement** instead: the project's real
code-graph tables **minus** those already surfaced, still index-keyed, still
closed. Table names are compared on the lower-cased last dotted segment so
`SHOP.INVENTORY` and `inventory` are the same table — without that, spelling
differences alone would manufacture gaps.

### It cannot move recall or precision

Advisories live on `ProjectImpactResult.coverageGaps` and are **never** merged
into `affectedTables`/`affectedTablesSecondary`. That is by construction (and
engine-tested), and it is the point: a false positive costs a BA one sentence to
dismiss, whereas a false positive in `affectedTables` costs precision — the exact
trade #931 lost.

### How a BA sees it, and why it is not persisted on its own

Gaps are fed to the #932 summarizer as **facts**, and the per-item prompt gains a
"POSSIBLE COVERAGE GAPS" block plus one instruction to close with an
incompleteness warning. Only the **table name** enters the grounding allowlist —
the model-written `clause`/`rationale` carry no grounding authority, exactly as the
untrusted requirement text does not.

Two alternatives were rejected for the prototype:

- **A dedicated persisted column/table.** Needs a Prisma dual-schema migration
  plus a Postgres baseline edit. Correct once the signal has earned it; premature
  before the measurement below.
- **Appending the advisory to the persisted `summary` string after generation.**
  That column's documented invariant is "grounded ⊆ engine facts"; a gap table is
  by definition *not* an affected-table fact, so appending post-hoc would quietly
  violate the contract the column advertises.

With gaps empty — which is what a disabled reconciler, an unavailable provider or
a clean requirement all produce — the summarizer prompt is byte-identical to
pre-#1005, so no existing narrative shifts.

### Measured, live, against the two known misses

Live Anthropic (`claude-sonnet-5`), JPetStore MyBatis project
`cmrqrf1sd0002y89k6hj6ph66`, in-process against a copy of `server/dev.db`,
3 runs per requirement, `IMPACT_LLM_TABLE_FILTER=1`.

| Requirement | Known miss (#999) | Still reproducible? | Reconciler result |
|---|---|---|---|
| 1 — cancellation | `inventory` never flagged | **No.** `inventory` is a PRIMARY table in 3/3 runs (also 3/3 with the reconciler disabled) | Correctly reported **no** `inventory` gap. Reported `account` for *"record who cancelled it"* in 2/3 runs |
| 3 — loyalty | `account` absent | **Yes.** `account` is absent from primary and secondary in 3/3 runs | **Caught in 3/3**, clause *"running points balance must be visible on the customer's account"* |
| 2 — partial shipments | (no known miss) | — | **Zero** gaps in 3/3 — no false positives on the requirement that was already well covered |

So: **one of the two known misses is caught (3/3); the other is no longer
reproducible**, so there was nothing to catch — and the reconciler correctly said
nothing rather than inventing a gap. The `inventory` miss appears to have been
closed by intervening epic work, not by #1005; do not credit this stage with it.

The `account`-on-requirement-1 advisory (2/3 runs) is a judgement call, not a
clean win: JPetStore's `orders.userid` does reference the account, so "who
cancelled it" plausibly needs it — but it fires inconsistently, which is the
honest signal that this stage is stochastic at the margin.

`pnpm eval:impact-recall` (production configuration, 3 runs, same corpus) before
and after: table recall 0.91 → 0.91, table precision 0.77 (spread 0.758–0.788) →
0.79 (spread 0.742–0.833); both PASS. The move is #936 filter noise: the eval
runner has no reconciler seam at all, so `coverageGaps` is always empty there.

### Default

**ON since #1025** (`IMPACT_LLM_CLAUSE_RECONCILE=0` disables it).

When #1005 shipped this said *OFF*, on the reasoning that one caught miss and a
stochastic marginal advisory is a promising prototype rather than evidence for a
flip, and that flipping it needed a wider corpus with labelled misses. #1025
flipped it anyway, on a different argument — not a stronger version of the same
one. The argument is **blast radius**, not efficacy: this stage writes **zero**
rows to `affectedTables`, so it is structurally incapable of moving recall or
precision, and the eval distribution across the flip is unchanged. Its worst case
is an advisory sentence a BA can ignore; its best case is the only signal in the
product that says *this analysis may be incomplete*. That asymmetry is what
justifies default-ON for an advisory stage and would **not** justify it for a
stage that writes rows.

The original caveat still stands as a caveat: the efficacy evidence is three
requirements on one corpus, and the marginal advisory fired 2/3. Do not quote
this stage's hit rate as though it were measured at scale.

## Defaults, and what they cost (#1025)

Until #1025 every LLM stage shipped **off**, so the out-of-the-box product was the
deterministic-only one. Measured on JPetStore in the production configuration,
that default was poor for the audience the feature is for:

| | deterministic only | with the four stages |
|---|---|---|
| Macro table precision | **0.4636** | **0.7803** |
| Actionable `ALTER TABLE … ADD COLUMN` | **0** | 2 per requirement |
| Per-table rationale | none | requirement-specific prose |
| Incompleteness advisory | none | e.g. *"no surfaced table … was identified as storing that balance"* |

A BA asking *"a cancelled order must record who cancelled it and when"* got 27
`-- Verify column orders.billaddr1 — referenced by impacted code` comments and
nothing actionable.

### What this costs, per analysis

**Every impact analysis on a provider-configured install now makes five provider
calls and spends real money.** Measured live (JPetStore, Anthropic
`claude-sonnet-5`, one changed requirement, in-process against a copy of
`dev.db`):

| Run | Wall clock | Provider calls | Tokens | Cost (USD) |
|---|---|---|---|---|
| 1 | 20.2 s | 5 | 12,763 | 0.0505 |
| 2 | 20.1 s | 5 | 12,386 | 0.0487 |
| 3 | 27.9 s | **6** | 21,330 | **0.0775** |

Budget **≈$0.05 and ≈20 s per changed requirement**, and know that a
retry-with-repair (run 3 above — a summarizer draft failed grounding or table
ordering and was re-prompted once) can push a single run to **~$0.08 and ~28 s**.
That is the honest ceiling, not the mean.

**How this scales.** Four of the five calls are **per changed requirement**
(table filter, additive DDL, clause reconcile, item narrative); the fifth, the run
overview, happens **once per run** regardless of requirement count. So a 10-requirement
analysis is roughly 41 calls, not 50 — but it is still roughly 10× the bill.

**Where the money goes.** The run overview alone was 8,419 of run 1's 11,746
prompt tokens (57% of the cost of the whole analysis) because it carries the
ranked table facts for every item. That prompt is the obvious future cost lever;
#1025 deliberately did **not** touch it, because shrinking it changes summary
quality and that needs its own measurement.

### Turning stages off

Each flag is an independent kill-switch — `=0` or `=false`:

```bash
IMPACT_LLM_TABLE_FILTER=0       # keep the unfiltered deterministic crossing (-1 call/req)
IMPACT_LLM_ADDITIVE_DDL=0       # no proposed new columns          (-1 call/req)
IMPACT_LLM_CLAUSE_RECONCILE=0   # no incompleteness advisories     (-1 call/req)
IMPACT_LLM_SUMMARY=0            # no narratives at all             (-1 call/req AND -1 run overview)
```

Setting all four to `0` restores the exact pre-#1025 behaviour: **zero** provider
calls, zero cost, and the deterministic floor (measured on JPetStore: 27 affected
symbols, 56 affected tables, 0 `add-column` rows, in 0.1 s). `IMPACT_LLM_SUMMARY=0`
is the single biggest saving, because the summarizer is two of the five calls and
the overview is the expensive one.

### Why `IMPACT_LLM_ENTITY_SEEDS` stayed off

It is the one stage with a **measured cost to output quality**: macro table
precision **0.7626 → 0.6909**, lower in **34 of 34** pairwise comparisons on
non-overlapping spreads. And in the live walkthrough it still did not surface
`account` — the very miss it exists to fix. It pays a measured precision loss for
an unrealised recall benefit, so it stays opt-in. Revisit only when #1002's
residual recall gap is actually solved; do not flip it for symmetry with its
neighbours.

### What the eval harness says about the flip (and why it says nothing)

`pnpm eval:impact-recall` (production configuration, 3 runs each, corpus
`impact-recall-01-jpetstore`, 11 requirements, live `claude-sonnet-5`):

| | macro table recall | macro table precision | per-run precision |
|---|---|---|---|
| before (pre-#1025 defaults) | 0.9091 | 0.7475 | 0.7727 / 0.7121 / 0.7576 |
| after (#1025 defaults) | 0.9091 | 0.7778 | 0.8030 / 0.7879 / 0.7424 |

Both PASS their production floors; **no threshold was moved**. The +0.030
precision difference is **run-to-run LLM noise, not an effect of the flip** — the
spreads overlap (0.742–0.773 is common to both), and more decisively the harness
is *structurally invariant* to these env flags: `scripts/eval-impact-recall.ts`
constructs the filter itself with an explicit `{ enabled: true }` and never reads
an `IMPACT_LLM_*` variable. That is #1016's design (measure the shipped
configuration whatever the ambient env says), and the corollary is that this
harness can neither confirm nor refute a default flip. It is reported here as a
**no-regression check**, which is all it can be.

Absolute surfaced-table counts per requirement, both configurations, so the ratio
above cannot hide magnitude — these are small sets:

| Req | before (3 runs) | after (3 runs) |
|---|---|---|
| REQ-01 | 1 / 1 / 1 | 1 / 1 / 1 |
| REQ-02 | 2 / 2 / 2 | 1 / 2 / 2 |
| REQ-03 | 3 / 3 / 3 | 3 / 3 / 3 |
| REQ-04 | 3 / 3 / 3 | 3 / 3 / 3 |
| REQ-05 | 2 / 3 / 3 | 3 / 2 / 3 |
| REQ-06 | 2 / 2 / 2 | 2 / 2 / 2 |
| REQ-07 | 4 / 3 / 3 | 3 / 3 / 4 |
| REQ-08 | 1 / 2 / 1 | 1 / 1 / 1 |
| REQ-09 | 2 / 2 / 2 | 2 / 2 / 2 |
| REQ-10 | 3 / 3 / 3 | 3 / 3 / 3 |
| REQ-11 | 0 / 0 / 0 | 0 / 0 / 0 |

REQ-11 surfaces nothing in either configuration, which by the `scorer.ts`
convention scores **precision 1.00** vacuously — see the corollary below before
reading any macro move as a real one.

## Cost, and how it is metered (#1021)

An impact run makes **five** provider calls for a single changed requirement in
the default configuration: four per-requirement (#936 filter, #932 item narrative,
#1001 additive DDL, #1005 reconciler) plus one run-level overview, with at most
one repair retry each. Every one of them is individually switchable, which is the
point of the per-stage flags.

Until #1021 **none of those calls were metered**. They reached
`AIProvider.chat()` directly, and providers do not self-meter — every other
metered caller in the codebase records at the call site
(`discussions/ai-responder.ts`). The impact pipeline
never did, so `ai_token_usages` contained **zero** rows for the most
LLM-intensive feature in the product. That is not under-counting; it is absence.

The fix is a single chokepoint. `routes/impact-analysis.ts` builds one
`ImpactLlmRuntime` per run (`lib/impact-analysis/impact-llm-runtime.ts`) and
every stage's provider goes through `runtime.instrument(provider, stage)`. The
decorator records one `AITokenUsage` row per completed call:

| Column | Value |
|---|---|
| `agentStep` | `impact.<stage>` — `impact.table-filter`, `impact.additive-ddl`, `impact.clause-reconcile`, `impact.summary-item`, `impact.summary-run`, `impact.entity-seeds`, `impact.seeding` |
| `projectId` | the project the engine was working on when the call was made |
| `sessionId` | one lazily-created `AISession` per run (no LLM call ⇒ no session row) |
| `userId` | the actor who started the run |
| `estimatedCostUsd` | the usual `estimateUsageCostUsd` cache-aware estimate |

Query the whole feature with `agentStep LIKE 'impact.%'`, or one stage exactly.

Three of the six stages get no `projectId` argument at call time (their
collaborator signatures predate this), so the engine publishes the current
project into an `AsyncLocalStorage` scope (`impact-llm-scope.ts`) that the
decorator reads. The consequence worth knowing: **a stage added later is metered
automatically**, with no new plumbing, as long as its provider comes from
`instrumentStage`. That is the specific regression #1021 asks us to make
impossible.

The run-level overview (`summarizeRun`) spans every project in a multi-project
run and belongs to none of them; its tokens are billed to the run's FIRST
project rather than dropped, because an unattributed row is the bug this
metering exists to fix.

### Measured, live, JPetStore, production configuration

Four flags on (`IMPACT_LLM_TABLE_FILTER`, `IMPACT_LLM_SUMMARY`,
`IMPACT_LLM_ADDITIVE_DDL`, `IMPACT_LLM_CLAUSE_RECONCILE`), entity seeds off,
`AI_PROVIDER=anthropic`, `claude-sonnet-5`, one changed requirement, in-process
against a copy of `dev.db`. Three runs:

| Run | Wall clock | Provider calls | Tokens | Cost (USD) |
|---|---|---|---|---|
| 1 | 18.4 s | 5 | 12,781 | 0.0504 |
| 2 | 15.8 s | 5 | 12,630 | 0.0500 |
| 3 | 20.2 s | 5 | 13,006 | 0.0532 |

Mean **≈18 s and ≈$0.051 per single-requirement analysis** (spread 15.8–20.2 s,
$0.0500–$0.0532). Five calls for one requirement, not four, because the
summarizer runs twice: once per item and once for the run overview. The run
overview dominates the bill — 8.1–8.4k of the ~12.8k prompt tokens — because it
carries the ranked table facts for every item.

#1025 re-measured the same scenario with the flags **unset** (i.e. reached through
the new defaults rather than explicit `=1`) and reproduced it: 20.2 s / 12,763 tok
/ $0.0505, 20.1 s / 12,386 tok / $0.0487 — plus one run that took a repair retry
and cost 27.9 s / 21,330 tok / $0.0775. That third run is the reason the
[cost ceiling](#what-this-costs-per-analysis) is quoted as ~$0.08 rather than
~$0.053: three runs was not enough samples to see the retry path.

## Degradation contract — what happens with no provider (#1024)

The stages ship behind flags precisely because the deterministic BM25 + graph
pipeline is the product's floor, not a fallback. This section states, once, what
"the LLM is unavailable" does.

Since #1025 this is no longer an edge case: with the stages default-ON, **every**
install that has no provider configured, an expired key, or a network fault takes
this path on **every** analysis. #1024 is what makes the flip safe, so treat the
guarantees below as load-bearing rather than defensive.

**Guarantees.**

1. **The run completes.** No provider configured, a provider that throws, and a
   provider that hangs all end in `status="completed"`, never `failed` and never
   stuck in `running`.
2. **The deterministic floor is intact.** Affected code, affected tables and
   write-path gaps are all still produced and persisted.
3. **No partial or garbage LLM-derived rows.** Each stage's own contract is
   passthrough-on-fault, and the additive-DDL/clause stages are append-only, so
   a half-parsed reply appends nothing rather than something wrong.
4. **The degradation is disclosed.** See below.

**The hang is the one that needed new code.** Every stage already caught provider
errors, but nothing bounded the call, so a provider that accepted the connection
and then stopped responding would hang `executeImpactAnalysis` forever. The
runtime now applies a hard per-call deadline, `IMPACT_LLM_TIMEOUT_MS` (default
**60000**). It both aborts the underlying request (for providers that honour
`AbortSignal`) and races it (for providers that do not), because an abandoned
socket is a far smaller problem than an analysis that never finishes. There is
deliberately no "off" value: a non-numeric or non-positive setting falls back to
the default.

**Disclosure: user-visible, not log-only.** A BA looking at a deterministic-only
result cannot distinguish "the relevance filter ran and kept everything" from
"the relevance filter never ran", and silently losing the additive-DDL
proposals — the stage that produces the only actionable output for a
business-analyst phrasing — is exactly the failure mode #1024 names. So when a
stage was **requested but produced nothing**, the engine appends one plain
sentence to the run summary:

> AI enrichment did not run for this analysis (no AI provider is configured).
> These results are the deterministic code-graph and schema baseline. Not
> applied: table relevance filtering, additive-column proposals, clause coverage
> advisories, narrative summaries.

The reason clause distinguishes *no provider configured* / *the AI provider
returned an error* / *the AI provider timed out* / *the AI provider was
unavailable* (mixed). Two things it deliberately does **not** say:

- a stage that made at least one successful call is never named, even if a later
  call failed — it contributed real output, and the result is not un-enriched;
- a stage that is simply switched **off** is never named. That is a configured
  choice, not a degradation, and warning about it on every run would train
  operators to ignore the notice.

**Operator signal.** Every degraded call also emits a WARN from the
`impact-llm-runtime` logger naming the `stage` and the reason
(`impact LLM stage call failed…` / `…timed out…` / `impact LLM stage enabled but
no usable provider`). Combined with the metering above, "no `impact.*` rows in
`ai_token_usages` for a completed run" is now a positive signal that the LLM path
was skipped, rather than being indistinguishable from the old unmetered normal.

### Measured, live, JPetStore

Same harness as the cost table, with the four flags on:

| Scenario | Status | Wall clock | Token rows | Affected symbols | Affected tables | `add-column` rows | Tiered tables | Narratives |
|---|---|---|---|---|---|---|---|---|
| Live provider | completed | ~18 s | 5 | 27 | 58 | 2 | 56 | 1 |
| No provider (`AI_PROVIDER=offline-stub`) | completed | 0.6 s | 0 | 27 | 56 | 0 | 0 | 0 |
| Invalid API key (401 on every call) | completed | 2.0 s | 0 | 27 | 56 | 0 | 0 | 0 |
| Provider timeout (`IMPACT_LLM_TIMEOUT_MS=1`) | completed | 0.6 s | 0 | 27 | 56 | 0 | 0 | 0 |

The deterministic floor is byte-for-byte the same in all three degraded modes:
27 affected symbols and 56 affected tables — the live run's 58 is those same 56
plus the 2 LLM-proposed `add-column` rows, which is the append-only property of
#1001 showing up in the numbers.

#1025 re-ran this under the **new defaults** (nothing set but the provider) and
reproduced every row: no provider ⇒ `completed` in 0.1 s at 27/56/0 with the
disclosure sentence *"(no AI provider is configured)"*; an invalid key ⇒
`completed` in 3.2 s at 27/56/0 with *"(the AI provider returned an error)"*. It
also confirmed the kill-switches reach the same floor by a different route:
`IMPACT_LLM_TABLE_FILTER=0 IMPACT_LLM_ADDITIVE_DDL=0 IMPACT_LLM_CLAUSE_RECONCILE=0
IMPACT_LLM_SUMMARY=0` (and the same four spelled `false`) ⇒ `completed` in 0.1 s,
**0 provider calls**, 27/56/0 — and, correctly, **no** disclosure sentence, because
a stage that is switched off is a configured choice, not a degradation.

## Related documents

- `docs/DATABASE_IMPACT_ANALYSIS.md` — the database-aware analysis feature itself.
- `docs/ARCHITECTURE.md` — where these modules sit.
