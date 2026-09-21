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
| Table-relevance output filter (#936) | `impact-analysis/table-relevance-filter.ts` | `IMPACT_LLM_TABLE_FILTER` | **ON** (#1025) | integer index into the crossing's own candidate rows | unfiltered crossing |
| Additive column DDL proposal (#1001) | `impact-analysis/additive-column-proposer.ts` | `IMPACT_LLM_ADDITIVE_DDL` | **ON** (#1025) | integer index into the crossing's own tables + a closed type allowlist | no proposals appended |
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
| Additive-column *intent* fast path | `impact-analysis/schema-impact.ts` (`detectAdditiveColumnIntent`, #923) | Still first in `crossToSchema` and untouched by #1001. It fires instantly for a developer imperative; the LLM proposer only covers the business-analyst obligation phrasings it cannot match. |

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
(`discussions/ai-responder.ts`, `testcoverage/judge.ts`). The impact pipeline
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
