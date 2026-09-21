# Domain Eval Golden Corpus

Curated, **license-clean** golden corpus for the BA-pipeline regression suite
(Epic 09 / #803). Every document here is **original synthetic content** authored
specifically for METIS and released under [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/),
so there are no third-party licensing concerns.

## Layout

```
eval-data/
  manifest.json            # per-item metadata (id, title, docType, source, license)
  build-fixtures.mjs       # one-shot authoring script (reproducibility only)
  corpus/
    <item-id>/
      source.md            # the input requirements document
      expected.json        # golden requirements (the labels)
      queries.json         # doc-retrieval: span-anchored questions (ground-truth CONTEXTS)
      reference.json       # #1319: human-authored gold ANSWERS (ground-truth ANSWERS)
      REFERENCE-AUTHORING.md
      snapshot-manifest.json  # source path + sha256 of every snapshot file
      docs/                # UNTRACKED (#1382) — rebuilt, see below
```

Not every corpus carries every file. The synthetic `brd-*`/`prd-*` items carry
`source.md` + `expected.json`; the `docretrieval-*` items carry `queries.json`
over a frozen `docs/` snapshot, and `docretrieval-01-metis-docs` additionally
carries `reference.json`.

### `docs/` is committed — and gitignored

`eval-data/corpus/*/docs/` holds 38 copies of this repository's own `docs/*.md` as they
stood at each corpus's `snapshotCommit`. They are force-added: the ignore rule stays so
nothing new lands there by accident, and the committed files are the source of truth.
A few were edited before publication and so match no blob at any commit; their manifest
entries carry `sourceSha256` and are listed under `redaction`. Those cannot be rebuilt
from history — recover them with `git checkout`.

Seven internal documents, and the 35 queries anchored in them, were removed from both
corpora before publication (`docretrieval-01`: 48 → 43 queries; `docretrieval-02`: 198 → 168).
Committed results that cite 48 or 198 were measured before that and will not reproduce exactly.

```bash
pnpm eval:restore-corpus          # rebuild anything missing; no-op when complete
pnpm eval:restore-corpus --resync # also overwrite a snapshot that has DRIFTED
```

The rebuild is exact, not approximate: `snapshot-manifest.json` records each
file's `source` and its sha256 at `snapshotCommit`, so the script reads the bytes
back with `git show` and verifies the hash before writing. The root `pnpm test`
runs it first, because `server/src/lib/eval/doc-retrieval/` reads the directory
directly. Everything else under `eval-data/` **is** tracked — the questions, the
gold answers, the authoring guides, the manifests and both generator scripts are
hand-authored and not regenerable. See
[ADR 0015](../docs/decisions/0015-untrack-eval-output-and-move-the-nightly-to-a-branch.md).

Each `expected.json` is an array of golden requirements:

```jsonc
[
  {
    "id": "R1",
    "type": "feature",        // feature | bug | chore | epic | task
    "title": "Email and password sign-in",
    "description": "Registered customers sign in with an email address and password.",
    "priority": "high"        // low | medium | high | critical
  }
]
```

## Adding a corpus item

The corpus is **auto-discovered** — drop a new folder under `corpus/<id>/` with a
`source.md` (or `.txt`/`.markdown`) and an `expected.json`, add a matching entry
to `manifest.json`, and the next `pnpm eval:domain` run picks it up with **no code
change**. If an item is missing from the manifest, sensible defaults are inferred.

## Running the suite

```bash
pnpm eval:domain            # scores the corpus, writes eval-results/<runId>.json,
                            # fails (exit 1) on > 5% week-over-week F1 drop
pnpm eval:domain --no-fail  # never fails the process (local exploration)
```

Results are written to `eval-results/` by the nightly CI job
(`.github/workflows/eval-domain-nightly.yml`) and surfaced in the **Domain Eval**
tab of the `/eval/leaderboard` page.

> **`eval-results/` is gitignored (#983), so the nightly's commit-back step has
> been a silent no-op since 2026-07-21** — `git status --porcelain` does not list
> ignored files, so its "anything to commit?" guard always sees nothing. Tracked
> in **#1333**. The envelopes still in the tree predate the ignore rule.

## Provenance

All documents are synthetic and were written for this repository. They do not
reproduce any real product specification, customer data, or third-party
copyrighted text. The authoring script (`build-fixtures.mjs`) is retained so the
curation is reviewable and reproducible.

## Reference answers (`reference.json`) — issue #1319

Ground truth used to cover **contexts** (the span-anchored `quote` in
`queries.json`) and **extractions** (`expected.json`), but not **answers**. Every
metric was therefore reference-free — "is this answer supported by what we
retrieved?" and never "is this answer right?" — so a confidently wrong answer
that cites real retrieved text scored clean.

`reference.json` is the missing input. It sits beside `queries.json` in a corpus
directory and pairs each `queryId` with a gold answer plus its provenance:

```jsonc
{
  "corpusId": "docretrieval-01-metis-docs",
  "license": "CC0-1.0",                 // an SPDX identifier — see below
  "snapshotCommit": "953bfe70…",        // must match queries.json
  "answers": [
    {
      "queryId": "dq-ops-01",           // must exist in queries.json
      "answer": "…",                    // 1–3 sentences of self-contained prose
      "note": "anything deliberately out of scope",
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

### Authoring rules

1. **A human writes the answer.** A model-generated "gold" answer makes
   answer-correctness a measurement of the judge against itself: it yields a
   confident number that means nothing, in every circumstance including a broken
   one. The validator rejects an author or reviewer whose name matches a model
   and rejects a self-review — but it cannot tell where prose actually came from,
   so this rule is enforced by the person opening the PR.
2. **Do not read the system's answer before writing yours.** It anchors you, and
   an anchored reference scores the system against its own phrasing.
3. **1–3 sentences of self-contained prose, stating the fact and not its
   location.** No citation markup, tables, or bullet lists. Enforced.
4. **Use your own words.** Correctness is scored semantically (claim-level
   entailment in both directions), so a paraphrase scores as correct and copying
   the source span buys nothing.
5. **`FLAG:` a query whose anchored `quote` does not answer it.** Those items are
   excluded from the metric and reported separately as a corpus finding — that is
   a defect in `queries.json`, not a wrong answer by the system.
6. **If the snapshot moves, re-review — never re-stamp.** An answer written
   against text that no longer exists in the corpus is not ground truth.

Per-corpus detail, including the full validator rule table, lives in that
corpus's `REFERENCE-AUTHORING.md`.

### Licences are per corpus, and every corpus now has one

The `brd-*`/`prd-*` items are CC0-1.0 because they are original synthetic
content. `docretrieval-01-metis-docs` is a snapshot of METIS's **own**
documentation, so its reference answers are derived from it — which made the
licence the repository owner's to set rather than an external question. #1382
set it to **CC0-1.0**, matching the other two `reference.json` files and the
rest of `eval-data/`, and closing **E4 in #1322** and the `reference.json` half
of **#1300**.

`LICENSE_PENDING` remains a valid sentinel in the loader for a corpus whose
licence is genuinely undecided; no corpus uses it today. No `docretrieval-*`
corpus has an entry in `manifest.json` — they are described by their own
`queries.json` and `snapshot-manifest.json`.

### Running it

```bash
pnpm eval:answer-correctness                  # validate + report, writes eval-results/
pnpm eval:answer-correctness --validate-only  # just check reference.json
```

A missing `reference.json`, one whose `answers` array is empty, and one holding
only `FLAG:` items are all legitimate states: the metric is reported as **not
reported**, with the reason, never as a score of zero.
`docretrieval-01-metis-docs` ships in exactly that state today — the schema,
loader, validator and metric are complete and tested; the 43 gold answers are a
human deliverable that has not been written yet.
