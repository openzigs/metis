# ADR 0006 — Chunker drift: serve degraded, but make it observable

- **Status:** Accepted
- **Date:** 2026-07-31
- **Resolves:** GitHub #1182
- **Supersedes the reasoning in:** PR #1181's "forced reindex, not a chunking tag"
  section (the conclusion was half right; the argument it rested on was not — see
  [What #1181 got wrong](#what-1181-got-wrong))
- **Citation convention:** files **this PR edits** are cited by **symbol name**, not by
  line. Line citations into a file the same diff keeps growing go stale by construction —
  these went stale twice, once per review round, and one of them was the reference for the
  finding the whole diff hinged on. Line numbers are reserved for files left untouched.
- **Related:** #1178 (the chunker fix that created the drift), #1160 (the harness that
  found it), [ADR 0005](0005-fix-the-embedder-vary-the-reranker.md) (the *embedding*
  model tag this is deliberately not modelled on), #792 / #797 (composite embedding
  identity), #787 (the migration CLI this rides), #1184 (whether the chunk-size default
  should move — explicitly not decided here; **since answered on a 198-query corpus: it
  does not move, and for the first time that null is resolved at the pre-registered ±0.04
  floor. This ADR's migration path is therefore still unexercised by a size change.**)

## Decision

> **A chunker-generation mismatch is SERVED, not excluded — and it is REPORTED.**
>
> Chunks cut by a superseded chunker generation keep participating in retrieval
> exactly as they do today. Nothing is filtered, nothing goes dark, no default moves,
> nothing is backfilled.
>
> Separately, every chunk written from now on carries
> `KnowledgeChunk.chunkerIdentity`, and `pnpm embeddings:migrate status` reports a
> chunker drift **distinctly from a model drift**, with its own exit code and its own
> remedy.

The two halves are independent, and keeping them independent is the whole content of
this ADR. "Do not exclude" and "do not detect" are different decisions that #1181
took as one.

## The axis: exclude-until-reindex vs serve-degraded

Both `embeddingModel` (ADR 0005) and `chunkerIdentity` are per-row generation tags,
so it is tempting to reason about them identically. That is the trap. **Neither tag
repairs anything** — `constants.ts:594-597` is explicit that mismatched rows "are
excluded from retrieval by their `embeddingModel` tag … but they stay unusable until
a reindex" — so "does a tag repair the corpus?" is not a question that separates the
two cases. It answers *no* for both.

What separates them is what happens to a mismatched row **if you do nothing**:

| | Model mismatch | Chunker mismatch |
|---|---|---|
| Are the vectors comparable? | **No.** 384-d and 768-d rows are not points in one space; ranking them together is meaningless (`symbol-embedding-service.ts:331-334` calls the filter "MANDATORY, not an optimisation") | **Yes.** Same model, same width, same space. The vectors rank correctly |
| What is wrong with the rows? | Nothing is retrievable from them at all | Their *text* has gaps — #1178 left 94.1% of characters indexed at the shipped 2048/256 |
| Cost of serving them | A correctness failure | A quality regression |
| Cost of excluding them | Zero — they were unusable anyway | The corpus goes **completely dark** until someone re-ingests |
| Therefore | **Exclude.** Mandatory | **Serve.** Excluding is strictly worse than the disease |

So exclusion is mandatory in one case and actively harmful in the other, and the
reason is the *comparability of the vectors* — not anything about tags. A gapped
chunk still answers most queries it would have answered; an un-indexed chunk answers
none. Taking a working-if-imperfect index dark, to punish it for being imperfect, is
not a trade anyone would accept if it were stated plainly.

### But "do not exclude" does not imply "do not detect"

ADR 0005's model tag does **two** jobs at once — it *distinguishes* generations and
it *drives an exclusion filter* — and because those always travel together for the
model case, it is easy to treat the tag as being *for* exclusion. On the chunker axis
the two jobs come apart cleanly:

- **exclusion** is rejected, above;
- **detection** stands on its own, because the alternative is what shipped: silence.

That separation is the finding. Everything below is its consequence.

## What an operator saw before this ADR

Nothing. Not "a warning nobody reads" — nothing at all.

`coverageReport()` and `deploymentCoverage()` (both in `rag/knowledge-service.ts`)
group on `embeddingModel`, which records how a chunk's text was **vectorised** and
says nothing about how it was **cut**. #1178 moved every boundary *without changing a
parameter*, so a corpus ingested in June and one ingested today carry byte-identical
model tags. Concretely, on a store holding both generations:

- `coverageReport().needsReindex` → `false`
- `deploymentCoverage().projectsNeedingReindex` → `0`
- `pnpm embeddings:migrate status` → prints **`Up to date.`** and **exits 0**

#1161 declined to add a startup warning precisely because `coverageReport()` and
`deploymentCoverage()` already exist and are better. That was right about the model
question and simply does not reach this one: the mechanism it pointed at is blind
here. A second, from-scratch check would also have walked straight into the #792/#797
split — documents compare a composite pooling/dtype identity, symbols the bare model
id — which is why the signal is added **inside** those two methods rather than beside
them.

## The remedy is a RE-INGEST, and this is where the issue's own framing was wrong

#1178's PR and #1182's issue body both say the remedy "stays the reindex that already
exists (Admin → Embedding backends, or `pnpm embeddings:migrate`)". **It is not.**

The shared `chunkMarkdown` has exactly **one production call site that writes
`knowledge_chunks`**: `KnowledgeService.ingestDocument`. (It is called elsewhere — the
eval harness `eval/doc-retrieval/wired-harness.ts` and several tests — but nothing else
persists rows, so the claim the remedy rests on is about *writers*, not callers. An
earlier draft said "called in exactly one place", which is literally false.)
`KnowledgeService.runReindex` reads
`prisma.knowledgeChunk.findMany({ select: { text: true, … } })` and re-embeds the
stored chunk **text**. Chunk boundaries are frozen at ingest and a reindex never
revisits them.

> **Careful with that sentence.** An earlier draft went further and said ingest is the
> only place that writes `knowledge_chunks` at all. That is false — see
> [More than one writer](#more-than-one-writer) — and two of the three review voters
> blocked on it. "One caller of the shared chunker" and "one writer of the table" are
> different claims, and the diff hinged on the second.

So pointing an operator at `reindex` for chunker drift is worse than saying nothing.
They would spend hours re-embedding, watch it report success, and still have every
gap — and, because a reindex is what a drift report normally means, they would
reasonably conclude the problem was fixed. That is the exact shape of the #804 defect,
where `retag` made coverage "confidently report an index that does not exist".

Consequently:

- `needsReingest` is **never** folded into `needsReindex`, and `projectsToReingest` is
  never folded into `projectsToReindex`. If it were, `reindex --all` would claim work
  it cannot perform.
- `reindexProject` deliberately does **not** stamp `chunkerIdentity`. Re-embedding
  does not re-cut, so stamping would launder a gapped corpus into one that reports as
  current. A regression test asserts its post-swap `updateMany` writes
  `embeddingModel` and nothing else.
- The plan step says "Re-ingest … **This is NOT a reindex**" in those words.

## The tag is composite — producer, version, parameters

`chunkerIdentity` is `<producer>:v<algorithm>:<chunkSize>/<overlap>` — `doc:v2:2048/256`.

**The first draft justified the version wrongly, and the review panel caught it.** It
claimed a parameters-only tag "fails on #1178". It does not: because the column is new
and deliberately not backfilled, every pre-#1178 row is NULL under *either* design, so
`2048/256` separates the two #1178 generations exactly as well as `doc:v2:2048/256`.

The version earns its place on the **next** boundary change, not the last one. Once both
generations carry a tag, a same-parameter change to the chunker — precisely what #1178
was — produces two identical `2048/256` strings and the drift goes invisible again. The
version is the only field that separates them. Precedent is in-repo: #792 made the
*embedding* identity composite (`model|pooling|dtype`) after a same-model pooling flip
changed the vectors.

The **producer** segment exists because `KnowledgeChunk` has more than one writer — see
the next section. It is compared by splitting on the first `:`, never by prefix, so
`doc` cannot swallow `docsgen` (the substring-vs-segment confusion that de-gated a path
check in #1172).

The effective overlap is used, not the requested one. #1185 caps overlap at a quarter
of `chunkSize`, so `2048/1500` and `2048/512` produce byte-identical chunks; tagging
them differently would report a drift that does not exist.

A version constant a human must remember to bump is itself fail-open, so it is not
left to memory. `tests/rag-chunker-identity.test.ts` guards it two ways:

- **a digest** of the active generation's boundary signature over a fixture reaching
  every tier, at all four arms — change a boundary rule without bumping and it fails
  naming the constant; bump without recording a signature and it fails for the opposite
  reason;
- **a per-tier gate** over `BOUNDARY_TIERS`, with one arm per tier deleted and one per
  adjacent pair transposed, each required to move a boundary.

**The second exists because the first was measurably not enough, and the way it failed
is worth recording.** A digest over a fixed chunker pins each tier's *arithmetic* — flip
`+2` to `+1` and it moves — but is blind to a tier's *existence and precedence*. PR
#1194's review measured this: with the fixture's paragraphs built as single lines, the
last `\n\n` in any window forced `lastIndexOf("\n")` to return the very next index, so
the paragraph tier's `from + i + 2` equalled the line tier's `from + (i + 1) + 1` in all
24 windows it won. Deleting the tier, and separately demoting it below the line tier,
each left the digest byte-identical and the pin green 13/13.

The fix was both halves: hard-wrap the fixture's paragraphs so the tiers can disagree,
and stop trusting the fixture — `findBoundary`'s `if`-chain became an ordered
`BOUNDARY_TIERS` table so the gate can mutate the precedence declaration itself. The
gate then immediately found a *third* hole (line↔sentence transposition changed nothing,
because no shape had a line end and a later mid-line `". "` both past the floor), which
is the argument for mechanising it rather than adding one more fixture shape by hand.

The guarantee, stated exactly: any change moving a boundary for the fixture at any arm
fails the digest, and any deletion or adjacent reordering of a tier fails the gate. A
boundary change no fixture shape exercises is still invisible, so a new tier must arrive
with a shape only it can cut.

## More than one writer

`knowledge_chunks` has **two** producers, and the first draft of this ADR asserted it
had one. The review panel's `over-blocking` and `instruction-correctness` voters both
blocked on it independently, with the same citation.

`docs-gen/rag-ingest.ts` ingests generated documents. Its `ingestDocumentToRag` writes
`knowledge_chunks` directly via `prisma.knowledgeChunk.createMany`, from its **own
private 1,500-character chunker** — a module-local function also named `chunkMarkdown`,
which is precisely what made it easy to dismiss as a grep hit on the shared one — that
has nothing to do with `rag/chunker.ts`. It runs on the live path after every document
generation (`routes/generated-docs.ts:519`, untouched by this PR).

Those rows are not a stale generation of the document chunker. They are a different
corpus, cut correctly by a different algorithm, and #1178 never touched them. Compared
naively against `doc:v2:…` they read as permanent drift — and the drift is
**unclearable**, because the prescribed remedy (re-run generation) re-runs that same
foreign chunker. The panel measured the consequence on the live dev database:
**103 of 1,415 chunk rows, in 2 of 3 projects**, would have pinned
`embeddings:migrate status` at exit 3 forever, telling an operator to perform work that
could never satisfy it. That is a worse failure than the silence this ADR set out to
fix: a permanently red light trains people to ignore the light.

Hence the `producer` segment, and hence `classifyChunkerIdentity`'s four states —
`current`, `drifted`, `untagged`, `foreign` — with `foreign` **excluded from the
verdict but still shown in the report**. An operator can see the corpus is mixed; they
are not told to fix something that is not broken.

One shared predicate drives `coverageReport`, `deploymentCoverage` and `formatStatus`,
so the per-project view, the deployment view and the printed report cannot disagree the
way the hand-written filters did in #1191 — where PR #1192 records **three** exit-0
bypasses arising from a diff-side and a disk-side filter that did not agree.

## Docs-gen drift is deliberately untracked

The producer segment fixes the permanent-exit-3 defect above, and it has a consequence
that must be stated rather than left to be discovered: **`classifyChunkerIdentity` only
ever compares a stored value against `chunkerIdentity(...)`, whose producer is always
`doc`. So every `docsgen:*` value classifies `foreign` whatever its version, and a
future boundary change inside `rag-ingest.ts`'s private chunker is invisible to every
verdict, count and exit code.** The fix that stopped generated-doc rows reading as
permanent drift also made generated-doc drift permanently undetectable.

An earlier draft shipped an instruction at `DOCSGEN_CHUNKER_IDENTITY` to "bump `v1` if
the chunker below changes". PR #1194's review showed it was **dead text**: no code path
can compare two `docsgen` generations, so bumping changes one string in one report line
and nothing else. That is the declared-but-unreachable class this repository closed four
times in the same week (#1162 a missing `Skill` tool, #1163 an unwritable memory store,
#1168 undeclarable `Glob`/`Grep`, #1180 unreachable `mcp__*` instructions), and it is
worse than silence: a maintainer would dutifully honour it and buy nothing.

**Decision: delete the instruction, and record the trade here.** The instruction is gone
from `rag-ingest.ts`, replaced by an explanation of why there is none.

The trade is acceptable because the two corpora have different repair properties, which
is also the reason #1182 exists for `doc` and not for `docsgen`:

| | Shared chunker (`doc`) | Generated docs (`docsgen`) |
|---|---|---|
| What re-cuts a stored row | **Nothing.** `chunkMarkdown` runs at ingest only | Regeneration — `ingestDocumentToRag` deletes the document's prior rows and rewrites them |
| So drift is cleared by | An operator re-ingesting a named list of projects | The next regeneration of each document, with no operator action |
| Therefore detection is | Load-bearing — the corpus never self-heals | Advisory at best |

**Rejected alternative: a producer registry.** Classify each stored value against its own
producer's active identity (`doc` → `chunkerIdentity(...)`, `docsgen` →
`DOCSGEN_CHUNKER_IDENTITY`), leaving `foreign` for genuinely unregistered producers. It
is the more general design and it would make the bump reachable, so it is rejected on
scope and on the exit contract rather than on taste: exit 3's documented remedy is
**"re-ingest the documents"**, and that is the wrong instruction for a `docsgen` row —
its remedy is "regenerate the document", a different operation on a different surface.
Making docsgen drift visible therefore means either prescribing a remedy that does not
apply (the exact #804 shape this ADR is at pains to avoid) or adding a fourth exit code
and a second remedy vocabulary, which is a larger decision than #1182 was scoped to take.
The version segment stays in `docsgen:v1:1500` so the format is uniform and a registry
remains possible later without migrating any stored value.

### The two unknown cases fail in opposite directions, and both are argued

`untagged` fails **closed** (counted as outstanding); `foreign` fails **open** (excluded
from the verdict). That asymmetry is deliberate, and the review was right that only one
half had been argued.

The distinction is whether anything is actually *claimed*. `docsgen` is a producer we
know about and have decided, above, not to track. A value with **no producer segment at
all** claims nothing and can only arise from corruption or a bug — so it now classifies
`untagged`, not `foreign`. It previously fell through to `foreign` and was silently
dropped from the verdict, which was the wrong polarity for the one case nobody designed.
Unreachable today, since both writers stamp from constants; fixed anyway, because
"unknown ⇒ fine" is the standing way a gate in this repository ships already open.

What remains fail-open by design is a **named** unknown producer — a hypothetical third
writer that stamps its own identity. That is reported but not counted. If a third writer
ever appears, the registry above is the change to make.

## Untagged rows are a generation, not missing data

Existing rows are **not** backfilled. `chunkerIdentity IS NULL` means "written before
#1182 — provenance unrecorded", and the report says exactly that rather than claiming
the row is pre-#1178 with gaps. It might be; it might equally be a generated-doc chunk.
The tag records what we know, and for these rows we know nothing.

Inventing a value would assert a chunking nobody measured, in the one direction that
hides the problem. `untagged` is therefore counted as work outstanding: every pre-#1178
row is in that bucket, and defaulting the unknown case to "fine" is how a gate ships
already open.

**Two honest imprecisions, stated rather than smoothed over.**

1. Rows ingested between #1178 and #1182 are correctly chunked but untagged, so they
   over-report. Days-wide window.
2. Generated-doc chunks written before this release are untagged too, so a deployment
   with generated docs reports drift once. Clearing it means re-running those
   generations, which buys no #1178 benefit.

Both err toward advising unnecessary work rather than hiding necessary work. A targeted
backfill *was* available for (2) — those rows carry `"source":"generated-doc"` in their
JSON metadata — and was **not** taken: the issue rules out backfills, and keying the
verdict off metadata as well as off the identity column would create a second source of
truth about provenance, which is exactly the two-filters-disagree shape that produced
three exit-0 bypasses in #1191. The rows self-heal on the next regeneration.

## The exit-code contract

`pnpm embeddings:migrate status`:

| Code | Meaning | Remedy |
|---|---|---|
| 0 | Nothing outstanding | — |
| 1 | Model/column drift, or a broken embedder. Those rows are **dark** — the read path filters on the model tag, so dense retrieval returns nothing for them | `prepare` / `reindex` |
| 2 | Usage error, or a command refused a destructive action | — |
| **3** | **Chunker drift only.** The index is **serving**; chunks cut before #1178 have gaps, so retrieval is degraded rather than absent | **Re-ingest** the documents |

The codes encode **whether the index is serving**, not a severity ordering — which is
the same distinction the whole ADR turns on, made machine-readable. 1 is unchanged, so
every existing deploy gate keeps its current behaviour on the model axis.

**Compatibility, stated plainly:** before #1182 chunker drift exited 0. A gate that
treats any non-zero code as fatal will now fail on a corpus that was *already*
degraded. That visibility is the point of the issue, not a regression; a gate that
should block only on a dark index can spell it:

```bash
pnpm embeddings:migrate status; c=$?; [ "$c" -eq 0 ] || [ "$c" -eq 3 ]
```

## Alternatives rejected

**1. Exclude chunker-drifted rows from retrieval, mirroring the model filter.**
Rejected on the axis above: the vectors are comparable, so exclusion buys no
correctness and costs the whole corpus until someone re-ingests. It is the one option
that makes retrieval measurably worse the moment it ships.

**2. No tag at all — a one-time "reindex everything" instruction (the #1181
position).** Rejected on two counts. It assumes the drift is a single historical cut,
but `RAG_CHUNK_SIZE`/`RAG_CHUNK_OVERLAP` are env-settable, #1184 is open on the
defaults and #1183 is sweeping overlap, so generations will diverge again — and the
tag is what makes the *next* split visible instead of silent. It also cannot say
*which* projects are affected, and a re-ingest is expensive enough that "re-ingest
everything" is a materially worse instruction than "re-ingest these three".

**3. Derive the drift from the stored chunks instead of tagging them.** Seductive —
zero schema cost — and rejected on measurement. A post-#1178 chunking overlaps
consecutive chunks *within a section*; a pre-#1178 one leaves gaps. But most sections
fit in a single chunk, so most chunks carry no continuation evidence at all: PR #1181
measured **51 genuine continuations against 476 chunks** at 2048/256 on the committed
corpus. A detector would therefore be undecidable for ~89% of chunks and for every
small document, where the tag is decidable for 100%. Worse, telling a genuine
continuation from a section transition is the subtle part that already produced a
**ninefold** measurement error in #1178's own reporting, and that logic lives in the
eval module — re-deriving it in the production path would be a second source of truth
with a different filter, which is the standing way gates in this repository ship
fail-open.

**4. Re-chunk the source document to compare.** Exact, and far too expensive: it means
reading the original file out of storage and re-running `parseDocument` (PDF, DOCX, …)
for every document, on a command an operator runs to *check* health.

**5. Fold chunker drift into `needsReindex` and reuse exit 1.** Rejected: it
prescribes a remedy that provably does nothing (see above). One signal, two remedies,
is how an operator ends up trusting a reindex that changed no boundary.

## Consequences

- A store holding two chunker generations is visible. `status` prints the per-generation
  split, names the affected projects, and exits 3.
- Retrieval behaviour is **unchanged**. No default, no filter, no dimension, no chunk
  size moves. Existing rows are untouched.
- `KnowledgeChunk` carries one nullable column. Written by each of the two producers at
  the point it cuts — the only places that can honestly answer the question — and carried
  through the quarantine hop in the quarantine row's existing JSON metadata, so
  `QuarantineChunk` needs no schema change.
- **Any future writer of `knowledge_chunks` must stamp a producer identity.** An unstamped
  writer's rows land in `untagged` and are reported as work outstanding forever. That is
  the fail-safe direction, but it is still wrong, and it is the defect this ADR shipped in
  its first draft.
- **Provenance has exactly one source of truth: the column.** A targeted backfill of
  generated-doc rows was available — they carry `"source":"generated-doc"` in their JSON
  metadata — and was declined. Keying the verdict off metadata *as well as* off the
  identity column would create a second answer to "who cut this row", which is the
  two-filters-disagree shape that produced three exit-0 bypasses in #1191. This is a
  consequence to hold onto, not merely an alternative that lost: the next person to want
  a cheap backfill will find the same metadata and the same temptation.
- The admin coverage route (`routes/admin/embeddings.ts:228`) returns the new fields
  additively; the UI ignores them until someone surfaces them, which is not in this
  issue's scope.
- **Drift in the `docsgen` chunker is not detected, on purpose** — see
  [Docs-gen drift is deliberately untracked](#docs-gen-drift-is-deliberately-untracked).
  Any *third* writer of `knowledge_chunks` would need that section revisited along with
  the stamp.
- Anything that changes chunk boundaries in future must bump
  `CHUNKER_ALGORITHM_VERSION`, and a test will fail until it does.

## What #1181 got wrong

#1181 reached "forced reindex, no chunking tag" — and its remedy half is wrong twice
over.

Its stated justification was that a tag "could distinguish generations but never
repair them". That is true, and it proves nothing: it is **equally true of ADR 0005's
model tag**, which the same PR relies on as the model of a working guard. An argument
that would also delete the mechanism you are citing as precedent is not an argument.
The load-bearing difference is comparability of vectors, which decides *exclusion* —
and exclusion is a separate question from *detection*, which is the one #1182 was
actually about.

Its remedy — "the reindex that already exists" — names an operation that cannot repair
chunker drift at all.

The conclusion on the exclusion half survives re-derivation and this ADR keeps it:
**serve degraded**. The detection half is reversed, and the remedy is corrected from
*reindex* to *re-ingest*.

## References

- Chunker and the version constant: `server/src/lib/rag/chunker.ts`
  (`CHUNKER_ALGORITHM_VERSION`, `chunkerIdentity`)
- Column: `server/prisma/schema.prisma` (`KnowledgeChunk.chunkerIdentity`), migration
  `20260731000000_issue1182_chunker_identity` on both dialects
- Coverage: `server/src/lib/rag/knowledge-service.ts` (`coverageReport`,
  `deploymentCoverage`)
- Plan, report and exit codes: `server/src/lib/rag/embed-migration.ts`,
  `server/scripts/embed-migrate.ts`
- Operator runbook: [`docs/EMBEDDINGS_BACKENDS.md`](../EMBEDDINGS_BACKENDS.md)
