# Document understanding: the Phase 0 baseline (#2229)

- **Issue:** #2229, Phase 0 of epic #2227 ("METIS understands the documents it is given")
- **Measured:** 2026-11-10, at commit `8a0601902`, on `claude-sonnet-5-5` (production) and `deepseek-flash` (iteration)
- **Readings:** `eval-data/readings/doc-understanding/`
- **Harness:** `pnpm --filter server eval:doc-understanding` (`server/src/lib/eval/doc-understanding/`)

## The answer

When an analyst gives METIS a Word FRD today, Requirements Analysis finds **about a quarter
of its requirements**: 0.26 recall on Sonnet 5.5 and 0.27 on DeepSeek, falling from 0.37 on
a 22 KB document to 0.14 on a 35 KB one. Most of the questions it then asks the analyst are
not worth asking (0.27 on Sonnet). **Reading the whole document finds every requirement**
(recall 1.00 on all three documents on Sonnet, precision 0.93) and asks a dozen questions
per document, all of them judged worth asking. Reading section by section also finds
every requirement and raises the most ambiguities (0.92), but it repeats and over-splits
requirements (precision 0.59), asks 78 questions per document of which about a third are
worth asking, and costs 3.5 times as much as the whole-document read.

The gap between today's reading and either alternative (+0.73 to +0.74 recall, +0.73 section
coverage) is far larger than anything run-to-run variation or the judge could explain, and
it holds on both models. The reader issue's default follows from it: **read the whole
document, not ten chunks.** Two limits come with that, both measured below: one reply has
to hold every requirement (the output cap), and the whole-document reader under-asks
about what a document leaves out.

## What was measured

### The corpus

Three synthetic Word documents written for this measurement (CC0-1.0), each larger than
what today's document agent reads. Every requirement is labelled with its source span, and
every ambiguity a business analyst would want raised is labelled with the question it
needs.

| Document | Kind | Word file | Converted text | Sections | Labelled requirements (sections) | Labelled ambiguities |
|---|---|---|---|---|---|---|
| `docunderstanding-01-clinic-booking` | FRD | 18 KB | 22,129 chars | 26 | 46 (12) | 11 |
| `docunderstanding-02-freight-claims` | BRD | 18 KB | 23,478 chars | 36 | 58 (16) | 12 |
| `docunderstanding-03-community-grants` | FRD | 22 KB | 35,075 chars | 53 | 102 (30) | 14 |

The ambiguities are of six kinds: vague terms ("near real time", "promptly"), undefined
terms ("high-value consignment"), escape clauses ("where possible"), contradictions (twelve,
several between distant sections, one between a summary table and the body), gaps the
document is silent on (ten), and decisions it leaves open (eight). Every arm reads the Word
file through production's `parseDocument` (mammoth, then `htmlToMarkdown`), so the
conversion's losses are part of every reading: numbered lists arrive as bullets.

**A fourth document has been added since this baseline (#2255), with no results yet.**
`docunderstanding-04-library-lending` is a 31 KB Word FRD (60,624 characters converted, 81
sections, 214 requirements in 45 sections, 28 ambiguities). Many of its requirements are
written in the second person or as plain statements rather than "shall". Every reading
above covers documents 01 to 03 only. See `eval-data/README.md`.

**The labels were written by the document's author and have not been reviewed by a second
person.** The Miniflux sample the issue suggested as a starting point is not in the
repository, and the existing `eval-data/corpus/brd-*` items are about 500 bytes each, so the
corpus was written from scratch.

### The arms

| Arm | What it is |
|---|---|
| **A** (today) | The document chunked by production's chunker and retrieved the way `retrieveContext` serves the document specialist (`buildRetrievalQueries` + `runGroundedRetrieval`, k = `ANALYSIS_RETRIEVE_K` = 10), then production's `runAgent("document")`, then what `runEnhancementPipeline` makes of its output: `RequirementsExtractor` over the agent's requirement texts. Its requirements are the structured requirements the analyst approves; its questions are their ambiguities' suggested questions (the UI's clarification toggle is on by default). |
| **B** | The whole converted document in one call: every requirement and every question, each with a verbatim quote. |
| **C** | One call over the whole document for a summary, glossary and actors; one call per section (production's `splitSections`, the governing rule reader's) with that context; one reduce call that drops repeated requirements, settles the questions and adds cross-section conflicts. |

Retrieval in arm A is lexical (production's BM25 options), padded to k with unmatched
chunks in document order, so A always reads ten chunks as production's hybrid search
would. That leans toward A: it cannot read less than production does.

### The metrics

A judge (a model call, the same model as the arms) is shown the document, the labels and
an arm's output. For each extracted requirement it names the labelled requirement it
states, or none; for each question it names the labelled ambiguity it asks about, or none,
and says whether a reviewer would want it put to the author. The rest is computed in code:

- **Requirement recall:** labelled requirements some extracted requirement states.
- **Requirement precision:** extracted requirements that state a labelled one not already
  claimed. A repeat counts against precision, because the analyst reads it twice.
- **Section coverage:** of the sections holding a labelled requirement, the share from which
  at least one was found.
- **Question precision:** questions the judge says are worth asking.
- **Ambiguity recall:** labelled ambiguities some question asks about.
- **Quote accuracy:** requirement quotes found verbatim in the document (B and C only;
  deterministic, no judge).
- **Cost per document:** the arm's own spend, priced the way METIS's usage ledger prices it;
  the judge's spend is reported separately.

## Results

### Sonnet 5.5 (`baseline-sonnet-5-5`)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc |
|---|---|---|---|---|---|---|---|---|---|
| A | 0.26 [0.14–0.37] | 0.74 [0.61–0.81] | 0.27 [0.13–0.42] | 0.27 [0.16–0.33] | 0.28 [0.08–0.55] | n/a | 21.0 | 48.3 | $0.1213 |
| B | **1.00** | **0.93** [0.88–0.97] | **1.00** | **1.00** | 0.69 [0.50–0.91] | 1.00 | 73.0 | 12.0 | $0.2002 |
| C | 0.99 [0.96–1.00] | 0.59 [0.57–0.61] | 1.00 | 0.36 [0.29–0.41] | **0.92** [0.91–0.93] | 1.00 | 113.3 | 78.0 | $0.7031 |

Means over the three documents, one run each; [min–max] over documents.

| Document | A recall | B recall | C recall | A coverage | A questions worth asking |
|---|---|---|---|---|---|
| 01 clinic booking (22 KB) | 0.37 | 1.00 | 1.00 | 0.42 | 0.33 |
| 02 freight claims (23 KB) | 0.26 | 1.00 | 1.00 | 0.25 | 0.32 |
| 03 community grants (35 KB) | 0.14 | 1.00 | 0.96 | 0.13 | 0.16 |

### DeepSeek (`baseline-deepseek-flash-A`, `baseline-deepseek-flash-BC-cap21333`)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | $ / doc | Readings |
|---|---|---|---|---|---|---|---|
| A | 0.27 [0.16–0.37] | 0.65 [0.61–0.68] | 0.32 [0.17–0.42] | 0.50 [0.37–0.65] | 0.19 [0.00–0.36] | $0.0226 | 3 of 3 |
| B (cap 21,333) | 0.97 [0.95–1.00] | 0.89 [0.82–0.96] | 1.00 | 1.00 | 0.66 [0.50–0.82] | $0.0473 | 2 of 3: document 03 failed (its cost included) |
| C (cap 21,333) | failed | | | | | $0.1321 | 0 of 1: the reduce failed on document 01 |

At production's output cap (`ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS`, 16,384) **B failed on
all three documents and C on document 01** (`deepseek-flash-BC-cap16384-failures`): DeepSeek
spends the whole cap on reasoning and returns no answer (`finishReason: max_tokens`, empty
content, confirmed on a direct call). At the SDK's non-streaming ceiling of 21,333, B
succeeds on documents 01 and 02 and still fails on 03. C was not run on DeepSeek for
documents 02 and 03 once its reduce had failed on the smallest one.

## Findings

1. **Today's path reads about a third of a typical FRD and less of a large one.** Ten chunks
   covered 9,463, 9,611 and 8,170 characters: 43%, 41% and 23% of the documents. The
   epic's estimate of "~20 KB" assumes full 2,048-character chunks. `chunkMarkdown` cuts at
   every heading, so a heading-dense FRD yields short chunks (26, 36 and 54 chunks for 22–35
   KB). Retrieval prefers the opening, objectives and stakeholder sections, which match the
   static query bag ("business goals stakeholders rules constraints..."), and the requirements
   sections deep in the document are the ones not read. Nothing in today's output says so.
2. **Today's questions come from paraphrases, and it shows.** A asks 48 questions per
   document on Sonnet; 27% are worth asking, and it raises 28% of the labelled ambiguities.
   It raised 4 of 12 contradictions and 1 of 10 gaps: a contradiction between two sections
   cannot be seen from a paraphrase of one of them.
3. **The whole-document read finds everything, and asks well but not enough.** B's 12
   questions per document were all judged worth asking, and it raised every open decision
   (8 of 8) and 8 of 12 contradictions, but only **3 of 10 gaps** the document is silent on.
   C, which asks about every section, raised 9 of 10 gaps. The question loop (Phase 2)
   should not take B's question list as complete.
4. **One reply has to hold every requirement, and that is the whole-document read's limit.**
   On Sonnet, B's reply for the 35 KB document needed a re-prompt (32,201 output tokens over
   two attempts, consistent with the first reply being cut off at the 16,384 cap). On DeepSeek it failed outright on
   that document even at 21,333. A 60 KB FRD (the epic's definition of done) will not fit
   one non-streaming reply. Reading the whole document as *input* is cheap; *writing every
   requirement in one answer* is what breaks. The reader should read the whole document but
   emit its requirements in batches (by section), stream the reply, or both.
5. **Section by section over-produces.** C finds every requirement, but extracts 113 per
   document against 69 labelled: repeats across sections and one requirement split into
   several. Its reduce dropped only 2–5 repeats per document, and kept 78 of its sections'
   ~124 questions. It costs 3.5 times as much as B (more input: the context block is sent
   with every section). On DeepSeek the reduce, one call over every section's output, failed.
6. **DeepSeek is a usable iteration model for this work only with a larger output cap.**
   With 16,384 it produced nothing for B or C; arm A, whose replies are short, ran fine.

## What follows for the reader issue

- **Default: read the whole document.** The measured gain over today (+0.74 recall on
  Sonnet, +0.70 on DeepSeek, on every document) is the gain the epic's definition of done
  asks for before a flag defaults on.
- **Emit requirements by section, not in one reply.** Keep the whole document in context
  (B's input) and ask for the requirements of one section, or a batch of sections, per
  call. That keeps B's precision (no repeats from a context-free section read) and removes
  the output ceiling that finding 4 hit.
- **Report coverage.** The section coverage computed here (sections with a requirement
  found, of sections with a requirement) is cheap to compute in production from source
  quotes. B and C quoted their sources verbatim every time (quote accuracy 1.00), so
  production can verify each quote with `clauseLocator`, the governing rule reader's check.
- **Ask about gaps deliberately.** Neither the whole-document read nor today's path asks
  about what the document leaves out often enough; a per-section "what does this section
  need that the document does not say" pass is where C's ambiguity recall came from. Its
  questions need pruning before an analyst sees them: C's 36% question precision is not
  shippable.

## How far to trust this

- **The labels have one author**, who also wrote the documents. A second reviewer should go
  through each `frd.src.md` (the trailer lists each ambiguity and its question). Precision
  in particular is a floor: an extracted requirement the labels missed counts as a false
  positive. Reports from now on list those (`unmatchedExtracted`) for that review; the
  readings above predate the field.
- **One run per document and arm.** Arm A's recall was within 0.03 across the two models on
  every document, which suggests the gap is not noise, but no repeat run was made on one
  model.
- **The judge is the arms' own model.** A self-preference bias would favour B and C (model
  output) over A (also model output, but paraphrased twice); the judge never sees which arm
  it is grading. The deterministic quote check agrees with it that B and C quote real text.
- **Synthetic documents, three of them, 22–35 KB.** Real FRDs carry tables and numbering
  that the conversion flattens; these carry one table each.
- **Arm A is generous.** Its retrieval is padded to ten chunks even when lexical search
  finds fewer, and its document title is given as the project name.
- **Two model-written strings were reworded after the run.** In
  `baseline-deepseek-flash-A.json`, one extracted requirement and one question used wording
  the repository's private-vocabulary check refuses; each was rewritten to say the same thing
  in the document's own words. Scores were computed before the edit and are unchanged.

## Spend

| Run | Model | Readers | Judge | Total |
|---|---|---|---|---|
| `baseline-sonnet-5-5` (A, B, C × 3 documents) | claude-sonnet-5-5 | $3.0739 | $0.6418 | **$3.7157** |
| `baseline-deepseek-flash-A` | deepseek-flash | $0.0679 | $0.0719 | $0.1398 |
| `baseline-deepseek-flash-BC-cap21333` | deepseek-flash | $0.2738 | $0.0166 | $0.2904 |
| `deepseek-flash-BC-cap16384-failures` | deepseek-flash | $0.2307 | $0.0000 | $0.2307 |
| **Metered total** | | | | **$4.3766** |

Not in the readings: a first smoke run on DeepSeek before the harness was committed, stopped
by its time limit during arm C (A and B logged $0.0806 with their judges; C's partial spend
was not metered), and one direct probe call that confirmed the empty-reply cause (one
16,384-token reply, about $0.02 at the failed readings' rate). At most about $0.25 more.

## Reproducing it

```bash
pnpm --filter server eval:doc-understanding --corpus docunderstanding-01-clinic-booking   # one document, arms A,B,C
pnpm --filter server eval:doc-understanding --arms A,B --runs 3 --budget 5
pnpm --filter server eval:doc-understanding --combine a.json,b.json,c.json --reading <name>   # no model call
pnpm --filter server eval:doc-understanding:build    # after editing a document's frd.src.md
```

A Sonnet reading of one document takes 4–9 minutes; DeepSeek is slower (B took 2–4 minutes
per call), so run it a document or an arm at a time and `--combine` the reports. Set
`ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS=21333` for DeepSeek's B and C (finding 6).
