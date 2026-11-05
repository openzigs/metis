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

## Localization corpora (#1753)

File localization of **analyst-worded** requirements: which files of a code graph a
requirement should lead to. Every arm of epic #1751 is measured on these, so the
ground truth was fixed before any arm ran.

| Corpus | Items | Purpose | Repositories |
|---|---|---|---|
| `localization-01-miniflux-heldout` | 25 | **held-out** | `miniflux/v2` at `v2.3.3` |
| `localization-02-fixture-portfolio` | 15 | **held-out** (reused by #1766) | `openzigs/metis-fixture-{orders,billing,notify}` |
| `localization-00-miniflux-run7-insample` | 6 | **in-sample only**: never used to claim a gain | `miniflux/v2` at `v2.3.3` |

Each corpus holds a `manifest.json` (items, ground truth, provenance, who wrote the
text), the code graph's symbol rows as `symbols.json.gz`, and `baseline-A0.{json,md}`.

- **Miniflux held-out:** PRs merged after `v2.3.3`, each rewritten in analyst
  language by a writer who had not seen the diff; ground truth is the PR's non-test,
  non-documentation files that the `v2.3.3` graph holds. Who wrote the text, the
  order of the steps, which PRs were left out and why:
  [`ANNOTATION.md`](corpus/localization-01-miniflux-heldout/ANNOTATION.md).
- **Fixture portfolio:** requirements written against three tiny public fixture
  repositories, each with its expected repositories, files and portfolio verdict
  (`implemented` / `partial` / `gap`). The three repositories hold **ten code files**
  between them, so Recall@10 is 1.00 for any arm that ranks ten files: read
  Recall@5, edit precision and MRR there.
- **Run-7 in-sample:** the six developer requests of walkthrough run 7 and their 19
  reference files (`docs/walkthroughs/TEST_PLAN.md`), less the two the graph does not
  hold. The `change-seeds.ts` cut sizes were tuned on these six.

**Licences.** The requirement text and labels written for METIS are CC0-1.0. The
Miniflux corpora also quote each PR's or issue's own title and description, and
their symbol rows carry the first lines of Miniflux functions (the text production
embeds); both are Apache-2.0, from `miniflux/v2`, kept for provenance and
reproducibility.

### Running it

```bash
pnpm eval:localization                 # A0 on both held-out sets, 3 runs, $35 cap
pnpm eval:localization --arms A0,A4    # an arm against A0, paired, on the same items
pnpm eval:localization --in-sample     # also the run-7 six (a sanity check, not a claim)
pnpm eval:localization --table-guard   # + table precision on impact-recall-01 (live provider)
pnpm eval:localization --budget 25     # the dollar cap; the run stops before it is passed
```

Arms are chosen only by `--arms`; no `IMPACT_LLM_*` variable changes what is
measured, and every report names each arm's configuration. Reports go to
`eval-results/` (untracked); `--baseline` (A0 alone) rewrites the committed
`baseline-A0.*`.

A0 searches with production's hybrid ranking, so it needs a vector for every symbol
and every query. The fixture set's vectors are committed. Miniflux's (about 5.6 MB)
are not: record them once with the local model, which takes about six minutes.

```bash
EMBED_BACKEND=xenova EMBED_MODEL=Alibaba-NLP/gte-modernbert-base \
TRANSFORMERS_CACHE=~/.cache/metis-transformers HF_HUB_OFFLINE=1 \
pnpm eval:localization --embed --in-sample
```

Without `--embed` a missing vector fails the run instead of letting the search fall
back to BM25 under the hybrid label.

### Materializing a corpus for agent arms (#1799)

An agent arm runs the Analysis code agent, whose tools (`search_code_graph`,
`search_code_symbols`, `read_file_slice`, `list_files`) read an ingested project, its
symbol vectors and a clone. The committed symbol rows are not enough for that, so
materialize the corpus first:

```bash
TRANSFORMERS_CACHE=~/.cache/metis-transformers HF_HUB_OFFLINE=1 \
pnpm eval:materialize localization-01-miniflux-heldout
TRANSFORMERS_CACHE=~/.cache/metis-transformers HF_HUB_OFFLINE=1 \
pnpm eval:materialize localization-02-fixture-portfolio
```

For each repository in the manifest, the command:

1. makes a shallow clone at the pinned commit;
2. creates a project with a GitHub repository connector;
3. runs the normal code-graph ingest, with SQL lineage off as the committed rows were built;
4. embeds the symbols with the local embedder (`EMBED_BACKEND=xenova`,
   `Alibaba-NLP/gte-modernbert-base` unless `EMBED_MODEL` says otherwise).

No hosted model is called, so it costs $0. Everything goes into the gitignored
`eval-data/.materialized/`:

| Path | What | Variable an arm sets from it |
|---|---|---|
| `eval.db` | the SQLite eval database | `DATABASE_URL` |
| `clones/<connectorId>/` | one clone per repository | `REPO_CLONE_DIR` |
| `lancedb/` | the symbol vectors | `LANCEDB_PATH` |
| `<corpus>.state.json` | each repository's `projectId`, `connectorId` and commit SHA, plus the three paths above | (read it with `readMaterializedState`) |

The script sets those variables itself and reads no `.env`. It fails unless Prisma is
bound to `eval.db`, so it never writes to `server/dev.db`. It also fails if
`VECTOR_STORE` or `AI_OFFLINE` would send the vectors anywhere but `lancedb/`. Each
repository is its own project: the analysis agent pass works on one connector's clone
at a time.

**The symbol-set check.** Every run compares each repository's materialized graph with
the committed `symbols.json.gz`: the same files, and the same qualified names in each
file. If they differ, the run fails and lists the missing and extra files and symbols.
A repository built in that run is deleted rather than left half-trusted. This keeps the
agent arms and A0 measuring the same code.

**A re-run is a no-op.** When the state file, the database and the clones still hold
every repository at its pinned commit, with every symbol embedded by the current model,
nothing is built or written. A changed commit, URL or embedding model rebuilds only what
it affects.

**Disk and time** (measured 2026-11-04 on an Apple-silicon laptop, model already cached):

| Corpus | Symbols | Clone | Ingest | Embed | Re-run |
|---|---|---|---|---|---|
| `localization-01-miniflux-heldout` | 3,533 | 1 s | 4 s | 82 s | 2 s |
| `localization-02-fixture-portfolio` (3 repositories) | 40 | 1.4 s | < 1 s | 4 s | 2 s |

Both corpora together take about 57 MB: 22 MB database, 26 MB vectors, 8 MB clones.
The first run with an empty model cache also downloads the embedding model (drop
`HF_HUB_OFFLINE=1` for that run).

**Cleanup.** `rm -rf eval-data/.materialized` removes everything. Deleting one
`<corpus>.state.json` makes the next run of that corpus rebuild and replace its
projects, which have fixed slugs and connector ids.

### Rebuilding a corpus

```bash
cd server
DATABASE_URL=file:/abs/scratch.db pnpm exec prisma migrate deploy
# the real code-graph ingest of each repository, at the manifest's pinned commit
DATABASE_URL=file:/abs/scratch.db pnpm exec tsx scripts/build-localization-corpus.ts \
  symbols --corpus localization-01-miniflux-heldout --root miniflux=/abs/miniflux-at-c4d54f87
# each upstream-PR item's ground truth, from the merged PR's file list (gh api)
pnpm exec tsx scripts/build-localization-corpus.ts ground-truth \
  --corpus localization-01-miniflux-heldout
```

The symbol rows were built with SQL lineage off (no sidecar), so they carry no
lineage writer: the read-path rule of #1135 (`writesData`) is inert on them.
