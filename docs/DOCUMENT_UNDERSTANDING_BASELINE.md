# Document understanding: the Phase 0 baseline (#2229) and the reader's measurement (#2255)

- **Issues:** #2229, Phase 0 of epic #2227 ("METIS understands the documents it is given");
  #2255, the document reader measured on four documents
- **Measured:** 2026-11-10, at commit `8a0601902` (#2229); 2026-11-12, at commit `658a61dc2`
  (#2255); on `claude-sonnet-5-5` (production) and `deepseek-flash` (iteration). Each
  commit a reading records is on its pull request's branch, which was squash-merged:
  `8a0601902` landed on `main` as `1c93df96e` (#2247), `658a61dc2` as `afde69a5f` (#2362),
  `362294ae3` as `b6c1799b3` (#2415) and `2d78fb104` as `815b914ee` (#2444).
- **Readings:** `eval-data/readings/doc-understanding/`; #2407 re-measured arm R on 2026-11-12 at commit `362294ae3` (`reader-sonnet-5-5-2407`); #2374 measured arms R and B on 2026-11-13 at commit `2d78fb104` (`reader-sonnet-5-5-2374`, `reader-sonnet-5-5-2374-B-cap21333`)
- **Harness:** `pnpm --filter server eval:doc-understanding` (`server/src/lib/eval/doc-understanding/`)

## The reader, measured (#2255)

**`ANALYSIS_DOCUMENT_READER` stays off.** The document reader (arm R) finds every labelled
requirement on all four documents, on both models, including the 60 KB one that the
whole-document read (arm B) cannot answer in one reply. But it does not hold B's precision.
On Sonnet it scores 0.59 to 0.69, where B scores 1.00 on the three documents it can read.
An analyst would read about one statement in three either twice or when it is not a
requirement. Most of the loss is repeats that the reader's cross-section pass keeps.

**The rule.** R holds B on a document when R's requirement recall and precision are each no
more than 0.05 below B's, on every document where B produced a scored reading on that model.
0.05 is about one run's noise: B's recall on document 01 was 0.91 on Sonnet and 0.96 on
DeepSeek. R holds recall everywhere and misses precision by 0.34 to 0.41 everywhere, so the
result does not depend on the tolerance.

| Model, document | B recall | B precision | R recall | R precision | Held? |
|---|---|---|---|---|---|
| Sonnet, 01 clinic booking | 0.91 | 1.00 | 1.00 | 0.62 | no |
| Sonnet, 02 freight claims | 1.00 | 1.00 | 1.00 | 0.59 | no |
| Sonnet, 03 community grants | 1.00 (cap 21,333) | 1.00 | 1.00 | 0.63 | no |
| Sonnet, 04 library lending | failed | | 1.00 | 0.69 | no B to compare |
| DeepSeek, 01 clinic booking | 0.96 | 0.96 | 0.98 | 0.62 | no |
| DeepSeek, 02 to 04 | failed | | 1.00 | 0.54, 0.52, 0.55 | no B to compare |

### Results per document

Ambiguity recall and question precision are B's only. The reader asks no questions (that is
Phase 2 of the epic), so its ambiguity recall reads 0. Cost is the reader's own; the judge's
is under "Spend". A failed reading's cost is counted.

**Sonnet 5.5** (`reader-sonnet-5-5`, output cap 16,384 for both arms;
`reader-sonnet-5-5-B-cap21333`, B alone at 21,333 on documents 03 and 04)

| Document | Arm | Recall | Precision | Ambiguity recall | Question precision | Extracted | Repeats | Not labelled | $ |
|---|---|---|---|---|---|---|---|---|---|
| 01 (22 KB) | B | 0.91 | 1.00 | 0.83 (10/12) | 1.00 | 51 | 0 | 0 | $0.1037 |
| 01 | R | 1.00 | 0.62 | n/a | n/a | 90 | 16 | 18 | $0.2688 |
| 02 (23 KB) | B | 1.00 | 1.00 | 0.50 (9/18) | 0.93 | 60 | 0 | 0 | $0.1325 |
| 02 | R | 1.00 | 0.59 | n/a | n/a | 102 | 31 | 11 | $0.2890 |
| 03 (35 KB) | B, cap 16,384 | failed | | | | | | | $0.3721 |
| 03 | B, cap 21,333 | 1.00 | 1.00 | 0.59 (10/17) | 0.83 | 106 | 0 | 0 | $0.2287 |
| 03 | R | 1.00 | 0.63 | n/a | n/a | 169 | 53 | 10 | $0.4261 |
| 04 (61 KB) | B, cap 16,384 | failed | | | | | | | $0.4031 |
| 04 | B, cap 21,333 | failed | | | | | | | $0.5021 |
| 04 | R | 1.00 | 0.69 | n/a | n/a | 313 | 71 | 26 | $1.0159 |

**DeepSeek** (`reader-deepseek-flash-cap21333`, `ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS=21333`
for both arms)

| Document | Arm | Recall | Precision | Ambiguity recall | Question precision | Extracted | Repeats | Not labelled | $ |
|---|---|---|---|---|---|---|---|---|---|
| 01 | B | 0.96 | 0.96 | 0.83 (10/12) | 1.00 | 56 | 0 | 2 | $0.0503 |
| 01 | R | 0.98 | 0.62 | n/a | n/a | 89 | 24 | 10 | $0.0968 |
| 02 | B | failed | | | | | | | $0.0514 |
| 02 | R | 1.00 | 0.54 | n/a | n/a | 112 | 41 | 11 | $0.0930 |
| 03 | B | failed | | | | | | | $0.0515 |
| 03 | R | 1.00 | 0.52 | n/a | n/a | 204 | 66 | 32 | $0.1427 |
| 04 | B | failed | | | | | | | $0.0553 |
| 04 | R | 1.00 | 0.55 | n/a | n/a | 392 | 136 | 40 | $0.1966 |

"Repeats" are extracted statements of a labelled requirement that another statement had
already claimed. "Not labelled" are statements the judge matched to no label. Both count
against precision. Section coverage was 1.00 for R on every document, and every R quote was
found verbatim in the document (quote accuracy 1.00).

### Output-token caps

| Reading | Model | B's cap | R's cap | R's mode |
|---|---|---|---|---|
| `reader-sonnet-5-5` | claude-sonnet-5-5 | 16,384 (production default) | 16,384 | whole on all four documents (4, 5, 6 and 11 calls) |
| `reader-sonnet-5-5-B-cap21333` | claude-sonnet-5-5 | 21,333 | not run | |
| `reader-deepseek-flash-cap21333` | deepseek-flash | 21,333 | 21,333 | sectioned on all four documents (7 to 12 calls) |

On DeepSeek the reader chose sectioned mode for every document, the 22 KB one included: the
window METIS resolves for `deepseek-flash` has no room for the document plus a 21,333-token
reply. Its cross-section pass failed on documents 02 and 04, so every statement was kept.

### Findings

1. **The reader removes B's output limit.** B has to write every requirement in one reply.
   On Sonnet at production's 16,384 it failed on documents 03 and 04, with thinking taking
   part of the same budget (the #2229 run of 03 had needed a re-prompt). At 21,333 it read 03
   and still failed on 04. On DeepSeek it failed on 02, 03 and 04. The reader read all four
   on both models with recall 1.00 (0.98 on DeepSeek's 01), section coverage 1.00 and every
   quote verbatim.
2. **It repeats itself, and that is most of the precision it loses.** On Sonnet, 16, 31, 53
   and 71 of R's statements restate a requirement another statement had already stated.
   Without the repeats its precision would be 0.76, 0.85, 0.91 and 0.89. The cross-section
   pass is meant to drop them and drops few; on DeepSeek it failed outright on two documents.
3. **The rest is statements the labels do not count**, 10 to 26 per document on Sonnet:
   scope lines ("The first release includes patient sign-in"), background read as a
   constraint ("The PMS remains the system of record for appointments"), and the review
   instructions in a document control section. The reader labels these requirement,
   constraint or business rule; B leaves them out.
4. **It costs about twice what B costs where B succeeds** (Sonnet: $0.27 against $0.10 on
   01, $0.43 against $0.23 on 03), and $1.02 on the 60 KB document, where each of its 11
   calls carries the whole document (260,442 input tokens).
5. **The labels moved with the review.** B's precision is 1.00 on every Sonnet document it
   read, against 0.93 in #2229, on labels that gained 18 requirements in the review. The two
   readings are not directly comparable.

### What has to change before the flag goes on (#2361)

- The reader's repeats. Make the cross-section pass drop them, or stop a batch from writing a
  statement a neighbouring batch already wrote.
- Then measure R against B again, under the rule above. #2262 (PR #2288) changes the reader
  (prompt caching, batch-scoped quotes, a size bound on whole mode, operator notes) and has
  not merged; this measurement is of the reader on `main` before it.
- #2262's chunk-ACL fix must be on `main` first: on `main` today the reader does not apply a
  document's ACL. #2321's existence oracle has to be decided with it. With no selection, a
  project whose every upload is restricted gives an empty report, while one with no uploads
  falls back to retrieval. That code comes from #2300, which has not merged either.

### Recall after the corrected-reply fix (#2407)

Re-measuring #2361 (PR #2371) found the reader's recall below its floor on 01, 03 and 04, and
most of the loss was a reply parser defect, not the reader. A model would write a short
statements object, then "Correction: the object above is incomplete. Here is the full
response." and a second, full object. `extractJsonObject` kept the first, so a batch's sections
came back with one statement between them and every one of them still read "read". #2407 makes
such a reply ambiguous, so it is re-prompted. It also asks once more for any section with text
that a reply says nothing of, and reports a section still left out as unread.

Reading `reader-sonnet-5-5-2407` (arm R, claude-sonnet-5-5, output cap 16,384, two runs per
document, commit `362294ae3`):

| Document | Floor | Recall at #2371's head | **Recall now** (run 1 / run 2) | Precision now | Misses now |
|---|---|---|---|---|---|
| 01 clinic booking | 0.98 | 0.95 | **0.97** (0.964 / 0.982) | 0.92 (0.90 / 0.93) | R47 both runs, R51 run 1 |
| 02 freight claims | 1.00 | 1.00 | **1.00** (1.000 / 1.000) | 0.88 (0.87 / 0.90) | none |
| 03 community grants | 0.99 | 0.98 | **0.99** (0.981 / 0.991) | 0.95 (0.95 / 0.95) | R103 both runs, R105 run 1 |
| 04 library lending | 1.00 | 0.92 | **1.00** (1.000 / 0.995) | 0.93 (0.92 / 0.94) | R37 run 2 |

Exact means: 0.973, 1.000, 0.986, 0.998. **The floor is met on 02, and on 03 and 04 at two
decimals; 01 is 0.01 short.** No section of any run was unread, and no run lost a batch: 04,
which lost seven sections (R14–R49) in #2371's run 1, read every requirement in run 1 and all
but R37 in run 2.

The misses that are left are not this defect. R47 ("Urgent and same-day appointments remain
telephone-only in the first release…") stands in 01's out-of-scope section, which the reader's
prompt says to read as background since #2361. R103 is #2371's original miss on 03, and R105
the statement its cross-section pass dropped as a repeat of R43. Both belong to #2374's
precision and labelling follow-up.

Four statements replies were re-prompted as unreadable (one on 01, three on 04, at 2,750 to
14,469 characters) and every one was then read. The log keeps a reply's length and hash, not
its body, so which of them were corrected replies is not known. Every run's call count is its
batches (3, 4, 5 and 9), the merge and those re-prompts, so no section was asked for again.

### Precision on 01 and 02, and batches that overran (#2374)

After #2407, R's precision was 0.92 on 01 and 0.88 on 02, against B's 1.00. **#2255's rule now
holds on all three documents B reads, under a key that gained six requirements.** Under the
old key it would still fail on 01 and 02. `ANALYSIS_DOCUMENT_READER` stays off: #2321 is still
open, and a person has not yet confirmed the six labels.

**Each false requirement on 01 and 02 was decided on its own.** There were 13 different ones
across #2361's and #2407's four runs of each document. A **label gap** is a sentence that
states a rule or obligation no labelled sentence states. **Over-extraction** is background
(scope, a lead-in to the requirements after it, a reason, the situation as it is) or something a
labelled sentence already says in full.

| Doc | Sentence | Runs (of 4) | Decision |
|---|---|---|---|
| 01 | 5.2 "This limit does not apply to nurse reviews, immunisations or physiotherapy…" | 3 | label gap, **R57**: the exception is a rule a tester checks |
| 01 | 6, the table row "Upcoming appointment, text message, 24 hours before" | 4 | label gap, **R58**: one side of A4's conflict, before only marked as A4's span |
| 01 | 9.3 "Deleting a portal account does not affect the patient's record in the PMS." | 4 | label gap, **R59** |
| 01 | 2.1 "Each site may choose which of its appointment types are offered online." | 2 | over-extraction: a scope line; R33 sets it out in full |
| 01 | 2.2 "The portal will not offer a symptom checker…" | 1 | over-extraction: scope |
| 01 | 5.2 "Short-notice slots are kept for the telephone triage team." | 1 | over-extraction: R15's reason |
| 02 | 7.1 "Northgate is liable for loss and damage that occurs while goods are in its care, subject to the exceptions…" | 4 | label gap, **R61**: the rule R16's decision applies |
| 02 | 8.1 "Approvers are expected to deal with approvals promptly…" | 4 | label gap, **R62**: before only marked as A4's span. 01's vague requirements (R53) are labelled and named by their ambiguity, and this matches that. |
| 02 | 15, the summary row "Notice of damage or shortage: within 14 days of delivery" | 4 | label gap, **R63**: one side of A1's conflict |
| 02 | 8.1 "Payments are approved by people with the authority to commit the amount." | 4 | over-extraction: a lead-in to the matrix (R27 to R30) |
| 02 | 11 "The application must provide it directly." | 4 | over-extraction: a lead-in to R47 to R50 |
| 02 | 13 "They need to be moved into the application at go-live…" | 2 | over-extraction: a lead-in to R54 |
| 02 | 5.2 "Special terms may set different periods…" | 3 | over-extraction: R6 already reads the claimant's own terms |
| 02 | 9.1 "Subcontract agreements allow Northgate to recover from a haulier…" | 1 | over-extraction: the contract position R37 and R38 set out. This one is a close call: it resembles 7.1, but its content is in the requirements after it. |

The six additions are recorded in every `labels.json`'s `labelStatus` as added by an AI and
not yet confirmed by a person. A reviewer who disagrees removes the `[[R…]]` marker in
`frd.src.md` and rebuilds. R58 on 01 and R62 and R63 on 02 replaced an ambiguity's marker, so
for those three the reviewer also restores the `[[A…]]` marker it replaced (01's A4 on R58,
02's A4 on R62 and A1 on R63) and removes the id from that ambiguity's `@R` list
(`A4 [conflict] @R24,R58`, `A4 [vague-term] @R31,R62`, `A1 [conflict] @R7,R63`). Now 01 has
59 requirements and 02 has 63.

**What changed in the reader:**

- **The prompt** reads two kinds of sentence as background. One introduces the statements,
  list or table after it, including one that says must. The other gives the reason for another
  statement.
- **The cross-section pass** now drops a summary table's rows that each restate part of one
  prose sentence. A diagnostic read of 02 showed that the pass named 15's "documents reminder"
  and "closed as abandoned" rows as repeats of 6.1's one sentence holding both. #2361's summary
  guard then kept both rows, because several statements were named repeats of that sentence.
  A row is dropped this way only when the sentence says at least three quarters of the row's
  content words, so a prose overview over a detailed table keeps the table's rows.
- **Each whole-mode batch call** is told the section after its batch, and to stop before it.

Reading `reader-sonnet-5-5-2374` (arms R and B, output cap 16,384) and
`reader-sonnet-5-5-2374-B-cap21333` (B on 03 at 21,333, as #2255 read it). Both are on
claude-sonnet-5-5, two runs per document, at commit `2d78fb104`. Each run was its own
invocation, combined with `--combine`, so the reading says "Runs requested: 1" and labels every
record run 1.

| Document | B recall / precision | R recall / precision | Gap (R − B) | Held? | R precision under the old key | R precision at #2407 |
|---|---|---|---|---|---|---|
| 01 clinic booking | 0.86 / 0.99 | 0.97 / 0.97 | +0.11 / −0.02 | yes | 0.92 | 0.92 |
| 02 freight claims | 0.94 / 1.00 | 1.00 / 0.97 | +0.06 / −0.03 | yes | 0.92 | 0.88 |
| 03 community grants | 0.96 / 1.00 (cap 21,333) | 0.99 / 0.96 | +0.02 / −0.04 | yes | (key unchanged) | 0.95 |
| 04 library lending | not read | 0.99 / 0.92 | | no B to compare | (key unchanged) | 0.93 |

"Under the old key" scores the same runs without the six new labels, treating a statement matched
to one of them as unmatched. B found none of the six in any run. Under the old key, B's recall is
0.91 on 01 and 0.98 on 02.

**Read the result with that in mind.** Over the four runs of 01 and 02, the prompt and the
cross-section pass took R's precision from 0.92 to 0.92 on 01 and from 0.88 to 0.92 on 02. That
is about half of 02's gap and none of 01's. The rest of the closing is the six labels. On 01 the
statements left over are the two scope lines (2.1 and 2.2), in both runs. On 02 they are 11's
lead-in in both runs and 8.1's lead-in in one.

**The overrun on 04 is gone.** At #2361 and #2407, three of four runs dropped 20 statements
quoted from outside their batch (`droppedUnverified`). All three runs of 04 at this PR's prompt
dropped none: one at `409755758` and two at `2d78fb104`. Output was 40,923, 49,751 and 41,498
tokens per run, against 53,051, 41,857, 47,240 and 48,110. At the final commit the cost per
run was $0.72 and $0.48, a mean of $0.60 against #2407's $0.64. The first of those runs made 12
calls, two of them re-asks or re-prompts (#2407), which is why it cost more.

Misses at the final commit:

- 01: R51 (twice) and R54 (once).
- 03: R105 (twice) and R103 (once).
- 04: R37 and R216, in one run.

R47 on 01 was found in both runs, though #2407 missed it in both.

Spend: $4.38 metered at the final commit ($3.80 for R and B, $0.58 for B on 03), plus $1.52 for
the first measurement of the prompt change. The diagnostic read of 02 was unmetered and cost
about $0.23, priced from its logged usage at `provider-rates.ts`'s Sonnet 5.5 rates. The total is
about $6.13, within the $20 pre-approval.

## The Phase 0 answer (#2229)

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

**A fourth document was added for #2255.** `docunderstanding-04-library-lending` is a 31 KB
Word FRD (60,624 characters converted, 81 sections, 216 requirements in 45 sections, 30
ambiguities). Many of its requirements are written in the second person or as plain
statements rather than "shall". The #2229 readings cover documents 01 to 03 only. See
`eval-data/README.md`.

**The counts above are the labels #2229 was scored against.** The labels were written by the
document's author. For #2255, two AI reviewers labelled each document blind, an AI judge
recommended an answer for each disagreement, and a person confirmed every one. That added 18
requirements and 12 ambiguities across the four documents, and re-kinded five ambiguities
from contradiction to gap. 01 now has 56 requirements and 12 ambiguities, 02 has 60 and 18,
and 03 has 106 and 17 (#2374 added three to each of 01 and 02, see above). It was not a second human labelling, and the #2229 readings were not
re-scored. The Miniflux sample the issue suggested as a starting point is not in the
repository, and the existing `eval-data/corpus/brd-*` items are about 500 bytes each, so the
corpus was written from scratch.

### The arms

| Arm | What it is |
|---|---|
| **A** (today) | The document chunked by production's chunker and retrieved the way `retrieveContext` serves the document specialist (`buildRetrievalQueries` + `runGroundedRetrieval`, k = `ANALYSIS_RETRIEVE_K` = 10), then production's `runAgent("document")`, then what `runEnhancementPipeline` makes of its output: `RequirementsExtractor` over the agent's requirement texts. Its requirements are the structured requirements the analyst approves; its questions are their ambiguities' suggested questions (the UI's clarification toggle is on by default). |
| **B** | The whole converted document in one call: every requirement and every question, each with a verbatim quote. |
| **C** | One call over the whole document for a summary, glossary and actors; one call per section (production's `splitSections`, the governing rule reader's) with that context; one reduce call that drops repeated requirements, settles the questions and adds cross-section conflicts. |
| **R** (#2230, measured in #2255) | Production's document reader, `readDocument`: the whole document in every call (or sectioned when it does not fit the model's window), its statements written a batch of sections at a time, each quote verified, then a cross-section pass. Its requirements are the statements it labels requirement, constraint or business rule. It asks no questions. |

Retrieval in arm A is lexical (production's BM25 options), padded to k with unmatched
chunks in document order, so A always reads ten chunks as production's hybrid search
would. That leans toward A in how much it reads: it cannot read fewer chunks than
production does. It does not lean toward A in which chunks it reads: BM25 alone ranks them,
not production's hybrid of BM25 and vectors, so A may read different chunks from the ones
production would read.

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
  Sonnet, on every document) is the gain the epic's definition of done asks for before a
  flag defaults on. On DeepSeek the gain is +0.70, but **B and C there are partial**: B read
  two of the three documents (it failed on 03) and C read none (it ran on 01 only, and its
  reduce failed), so the +0.70 compares A over three documents with B over two.
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

- **The #2229 labels had one author**, who also wrote the documents. Precision there is a
  floor: an extracted requirement the labels missed counts as a false positive. The #2255
  review (above) added 18 requirements; the #2229 readings were not re-scored against them.
- **One run per document and arm.** Arm A's recall was within 0.03 across the two models on
  every document, which suggests the gap is not noise, but no repeat run was made on one
  model.
- **The judge is the arms' own model.** A self-preference bias would favour B and C (model
  output) over A (also model output, but paraphrased twice); the judge never sees which arm
  it is grading. The deterministic quote check agrees with it that B and C quote real text.
- **Synthetic documents, three of them, 22–35 KB.** Real FRDs carry tables and numbering
  that the conversion flattens; these carry one table each.
- **Arm A is generous in how much it reads, not in which chunks.** Its retrieval is padded
  to ten chunks even when lexical search finds fewer, and its document title is given as the
  project name. Its chunks are ranked by BM25 alone, not by production's hybrid search, so
  which ten it reads can differ from production's.
- **B and C's prompt leaned toward the key until #2250.** Their extraction prompt listed
  what the labels count as a requirement and not, and the six kinds the labelled ambiguities
  are sorted into. That is the labelling convention of the documents' author, who wrote the
  labels. #2250 replaced it with a plain analyst's instruction. Every reading above was made
  with the old prompt, so a re-measure of B or C after #2250 is not directly comparable with
  them. Arm R (`readDocument`) has its own prompt and was not changed.
- **Readings record their output cap since #2250** (`outputTokenCap` in the JSON). The
  readings above name their cap in the file name or the tables instead. `--combine` refuses
  to pool readings made at different caps, and refuses any reading that records no cap, so
  none of the readings above can be pooled with another. Two of them show why:
  `reader-sonnet-5-5-2374` (16,384) and `reader-sonnet-5-5-2374-B-cap21333` (21,333) share a
  model and a commit, and both record no cap. Each is already a finished reading, so nothing
  documented here combines two of them. To pool one with new work, re-run it.
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
| **#2229 metered total** | | | | **$4.3766** |
| `reader-sonnet-5-5` (B, R × 4 documents, cap 16,384) (#2255) | claude-sonnet-5-5 | $3.0111 | $0.4344 | **$3.4455** |
| `reader-sonnet-5-5-B-cap21333` (B × documents 03, 04) (#2255) | claude-sonnet-5-5 | $0.7308 | $0.0688 | **$0.7996** |
| `reader-deepseek-flash-cap21333` (B, R × 4 documents) (#2255) | deepseek-flash | $0.7376 | $0.0905 | **$0.8281** |
| **#2255 metered total** | | | | **$5.0732** (Sonnet $4.2451, DeepSeek $0.8281) |
| `reader-sonnet-5-5-2407` (R × 4 documents × 2 runs) (#2407) | claude-sonnet-5-5 | $2.7935 | $0.5721 | **$3.3656** |

Not in the readings: a first smoke run on DeepSeek before the harness was committed, stopped
by its time limit during arm C (A and B logged $0.0806 with their judges; C's partial spend
was not metered), and one direct probe call that confirmed the empty-reply cause (one
16,384-token reply, about $0.02 at the failed readings' rate). At most about $0.25 more.

## Reproducing it

```bash
pnpm --filter server eval:doc-understanding --corpus docunderstanding-01-clinic-booking   # one document, arms A,B,C
pnpm --filter server eval:doc-understanding --arms A,B --runs 3 --budget 5
pnpm --filter server eval:doc-understanding --arms B,R --corpus docunderstanding-04-library-lending --budget 8   # #2255, one document per process
pnpm --filter server eval:doc-understanding --combine a.json,b.json,c.json --reading <name>   # no model call
pnpm --filter server eval:doc-understanding:build    # after editing a document's frd.src.md
```

A Sonnet reading of one document takes 4–9 minutes; DeepSeek is slower (B took 2–4 minutes
per call), so run it a document or an arm at a time and `--combine` the reports. Set
`ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS=21333` for DeepSeek's B and C (finding 6).
