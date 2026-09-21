# Authoring reference answers (`reference.json`)

Issue #1319, epic #1316. Scope: **all 43 questions** in this directory's
`queries.json` — not the 168 of `docretrieval-02-metis-docs-wide`.

## Why a human has to write these

Every other metric in METIS is **reference-free**: it asks "is this answer
supported by what we retrieved?" and never "is this answer right?". An answer
that is confidently wrong but cites real retrieved text scores clean on
faithfulness. A gold answer is what closes that gap.

**A model must not write one.** If the gold answer comes from a model, the
answer-correctness metric compares a model to a model and measures the judge
against itself. The number it produces looks perfectly healthy in every
circumstance, including the ones where the system is broken, and nothing
downstream would ever reveal it. That is worse than having no metric — a number
gets quoted in a decision; an absence does not.

The validator enforces this as far as a validator can: it rejects an author or
reviewer whose name matches a model (`claude`, `gpt`, `generated`, …) and it
rejects a review by the author. Neither check can tell where prose actually came
from. **That part is on you.**

## How to write one

1. **Pick a query.** Every entry's `queryId` must match a `queries[].id` in
   `queries.json` in this directory. Answer the questions you can answer well; a
   partial corpus of good gold answers is worth more than a complete one of
   guesses.
2. **Read the source document, not the model's output.** The query's `doc` field
   names the file under `docs/` in this directory, and its `quote` field is the
   verbatim span the question was written against. Start there.
3. **Do not read METIS's answer first.** Reading it before writing anchors you to
   it, and an anchored reference scores the system against its own phrasing. If
   you have already seen it, ask someone else to author that one.
4. **Write 1–3 sentences of self-contained prose**, stating the fact and not its
   location. "Up to five minutes", **not** "see the RPO row in `OPERATIONS.md`".
   Put anything deliberately out of scope in `note`, not in `answer`.
   **Being terse does not cost METIS marks** — see "Terseness and the score"
   below.
5. **Use your own words.** The metric is semantic — a correct paraphrase scores
   as correct — so copying the source span verbatim buys nothing and makes the
   answer harder to review.
6. **Get it reviewed by someone else** where you can, and record them in
   `provenance.reviewedBy` / `reviewedAt`. Review is optional in the schema so
   work in progress can be committed; it is not optional in spirit.

### Terseness and the score (#1342)

Write the shortest answer that fully answers the question. It will look as though
that hurts, and for one of the reported numbers it does — deliberately.

The metric decomposes both answers into claims and compares them in both
directions:

- **recall** — how much of *your* gold answer METIS's answer entailed. This is
  the "**is METIS right?**" number, and it is the headline.
- **precision** — how much of *METIS's* answer your gold answer entailed. METIS
  returns a paragraph; a 1–3 sentence reference is shorter by construction, so
  precision falls whenever METIS says more than you did — **including when the
  extra claims are perfectly true**.

On the first real run all four gold answers scored **recall 1.000** while
precision averaged 0.433. That is not METIS being 43% right; it is METIS being
longer than the reference. So the blended `meanF1` is **not** the headline, is
named `f1` rather than `correctness`, and every envelope carries an
`interpretation` line quoting the measured claim gap. The reasoning is
`docs/decisions/0013-answer-correctness-reports-precision-and-recall.md`.

What this means for you at the keyboard:

- **Do not pad an answer to raise precision.** A gold answer inflated to match
  METIS's length is no longer ground truth, and it makes recall a weaker test.
- **Do not omit a fact to keep it short.** Anything you leave out is something
  recall can no longer catch METIS getting wrong. If the honest answer needs
  three sentences, use three.
- **Put scope limits in `note`, never in `answer`.** `note` is not scored.

### If the question cannot be answered from its span — flag it

Some queries will turn out to be anchored to a `quote` that does not actually
answer the question. That is a defect in `queries.json`, not a hard question.
Say so instead of guessing:

```json
{
  "queryId": "dq-sec-04",
  "answer": "FLAG: the anchored quote describes session cookie flags, but the question asks about token rotation, which this snapshot does not state anywhere.",
  "provenance": { "author": "gh:some-person", "date": "2026-08-27" }
}
```

A `FLAG:` item is **excluded from the metric** and reported separately as a
corpus finding in the `eval-results/` envelope. Scoring it would blame the system
for the corpus. The prose style rules above do not apply to a flag — say as much
as you need to.

## The format

```jsonc
{
  "corpusId": "docretrieval-01-metis-docs",
  "license": "CC0-1.0",                 // see "Licence" below
  "licenseNote": "…",
  "snapshotCommit": "953bfe7034cd7a4f7e3c5ca82b03642a0cdebcf7",
  "answers": [
    {
      "queryId": "dq-ops-01",
      "answer": "The metrics route is disabled and returns 404 unless METRICS_TOKEN is set, because it fails closed.",
      "note": "Deliberately does not cover the Grafana dashboard — out of scope for the question.",
      "provenance": {
        "author": "gh:some-person",
        "date": "2026-08-27",
        "reviewedBy": "gh:another-person",   // optional; may NOT be the author
        "reviewedAt": "2026-08-28"           // optional; may not precede `date`
      }
    }
  ]
}
```

- `snapshotCommit` must match `queries.json` in this directory. If the snapshot
  moves, the answers must be **re-reviewed**, not silently re-stamped: an answer
  written against text that no longer exists is not ground truth.
- `reviewedBy` and `reviewedAt` are all-or-nothing — half a review is a field
  somebody meant to finish, so the validator rejects it.
- A machine-readable format example lives at
  `server/src/lib/eval/answer-correctness/__fixtures__/reference.format-example.json`.
  It is **not ground truth** and must never be copied into `eval-data/`.

### What the validator enforces, and what it cannot

| Rule | Enforced? |
|---|---|
| `queryId` exists in `queries.json`, no duplicates | yes |
| `snapshotCommit` matches the corpus | yes |
| author present, not model-shaped; `date` is ISO | yes |
| reviewer, if recorded, is a different person and not model-shaped | yes |
| 1–3 sentences (see "Terseness and the score") | yes |
| no bullets, numbered lists, tables, headings or code fences | yes |
| no citation markup (`[^1]`, `[1]`, `[text](url)`, `<sup>`) | yes |
| does not *open* by pointing at a location ("See OPERATIONS.md…") | yes |
| the prose was actually written by a person | **no — on you** |
| the answer is *correct* | **no — that is what review is for** |

## Licence

`license` is **`CC0-1.0`**, settled by #1382.

It was the sentinel `PENDING` while the question was open, and the question was
real: the synthetic `brd-*`/`prd-*` corpora are CC0-1.0 in
`eval-data/manifest.json` because they were invented for this repository, and
this corpus is not — its ten source documents are METIS's own `OPERATIONS.md`,
`SECURITY.md`, `data-model.md` and seven others, with the reference answers
derived from them. That made it the repository owner's own authored content, so
the licence was theirs to set; #1300 forced the issue by making this file part
of the published tree, and an unlicensed file cannot ship. CC0-1.0 matches the
other two `reference.json` files and the rest of the corpus. This closes **E4 in
#1322**.

This corpus still has **no entry in `eval-data/manifest.json`** — none of the
`docretrieval-*` corpora do — so #1319's "licensed consistently with
`manifest.json`" has nothing to compare against; `reference.json` carries its
own `license` field, which is the record.

`LICENSE_PENDING` is still a valid value in the loader, for a corpus whose
licence is genuinely undecided. Do not use it to defer a decision that is yours
to make.

## Validating

```bash
pnpm eval:answer-correctness                  # validate + report, writes eval-results/
pnpm eval:answer-correctness --validate-only  # just check reference.json
```

Validation reports **every** problem at once, so one pass fixes the file. A
missing `reference.json`, one with an empty `answers` array, and one containing
only `FLAG:` items are all legitimate states: the metric is reported as **not
reported** with a reason, never as a score of zero.

## Getting a real number out of it

Once your answers are in, both sides of the metric run (#1338). The generated
side needs the production embedder and the judge needs a provider, so a scoring
run is:

```bash
AI_PROVIDER=anthropic ANTHROPIC_API_KEY=… EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 \
  pnpm eval:answer-correctness
```

Never add `EMBED_ALLOW_HASH_FALLBACK=1` to get past the embedder gate — the hash
embedder is chance-level, and an answer written from chance-level retrieval would
be scored as though METIS had simply answered badly.

Without those, the run still exits 0 and still validates your file; it just says
which piece is missing. Every "no number" outcome carries a `reasonCode` so you
can tell them apart at a glance:

| `reasonCode` | What to do |
|---|---|
| `no-reference-file` | This corpus has no `reference.json` at all. |
| `no-gold-answers` | The file is valid but every item is empty or `FLAG:`. Write some answers. |
| `no-generated-answers` | Gold exists, but METIS answered nothing — enable the embedder as above. |
| `no-judge` | Both sides exist, but no provider was configured to judge them. |

In every one of those cases each per-query score is `null` with an
`unverifiableReason`, **never `0`**. A zero means METIS answered and was wrong.

A run that *did* score prints its headline as recall and precision, with the
blend labelled, and repeats the envelope's computed caveat:

```
answer_correctness — corpus=docretrieval-01-metis-docs references=4 recall=1.000
  precision=0.433 f1(length-sensitive)=0.531 scored=4 unverifiable=0
Recall 1.000 — the share of the human gold answer's claims METIS entailed; …
```

Read `recall` first. `f1` is there for continuity with the earlier runs and is
length-sensitive; it is not a percentage correct.
