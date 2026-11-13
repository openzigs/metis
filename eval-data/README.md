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
pnpm eval:localization --arms A0,A13,A13C,A13S  # #1798 LLM re-order: A0 base, A12 base, shuffled pool
pnpm eval:localization --merge <dir> --reference A12,A13  # + every arm paired with A12, then A13 (#1806)
pnpm eval:localization --corpus localization-00-miniflux-run7-insample --arms A13 --rerank-weight 0.05  # tune the re-order's model weight
pnpm eval:localization --in-sample     # also the run-7 six (a sanity check, not a claim)
pnpm eval:localization --table-guard   # + table precision on impact-recall-01 (live provider)
pnpm eval:localization --budget 25     # the dollar cap; the run stops before it is passed
```

`--reference <arm>[,<arm>…]` adds a table per arm that pairs every other arm with it
(a pooled table too, when both held-out sets ran). Use it for comparisons such as A13C
against A12 or A13S against A13. It changes no score, and you can pass it to `--merge`.
The decision bars are still read against A0. An id that is not one of the run's arms
fails before the provider is built, so a typo spends nothing (#1819).

**Tune on the in-sample set alone.** `--in-sample` ADDS the run-7 six to both held-out
sets, so a weight sweep run with it reads the held-out sets at every candidate weight:
that breaks the in-sample-only rule and costs about three times as much. Name the corpus
instead, `--corpus localization-00-miniflux-run7-insample` (#1819).

**A `deepseek-flash` tuning run needs `MODEL_PRICES` set**, for example
`MODEL_PRICES='{"deepseek-flash":{"inputPerMTok":…,"outputPerMTok":…}}'` at DeepSeek's
published per-MTok prices (`server/src/lib/finops/model-prices-schema.ts`). The model has no built-in price, and the run stops on its first
unpriced call (#1806).

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

### Slices, resume and merge (#1800)

A slow arm (agent passes, a slow provider) does not fit one ten-minute call. Every run
records each requirement's score as its own partial file, so a run can be split into
item slices, resumed after a stop, and merged into one report by the runner itself:

```bash
pnpm eval:localization --arms A0,A4 --shard 1/3                 # prints its partials directory, <dir>
pnpm eval:localization --arms A0,A4 --shard 2/3 --resume <dir>  # each later slice writes into <dir>
pnpm eval:localization --arms A0,A4 --shard 3/3 --resume <dir>
pnpm eval:localization --merge <dir> --md                       # the report; runs nothing
```

- **Slices.** `--shard <n>/<m>` runs the n-th of m contiguous shards of each corpus's
  items; `--items <from>:<to>` runs an item range (0-based, end exclusive). Without
  either, every item runs.
- **Partial files** live in `eval-results/localization-partials-<run>/`:
  `<corpus>/config.json` (the configuration), one `<corpus>/<arm>/run-<n>/<item>.json`
  per requirement score, and `spend/<invocation>.json` for spend outside requirements
  (the table guard).
- **Resume.** `--resume <dir>` loads every score already recorded and runs only the
  missing ones, so a stop mid-slice re-runs nothing that finished. A3 and A3A share one
  agent pass per item and run in one invocation; when a resume scores them in different
  invocations, the report flags the requirement-runs read on separate passes (#1810).
  **Partials recorded before #1810 carry no pass ids**, so a split among them cannot be
  seen: the report shows none there, not that there was none.
- **Merge.** `--merge <dir>` builds the per-corpus and pooled reports from the partial
  files with the runner's own scoring and statistics; three slices merged give the
  report one full run gives. Every report lists the requirements still missing a score.
  Read the table guard here (`--merge <dir> --table-guard`): a slice refuses it.
- **One cap across slices.** `--budget` holds against what every slice in the directory
  has spent, read back from the partial files, with the same per-arm look-ahead. A
  recorded unpriced call stops every later slice.
- **One configuration.** The first slice writes the arms' configuration, the model, the
  run count and a digest of the corpus. A slice or resume that differs in any of them
  is refused with the difference listed; a merge refuses a changed corpus or a partial
  file recorded under another configuration. Pass the same `--arms` and `--runs` to
  every slice.

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

**The table guard's repository (#1823).** `impact-recall-01-jpetstore` is a hand-authored
graph with no source text, so A7's table guard needs the repository it models:

```bash
TRANSFORMERS_CACHE=~/.cache/metis-transformers HF_HUB_OFFLINE=1 \
pnpm eval:materialize impact-recall-01-jpetstore
```

This materializes mybatis/jpetstore-6 at `jpetstore-6.3.0`, the last release with the Stripes
action beans the fixture's web layer models (`TABLE_GUARD_REPO` in
`server/src/lib/eval/localization/table-guard-source.ts`). There are no committed rows to
compare, so the check is instead that the graph holds every fixture file the repository has
(`requiredRepoFiles`). The fixture's `web/beans` layer and its inventory, profile and sign-on
classes are its own modelling and are not required.

Then read the guard over a partials directory that recorded A7:

```bash
pnpm eval:localization --merge <dir> --arms A0,A7,A7O --table-guard --embed --guard-steps 5
```

The guard runs "Evaluate new requirements" once for each of the 11 table requirements on
each of 3 runs. It then reads A0 on the split seeding, A7 and A7O, 3 runs each, with the
live #936 filter. Each step is an analysis or one run of one reading, A0's mapper reading
included (#1847), so a resumed call pays for none of them again. Each step is recorded
in `<dir>/table-guard/records.jsonl` as it ends. `--guard-steps <n>` limits a call to n new
steps, so repeat the same command until the report reads the guard.

A resume is refused, and needs a new partials directory, when (#1847):

- a step was recorded on another model;
- a step was recorded on another fixture (its requirement texts, labels or graph) or
  another repository pin (`TABLE_GUARD_REPO`): every record carries that fingerprint;
- an analysis's stored requirements no longer resolve in the eval database (after a
  re-materialize, a reset or on another database). Production's read skips such an id,
  so every analysis would otherwise be read as the fixture's text, and A7 and A7O would
  converge on the baseline.

Once two readings are complete, the guard prints their paired 95% t-interval over the 11
requirements (each requirement's table precision, averaged over the runs):
`guardPairedDifferences` in `table-guard-agent.ts`. A7 is gated against A7O, the same
analyses with the flag off, not against A0 (owner decision, #1823): the report's guard
row for A7 reads "against A7O".

**What A7 and A7O are scored on (#1848).** An analysis persists its restatement of the
requirement first. It then persists about four further requirements, mostly elicited
non-functional ones, each with tables of its own. A run records every persisted
requirement's own tables, and A7 and A7O are scored on the **first** one. Each run's
line, the reading's configuration and the paired intervals also give the union of every
persisted requirement's tables, the reading before #1848. Scored against one label, that
union cost about 0.2 table precision that the analysis path does not lose
(docs/IMPACT_ANALYSIS_LLM_STAGES.md). Records written before #1848 have no per-requirement
tables, so they are read on the union.

**A7's gate reads both scorings (#1890).** Against A7O the union's artefact mostly cancels,
so A7 must hold within 0.03 of A7O on the first persisted requirement **and** on the
union. The guard row says which scoring decided it, for example
`FAILED (failed on the analysis's first persisted requirement (0.648 against 0.760))`. A
run whose per-requirement tables miss a requirement is refused by name; use a new
partials directory.

**A stale eval database is refused.** The impact path keeps the search's seeds when a
stored-citation lookup throws. An eval database that predates a migration, such as the
`freshness` column added in #1830, would therefore read A7 as A7O. The guard refuses such
an A7 run and records nothing. Run `pnpm eval:materialize impact-recall-01-jpetstore`:
it migrates the database first, and does nothing else when the corpus is already
materialized.

A stored citation names a repository file and symbol, and is read on the fixture in this
order:

1. as the same symbol;
2. when the fixture does not hold the cited file, as the one same-named method or MyBatis
   statement in the same layer (the fixture keeps `insertLineItem` in `OrderMapper`);
3. as its file, with no symbol;
4. dropped, when the fixture has no such file.

The A7 reading's configuration counts each outcome.

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

### Stale citations: the staleness slice (#1834)

Arm A7 (`IMPACT_AGENT_SEEDS`) leads the files to edit with the code agent's stored
citations. When the code changes after the analysis, re-validation (#1831) marks a
citation `moved` or `stale`, and #1832 sets a stale one aside. The staleness slice
measures that on the held-out corpora, over the same analyses as A7.

**The shipped behaviour is demotion off (#1939).** #1832's demotion runs only with
`IMPACT_DEMOTE_STALE_CITATIONS=1`, because A7SD − A7S cost Recall@5 −0.097 on Sonnet
(#1915). So A7 (no re-ingest), A7S (after the code changed) and A7R (after a routine
re-ingest) read what production ships, and A7SD and A7RD force the flag on:

| Arm | Staleness | Demotion (#1832) |
|---|---|---|
| `A7` | none | off (as shipped since #1939) |
| `A7K` | none | off: the stage before #1832; since #1939 the same reading as A7 |
| `A7S` | the item's patch, re-ingested | off (as shipped since #1939) |
| `A7SD` | the item's patch, re-ingested | on (the flag forced on) |
| `A7R` | none: a no-op re-ingest at the pinned commit (#1899) | off (as shipped since #1939) |
| `A7RD` | none: a no-op re-ingest at the pinned commit (#1899) | on (the flag forced on) |

With no re-ingest every citation is still `unverified`, so A7K reads the same as A7
**by construction**: with demotion off, nothing is reordered or set aside. A7K
therefore checks the wiring. It does not measure what demotion costs when nothing is
stale (#1899). The production case is a routine re-ingest that changes nothing. Its
re-validation (#1831) gives every citation a verdict, and #1832's freshness tier then
reorders them. Most read `fresh`, including a symbol whose lines drifted within its file
(its lines are updated, it is not `moved`). `moved` means the cited symbol now sits, with
the same content, in another file. A no-op re-ingest can still give `stale` (#1925): a
file-level link whose lines run past the end of the file, or a symbol that is missing from
its file or matches more than one candidate.
A7R and A7RD measure that case: every repository is re-ingested at its pinned commit
with no patch, and the result is read without and with demotion. Read A7RD against A7R
for demotion's cost after a routine re-ingest.

**The patches are committed**, one file per corpus, in
`server/scripts/eval-localization-staleness/`, and the script applies them. Each item's
patch edits the functions of one file, renames one file and deletes one file:

- **edit:** one comment line inside each of the symbols, so each symbol's content hash
  changes and its location does not. They are in the first ground-truth file that has
  any:
  - every multi-line symbol the item's labels name (the table corpus's
    `expectedCodeSymbols`);
  - else every multi-line function and method;
  - else the longest other multi-line symbol.

  Every function is edited, not one, because nobody knows in advance which function the
  analysis cites. On the first DeepSeek reading, an edit to the single longest function
  of MF-4483's answer file left none of its 21 citations stale. Editing every function
  of that file left 13 of 44 stale over two items.
- **rename:** another ground-truth file, else the edited file's nearest neighbour, to
  `<name>_renamed<ext>`. A renamed file is scored as the file it was.
- **delete:** the edited file's nearest neighbour with the most symbols. This is never
  an answer, a test or a documentation file, so every item stays answerable.

The rule is `STALENESS_RULE` in `server/src/lib/eval/localization/staleness.ts`, and
`pnpm eval:staleness-patches [--table-guard]` writes the sets. A test pins the held-out
sets to what the rule generates from the committed rows. The table corpus's set is
generated from the materialized jpetstore graph.

Which files a model cites is not known when the patch is written, so the targets are
the files the analysis is most likely to cite. Every staleness reading reports how many
of the stored citations the patch actually left `stale`, `moved` or `fresh`, and how
many the stage set aside. Check that line before reading a difference.

**The cycle**, per item and run, shared by A7S and A7SD:

1. apply the item's patch to the materialized clone and commit it;
2. re-ingest incrementally, which re-validates every stored citation of the repository
   (#1831);
3. read impact analysis twice: without demotion (A7S) and with it (A7SD);
4. reset the clone to its pinned commit, re-ingest, and embed the re-created symbols,
   so a later analysis searches what A7 searched.

On Miniflux a cycle takes a few seconds. The staleness arms search the patched corpus,
as a re-ingest would leave it: a renamed file's rows carry the new path and are
embedded again, and a deleted file's rows are gone. An edited symbol keeps its vector,
because one comment line is not worth a new one. The stage's graph check reads the same
patched graph, so a citation of a deleted file is dropped with or without demotion.
(The first version searched the committed rows. The stage then found a renamed file's
symbols already taken by the search's hits at the old path, and lost the file. MF-4500
read Recall@5 0.5 instead of 1.0 for that reason alone.)

A cycle re-validates every citation of the repository, so A7 and A7K must come before
A7S and A7SD in `--arms`. A patch cycle's restore also leaves a citation `moved` back,
so A7R and A7RD come after A7 and A7K and before A7S and A7SD. The arm builder refuses
any other order.

If a restore, re-ingest or re-embed throws for one repository, every other repository
is still restored. The original error is then rethrown with the restore failures
attached as `restoreFailures`. When only a restore failed, a `StalenessRestoreError`
names every failure (#1899).

```bash
pnpm eval:materialize localization-01-miniflux-heldout   # and -02, and impact-recall-01-jpetstore
pnpm eval:localization --arms A0,A7,A7K,A7S,A7SD --reference A7,A7S --embed --items 0:4
pnpm eval:localization --arms A0,A7,A7K,A7S,A7SD --reference A7,A7S --embed --items 4:8 --resume <dir>
pnpm eval:localization --merge <dir> --reference A7,A7S --table-guard --embed --guard-steps 5
# #1899 — the no-op re-ingest pair beside them (A7RD against A7R: demotion after a routine re-ingest)
pnpm eval:localization --arms A0,A7,A7R,A7RD,A7S,A7SD --reference A7,A7R,A7S --embed --items 0:2
```

**It fails before spending.** Before the provider is built, a staleness run checks:

- every corpus is a held-out set (`--in-sample` and the run-7 corpus are refused);
- each corpus loads and is materialized;
- each corpus has a committed patch for every item, and every patch fits the graph:
  the files exist, a rename's target does not, and each edit's line is inside its
  symbol;
- with `--table-guard`, the same for the table corpus against its materialized graph.

It also puts back any clone or graph that an earlier, killed run left patched.

The table guard reads A7S and A7SD on `impact-recall-01-jpetstore`, over the same
analyses as A7, with one cycle per requirement and run. A7S is gated against A7, and
A7SD against A7S. All are scored as A7 is, on the analysis's first persisted requirement
(#1848). A moved citation is read as the file it was, because the fixture's
graph is the unpatched repository's. A deleted file leaves both the fixture's graph and its
search. Each staleness run record carries the patch sets' digest, and a resume under other
patches is refused.

**Results** (2026-11-06). The held-out run is on `main` at `07c76a1e` plus this slice,
with #1831's re-validation in it. #1825, merged later, changed no seeding behaviour. The
table guard was read again on `main` at `219b5fc8` (#1848's scoring) plus this slice.

The held-out run is on `claude-sonnet-5-5`, one run, both held-out corpora:

| Arm | Miniflux R@5 | Fixture R@5 | Pooled R@5 vs A0 | MRR (Miniflux / fixture) |
|---|---|---|---|---|
| A7 | 0.81 | 0.70 | +0.239 [0.12, 0.36] | 0.92 / 0.64 |
| A7K | 0.81 | 0.70 | +0.239 [0.12, 0.36] | 0.92 / 0.64 |
| A7S | 0.83 | 0.63 | +0.222 [0.11, 0.33] | 0.92 / 0.64 |
| A7SD | 0.73 | 0.63 | +0.162 [0.05, 0.27] | 0.68 / 0.54 |

Paired comparisons, pooled over the 39 items:

- **A7K − A7: exactly 0** on every metric, as it must be by construction: with no
  re-ingest every citation is `unverified`. This shows the wiring, not what demotion
  costs when nothing is stale. That case, after a routine re-ingest, is A7RD − A7R
  (#1899), measured below (#1915).
- **A7S − A7:** Recall@5 −0.017 [−0.07, +0.03]. No measurable difference.
- **A7SD − A7S:** Recall@5 **−0.061 [−0.11, −0.02], p = 0.002**, and MRR **−0.189
  [−0.28, −0.11]**. Under staleness, demotion lowers both.

Over the 39 items the patches left 346 stored citations stale, 167 moved and 803 fresh.
A7SD set all 346 stale ones aside. On the fixture portfolio, a renamed file's file-level
citations went stale (`file-missing`) rather than moved: #1831 tracks a rename by symbol
only. On the two items checked, FX-02 and FX-03, that is what lowered A7S against A7.

**Table guard** (`deepseek-flash`, 3 runs, live #936 filter, 33 analyses). Each reading
is scored on the analysis's first persisted requirement (#1848), with the union of every
persisted requirement beside it:

| Reading | First persisted requirement | Unioned |
|---|---|---|
| A0, mapper | 0.803 | 0.803 |
| A0, split | 0.644 | 0.644 |
| A7O | 0.753 | 0.487 |
| A7 | 0.702 | 0.459 |
| A7S | 0.720 | 0.452 |
| A7SD | 0.692 | 0.485 |

Paired over the 11 requirements, scored on the first persisted requirement:

- A7S − A7: +0.018 [−0.083, +0.118]
- A7SD − A7S: −0.028 [−0.123, +0.067]

Unioned, the same pairs read −0.007 [−0.087, +0.072] and +0.033 [−0.008, +0.075]. Both
hold the 0.03 guard on the mean. A7 − A7O on DeepSeek is −0.051 [−0.120, +0.018], as on
#1848's DeepSeek re-read; on Sonnet it held. The staleness readings were taken after A7's
on fresh analyses: a patch cycle re-validates every citation of the repository, so a
reading of A7 after a cycle would see citations the cycle had moved back as `moved`.

**Reading it.** A7K − A7 = 0 holds by construction, so it gives no reading on #1832's
default either way. Demotion's cost after a routine re-ingest is A7RD − A7R (#1899):
zero, below (#1915). Under this patch, demotion costs ranking. A
comment-only edit makes a citation stale while its file is still the answer, which is the
worst case for demotion. This slice does not model drift that moves the behaviour
elsewhere.

**Cost.**

- Sonnet, read from the eval database's ledger: $14.30.
  - $11.59 is in the readings above: Miniflux $4.84, fixture $6.76.
  - $0.76 went on a first slice whose search had not been patched (fixed, then re-run).
  - $1.95 went on the analyses of two slices that the shell timeout killed. Their spend
    is recorded in `spend/` and they were re-run.
- DeepSeek: about $2.10. The ledger records $1.48 for the analyses. The #936 filter calls,
  metered by the run, add about $0.60. That covers two table-guard readings: a first
  reading scored only on the union ($0.96), superseded when #1848 changed the guard's
  scoring, and the reading above ($0.86).

The records are committed in `server/src/lib/eval/localization/__fixtures__/`, and
`staleness-results.test.ts` reproduces every figure above from them.

**The no-op re-ingest arms** (#1915, 2026-11-07, on `main` at `a6577a7e`). A0, A7, A7R,
A7RD, A7S and A7SD were read together on fresh analyses: `claude-sonnet-5-5`, one run,
both held-out corpora, one corpus per call. Keep each call to at most 2 items, so it fits a
10-minute call: fixture slices of 1 or 2 items took 230–460 s. (Some Miniflux slices of this
run were 3 items, 166–333 s; 2 is the safe size to repeat it with.)

```bash
pnpm eval:localization --corpus localization-02-fixture-portfolio \
  --arms A0,A7,A7R,A7RD,A7S,A7SD --reference A7,A7R,A7S --runs 1 --budget 18 --embed --items 0:1
# … then --items 1:3 … 13:15, and the Miniflux corpus 0:2 … 22:24, each with --resume <dir>
pnpm eval:localization --merge <dir> --reference A7,A7R,A7S
```

| Arm | Miniflux R@5 | Fixture R@5 | Pooled R@5 vs A0 | MRR (Miniflux / fixture) |
|---|---|---|---|---|
| A7 | 0.87 | 0.73 | +0.288 [0.19, 0.39] | 0.93 / 0.63 |
| A7R | 0.87 | 0.73 | +0.288 [0.19, 0.39] | 0.93 / 0.63 |
| A7RD | 0.87 | 0.73 | +0.288 [0.19, 0.39] | 0.93 / 0.63 |
| A7S | 0.87 | 0.70 | +0.276 [0.18, 0.38] | 0.93 / 0.63 |
| A7SD | 0.71 | 0.70 | +0.179 [0.09, 0.27] | 0.59 / 0.51 |

Paired comparisons, pooled over the 39 items:

- **A7RD − A7R: 0 on every metric**, Recall@5 +0.000 [0.00, 0.00], p = 1.000, and MRR
  +0.000 [0.00, 0.00]. After a routine re-ingest, demotion shows no cost.
- **Why it is zero.** The no-op re-ingest left all 1,354 citations read `fresh` (596
  Miniflux, 758 fixture). None was `moved` or `stale`, and none was set aside: none of
  the no-op `stale` cases above occurred on these items. With every citation in one
  tier, the tier sort reorders nothing. The pair does not measure demotion when the code
  has changed (a symbol moved to another file, a stale citation set aside): that is
  A7SD − A7S.
- **A7R − A7: 0 on every metric.** The re-ingest itself changes no reading.
- **A7S − A7:** Recall@5 −0.013 [−0.04, 0.00], p = 0.70. No measurable difference.
- **A7SD − A7S:** Recall@5 **−0.097 [−0.17, −0.03], p = 0.004**, and MRR **−0.255
  [−0.35, −0.16]**. The patches left 338 citations stale, 176 moved and 840 fresh, and
  A7SD set all 338 aside. #1834's analyses read −0.061: both are significant.

**Cost**, read from the eval database's ledger (`token_usages`):

- Sonnet: $11.32 over 787 calls (Miniflux $4.75, fixture $6.57), all in the readings
  above. The cap was $18.
- DeepSeek: $0.11 over 58 calls, for the harness smoke run first (`deepseek-flash`, A7R
  and A7RD, 1 item per corpus).

The records are `__fixtures__/staleness-noop-reingest-sonnet-2026-11-07.partials.jsonl`,
and `staleness-results.test.ts` pins the paired comparisons and the freshness counts (not
the per-arm table).

### The analysis-agent arms (#1755)

`A3`, `A3A` and `A3N` run the Analysis code agent behind "Evaluate new requirements" on
each held-out item and score the files it cites. Materialize both corpora first (above).

```bash
pnpm eval:localization --arms A0,A3,A3A,A3N --runs 1 --shard 1/12   # then 2/12 … with --resume <dir>
pnpm eval:localization --merge <dir> --md
```

| Arm | Agent tools | Files scored |
|---|---|---|
| `A3` (A3-union) | production's (`search_code_graph`, `search_code_symbols`, `search_knowledge`, `read_file_slice`, `list_files`) and seeded blocks | A0's edit candidates, then the cited files through the stored-link channel (#1754) |
| `A3A` (A3-alone) | the same pass as `A3` | the cited files alone, in first-cited order |
| `A3N` (A3-nograph) | `list_files`, `read_file_slice` and `grep_files`; no seeded blocks | the cited files alone |
| `A3P` (A3-primitives, #2327) | `A3A`'s, with `search_code_symbols`'s filters and `grep_files` (chat's search primitives) | the cited files alone |

- **One pass per item and repository.** The pass uses the orchestrator's own functions
  (`extractNewRequirementCandidates`, `assembleAgenticPassSeeds`, `buildAgenticPassPrompt`,
  `runAgentLoop`), with no escalation and no post-loop salvage.
- **A cited file counts only if the code graph holds it** (the rule in
  `seed-code-links-from-findings.ts`), so graph resolution is 1.00 after that step. The
  report gives the share before that step: how many cited files the graph held (#1810).
- **`A3` and `A3A` read the same pass in a run.** Each reports that pass's cost and time as
  its own, and the cap counts the money once. A resume can score them in separate
  invocations, on two passes. The report then names the requirement-runs this affected.
- **The report adds agent-loop turns per requirement.** On a portfolio this is the sum over
  the per-repository passes. Each agent arm also gets a line with its passes, the passes
  with no schema-valid answer, and turns and tool calls per pass.
- **`grep_files` is bounded.** It is a literal search, capped at 50 matching lines and
  5,000 files. Since #2327 it is production code (`analysis/tools/grep-files.ts`, offered to
  chat behind `CHAT_CODE_SEARCH_PRIMITIVES`), so `A3N` runs the same implementation chat does,
  with its #2327 caps (5,000 characters shown, totals when cut, secret files never read).
  The file cap counts only files inside the `pathContains` scope, and it never descends into
  a symlinked directory. A search the cap cut short says so.
- **`A3N` needs the clone.** If a repository's clone is missing, `A3N` stops with an error
  telling you to run `pnpm eval:materialize`.
- **The `--arms` list binds the run to the materialized database.** When it names an agent
  arm, the runner sets `DATABASE_URL`, `REPO_CLONE_DIR` and `LANCEDB_PATH` to the
  materialized layout before Prisma loads, and refuses any other database.
- **DeepSeek pricing.** A `deepseek-flash` run needs `MODEL_PRICES` set. Without a price,
  the first call is unpriced, and an unpriced call stops the run.

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

## Document-understanding corpora (#2229)

Four synthetic Word business documents, each larger than the 10 chunks (about 20 KB)
today's document agent reads, with every requirement and every ambiguity a business
analyst would want raised labelled against a source span. The first three are the Phase 0
baseline of epic #2227: do not change a reader's default until this corpus shows the
change is a gain. The fourth (#2255) is the 60 KB size the epic's definition of done names.

| Corpus | Kind | Word file | Converted text | Sections | Requirements | Ambiguities |
|---|---|---|---|---|---|---|
| `docunderstanding-01-clinic-booking` | FRD | 18 KB | 22,129 chars | 26 | 56 | 12 |
| `docunderstanding-02-freight-claims` | BRD | 18 KB | 23,478 chars | 36 | 60 | 18 |
| `docunderstanding-03-community-grants` | FRD | 22 KB | 35,075 chars | 53 | 106 | 17 |
| `docunderstanding-04-library-lending` | FRD | 31 KB | 60,624 chars | 81 | 216 | 30 |

Document 04 does not write its requirements only as "shall" statements. Most of what a member
experiences is written to the member, as in the library's own leaflets ("You can renew…",
"You will receive…"), and many rules are plain or passive statements ("Overdue notices are
sent…"). Of its 216 requirements, 74 are in the second person, 67 use neither "shall" nor
"must", and 75 use "shall" or "must". All of them are labelled, so a reader that only
picks out "shall" sentences loses recall. Its 30 ambiguities cover all six kinds (nine
contradictions, five undefined terms, four of each other kind). Three of the contradictions are
between a table and the body, and several are between distant sections. Its results are in
[docs/DOCUMENT_UNDERSTANDING_BASELINE.md](../docs/DOCUMENT_UNDERSTANDING_BASELINE.md).

Each item holds `frd.src.md` (the authored document, labels marked inline as
`[[R12 ...]]` and `[[A3 ...]]` with an ambiguity trailer; see
`server/src/lib/eval/doc-understanding/corpus-source.ts`), `source.docx` (built from
it: what every arm reads, through production's `parseDocument`) and `labels.json`
(built from it). The ambiguities are of six kinds: vague terms, undefined terms,
escape clauses, contradictions (several of them between distant sections, and one
between a summary table and the body), gaps the document is silent on, and decisions
it leaves open.

**The labels were written by the document's author, then cross-checked (#2255)**
(`labelStatus` in each `labels.json`). Two AI reviewers labelled every document blind and
independently of each other; an AI judge recommended an answer for each place they
disagreed with the key, and a person confirmed every recommendation. That review added 18
requirements and 12 ambiguities across the four documents and re-kinded five ambiguities from
contradiction to gap; it was not a second human labelling. #2374 added six more requirements
to 01 and 02 (R57 to R59, R61 to R63): label gaps found among the document reader's false
requirements, judged by an AI and not yet confirmed by a person. Two of them are table cells
that were marked only as one side of a conflict. A reviewer who disagrees with a label edits
`frd.src.md` and rebuilds.

```bash
pnpm --filter server eval:doc-understanding:build            # after editing a frd.src.md; commit all three files
pnpm --filter server eval:doc-understanding:build --check    # labels.json up to date?
pnpm --filter server eval:doc-understanding                  # arms A,B,C over all four, 1 run, $10 cap
pnpm --filter server eval:doc-understanding --corpus docunderstanding-01-clinic-booking --arms B
pnpm --filter server eval:doc-understanding --combine a.json,b.json,c.json --reading baseline-sonnet
```

`corpus.test.ts` refuses an item whose labels the converted Word text does not bear
out (a span not found verbatim, a section that is not a heading) and a `labels.json`
that is not what its `frd.src.md` builds. Readings are written to
`eval-data/readings/doc-understanding/`; the result and what follows from it are in
[docs/DOCUMENT_UNDERSTANDING_BASELINE.md](../docs/DOCUMENT_UNDERSTANDING_BASELINE.md).

A reading's JSON holds every arm's model-written output. The lint step's
private-vocabulary check reads CI's term list, which can be longer than a local one, so a
reading that passes `pnpm lint` locally can still fail in CI: reword the flagged string and
say so in the write-up (#2229 did this for two strings).

## BA question answering (#2237)

`corpus/baqa-01-acme-reader/` is Phase 0 of #2228: the questions a business analyst asks
chat, over a two-product sample called Acme Reader. The two products are the Miniflux server
(`miniflux/v2` at 2.3.3, Apache-2.0) and its Python client (`miniflux/python-client` at
1.1.6, MIT). `questions.json` holds 23 one-turn questions in four categories, plus the
multi-turn set below, and the category fixes what a good reply does:

| Category | Questions | A good reply |
|---|---:|---|
| `single-product`: "how does rule X work in product Y" | 11 | answers; carries facts and expected code and doc sources |
| `multi-product`: "what does FRD-12 change in A and B" | 4 | answers from both products and `frd-12.md`; carries facts, expected requirements and the files an impact analysis should name |
| `ambiguous` | 4 | asks a follow-up question |
| `unanswerable` | 4 | says the sources don't show this |

Every fact and line range was read from the pinned commits by the agent that wrote the
set. No person has reviewed them yet (`authoredBy`). `frd-12.md` is a synthetic CC0
FRD with two requirements, uploaded to both products.

S7 to S11 (#2198) are walkthrough run 10's wrong chat answers, asked again as BA questions.
Each `why` names the run step and the wrong claim, and each lists the source that disproves
it, so a contradicted fact is what a recurrence looks like:

| Question | Run 10's wrong claim | The source that disproves it |
|---|---|---|
| S7 | cited `storage/user.go:13-16` (the imports) and missed the unique username | `migrations.go:25`, `storage/user.go:72` |
| S8 | the `removed` status is still used | `migrations.go:1489-1495` |
| S9 | `MarkAllAsReadBeforeDate` has no callers | `googlereader/handler.go:1225` |
| S10 | `showUnreadPage` has the paging bug; missed the category page | `ui/unread_entries.go:38`, `ui/category_entries.go` |
| S11 | the `read_at` requirement is the reading-time estimate | `readingtime/readingtime.go`, `storage/entry.go:412-427` |

The baseline below predates them and covers the first 18 questions only. To measure the
five on their own, add `--questions S7,S8,S9,S10,S11`.

```bash
pnpm eval:materialize baqa-01-acme-reader     # clones, projects, code graph, symbol vectors ($0)
pnpm eval:ba-qa --arm off --budget 5          # the three flags off
pnpm eval:ba-qa --arm on --budget 5 --include eval-results/ba-qa/<off run>.json
pnpm eval:ba-qa --arm no-rerank --budget 2 --questions S1,S2,S3,S4,S5,S6,A3,U3,U4
```

Before its first question, `eval:ba-qa` gives each product what an analyst's project holds.
It runs the connector's README and manifest ingest and its repository-source ingest, then
uploads the corpus documents (the man page and FRD-12) and approves them out of quarantine.
The step can be re-run: an unchanged, indexed file is skipped. The first run embeds about
2,800 chunks on the local embedder, which takes several minutes on an idle machine.

Each question is its own one-turn chat session, run through production's chat pieces as in
`eval:chat-cache`. A question scoped to both products is asked the way chat takes it today,
as an unscoped session with no retrieval (`chatSessionScope`, mirroring
`server/src/routes/ai.ts`). Every arm sets `CHAT_CODE_SEARCH_TOOLS`,
`CHAT_FUSED_CODE_RETRIEVAL`, `RAG_RERANK` and `CHAT_CODE_SEARCH_PRIMITIVES` itself, whatever
the shell or `.env` says (#2243, #2327):

| Arm | Code-search tools | Fused code retrieval | Reranker | Search primitives |
|---|---|---|---|---|
| `off` | off | off | off | off |
| `on` | on | on | on | on |
| `no-tools` | off | on | on | on |
| `no-fused` | on | off | on | on |
| `no-rerank` | on | on | off | on |
| `tools-only` | on | off | off | off |
| `tools-primitives` | on | off | off | on |
| `default` | unset: the server's default | unset | unset | unset |

Each session in the JSON records the tools it called, in order (`toolNames`, #2327).

Since #2327 the `on` and `no-*` arms set `CHAT_CODE_SEARCH_PRIMITIVES=1`, so they offer
`grep_files`, `list_files` and the symbol filters. They do not reproduce the #2243 numbers below,
which were measured without them; `tools-only` is the arm that still matches #2243's tools-only run.

An arm with the reranker on runs the embedder inline so the reranker can share the main
thread (#222). On macOS such an arm can abort with `libc++abi: … mutex lock failed` as it
exits. That is onnxruntime-node shutting down after the results are written, and the files
are complete. Before #2243, `off` meant "unset", which was the same thing while all three
defaulted to off.

The report also counts the tool loop's two caps per arm: sessions that ran out of turns
(`CHAT_TOOL_MAX_TURNS`) and tool results cut to `CHAT_TOOL_RESULT_MAX_TOKENS`.

One judge call per answer returns verdicts only. It gives the reply's behaviour, whether each
fact is stated, contradicted or missing, and whether each cited span supports its claim.
Every number below is computed from those verdicts in code (`server/src/lib/eval/ba-qa/`):

- **Correctness**: the mean share of facts stated, and "fully correct" when every fact is
  stated and none is contradicted.
- **Citation precision**, reported as two rates because they are two different tests. A
  citation with lines is judged against that span's text, and lines that are not in the file
  support nothing. A citation without lines has no span to read, so it is counted as
  supporting only when its file is an expected source. An arm that cites no lines is graded
  only by the looser file test, so one rate over both would compare unlike things (#2265).
  A path both products hold, such as a README, is read in each of them, and the citation
  supports its claim when either product's lines do.
- **Citation recall**: the expected source files an answer cites.
- **Abstention, follow-up and confident-guess rates**, plus false abstention and unneeded
  follow-ups on answerable questions.
- **Spend**: the answers and the judge, apart, priced by the ledger.

A judge reply that cannot be parsed leaves the question unscored, never scored as zero. The
answer and the cited spans reach the judge fenced between markers that carry a random token
per call, labelled as data to grade rather than instructions.

`--budget` is checked between questions. The run stops before a question once the cap is
reached, or once the costliest question so far would carry the spend past it. Since #2316 it is
also checked within a question, before each later turn of a multi-turn question and before the
judge. A turn is checked against the costliest turn so far and the judge against the costliest
judge call, so a cheap judge is not held to an answer's cost; a question cut short there is not
graded. A step costlier than any before it can still cross the cap. `--include` refuses a run with another
fixture, answer model or judge model, or an arm already in the report. The included run is
re-summarized from its per-question scores, so both columns are computed by the same code.

### Baseline, 2026-11-11 (Sonnet 5.5 answers and judge, 18 questions per arm)

Run 2 was run on #2256's branch after #2225's ACL actor had landed. Run 1 was run the day
before and differs only where shown.

These runs predate #2265 and report citation precision as one rate over both checks. The
`off` arm cited no lines, so its 30% is the file test alone. The `on` arm's 83% is mostly
span-judged. The two figures are different tests, not one rate rising from 30% to 83%.
Their "checked against the span" count also includes cited lines that are not in the file.
From the next run on, the report gives the two rates apart.

| | off (today) | on (three flags) |
|---|---:|---:|
| Sessions chat left unscoped (no retrieval) | 9/18 | 9/18 |
| Correctness: mean facts stated | 29% (run 1: 27%) | 49% (48%) |
| Fully correct answers | 0/10 | 2/10 |
| Citation precision, both checks in one rate | 30% (6/20) (run 1: 33%) | 83% (34/41) (89%) |
| … with lines (span-judged, or not in the file) | 0/20 | 35/41 (44/47) |
| Citation recall | 19% (6/32) | 31% (10/32) (28%) |
| Abstention on unanswerable | 4/4 | 4/4 |
| Follow-up on ambiguous | 3/4 | 3/4 |
| False abstention on answerable | 5/10 (run 1: 6/10) | 4/10 |
| Right behaviour, single-product | 5/6 (run 1: 4/6) | 6/6 |
| Right behaviour, multi-product | 0/4 | 0/4 |
| Spend (answers + judge) | $0.309360 (run 1: $0.303841) | $0.488667 ($0.492134) |

- **Every multi-product question abstained in both arms and both runs.** Chat drops a
  two-product scope to an unscoped session, so it retrieved nothing and offered no project
  tools. M1 to M4 scored 0 facts.
- **The `off` arm never cites a line.** The auto-RAG excerpts carry no line numbers, so the
  model cites files by name only, and no citation could be checked against a span. With
  fused code retrieval on, most citations carried lines that could be checked, and most of
  those supported their claim.
- **Rule questions abstain when the 8 retrieved chunks miss the rule.** S4 (user
  validation) abstained with the flags off in both runs, and S3 (the parsing-error limit)
  abstained in run 1. With the code-search tools on, both were answered every time.
- **Several follow-ups and abstentions came from having nothing.** Three of the four
  follow-ups, and two of the four abstentions on unanswerable questions, came in unscoped
  sessions with no retrieval. A3, the one ambiguous question with retrieval, was answered on
  a stated assumption in every run instead of asked about.

### Each flag on its own, 2026-11-11 (#2243)

#2243 turns a flag on by default only once this set shows a gain from it. The `on` arm above
moves all three flags at once, so each flag was measured on its own: the leave-one-out arms,
plus `tools-only`. Sonnet 5.5 answered and judged. The arms ran on the 9 questions that chat
binds to one product (S1 to S6, A3, U3 and U4). The other 9 run unscoped, with no retrieval
and no tools, so no flag can change them. Tools with fused retrieval, and tools alone, were
each run twice. The second "tools + fused" run is `default` on an intermediate state of this
branch, and the second "tools only" run is `default` as it merged.

| | off | tools only | tools + fused | on (all three) | no-fused | no-tools |
|---|---:|---:|---:|---:|---:|---:|
| Correctness: mean facts stated | 51% | 84%, 73% | 86%, 80% | 76% | 76% | 41% |
| Fully correct answers | 0/6 | 2/5, 2/6 | 3/6, 2/6 | 1/5 | 1/6 | 0/6 |
| Citation precision | 28% (5/18) | 80%, 83% | 86%, 77% | 89% (32/36) | 86% (44/51) | 45% (9/20) |
| … checked against the span | 0/18 | 27/35, 34/41 | 35/43, 27/35 | 31/36 | 47/51 | 6/20 |
| Citation recall | 5/15 | 8/13, 10/15 | 10/15, 10/15 | 9/14 | 10/15 | 5/15 |
| False abstention on answerable | 1/6 | 0/5, 0/6 | 0/6, 0/6 | 0/5 | 0/6 | 1/6 |
| Input tokens per question (cache reads included) | 6,000 | 27,500, 24,300 | 25,200, 27,000 | 24,900 | 33,100 | 6,700 |
| Model calls per question | 1.00 | 3.00, 2.78 | 2.56, 2.78 | 2.56 | 3.33 | 1.00 |
| Tool loop out of turns (`CHAT_TOOL_MAX_TURNS` 6) | 0/9 | 0/9, 0/9 | 0/9, 0/9 | 0/9 | 0/9 | 0/9 |
| Tool results truncated (`CHAT_TOOL_RESULT_MAX_TOKENS` 2,000) | 0 | 0, 0 | 1, 0 | 0 | 0 | 0 |

The first "tools only" run and the `on` run each have one unscored judge reply (S5 and S6).

- **Code-search tools: on by default.** The gain comes from them. With them, facts stated go
  from 51% to 73–84% and citation precision from 28% to 80–83%. S4 (user validation) is
  answered instead of abstained. Taking them out of `on` (`no-tools`) loses all of it. They
  cost about 4 times the input tokens and 2 more model calls per question.
- **Fused code retrieval: stays off.** On top of the tools it shows no gain that two runs of 6
  answerable questions can tell from noise: 86% and 80% of facts stated against 84% and 73%,
  77–86% precision against 80–83%, and the same recall. Without the tools it gives citations
  lines to check (6 of 20 against 0 of 18), but facts stated fall from 51% to 41%.
- **Reranker: stays off.** It shows no gain either: `on` against tools + fused is 76% against
  86% and 80% of facts stated. It also cannot run beside the default worker-thread embedder
  (#222), and ADR 0005 measured it worse on code search.
- **The two caps hold for code reading.** No session in any arm ran out of turns. The most
  any used was 6 (`no-fused` S1, answered on its last turn); with the tools on and the
  reranker off, the most was 5. One of 167 tool results was cut: a `search_code_symbols`
  result of 6,128 characters against the 6,000 the cap allows at 3 characters per token.
  `read_file_slice` results peaked at 5,116 characters, because the model reads narrow line
  ranges. `search_code_symbols` comes closest to the cap: 14 of its 48 results were over 5,000
  characters. Both caps are left as they are.
- **Dollar spend is not compared across these arms.** An arm that shares a prompt prefix with
  the one run just before it reads that arm's prompt cache. The second "tools only" run cost
  $0.0178 per question in answers, against $0.0331 for the first. The table gives input
  tokens instead. The nine runs, one of them a 1-question smoke run, cost **$2.764553**
  (answers and judge).

### Search primitives, 2026-11-12 (#2327)

`CHAT_CODE_SEARCH_PRIMITIVES` adds `grep_files` (a literal text search over the repository
clones), `list_files` and `search_code_symbols`'s `fileGlob` / `symbolKind` / `language`
filters to the code-search tools. The issue lets it default on only if it does not regress
facts stated, citation precision, edit precision, turns or input tokens. It measured two ways,
both paired against the same tools without it, Sonnet 5.5 throughout.

**BA question set** (`tools-only` against `tools-primitives`, the nine single-product
questions as in #2243, two runs of each arm, alternating):

| | tools only | tools + primitives |
|---|---:|---:|
| Mean facts stated | 81%, 84% | 85%, 87% |
| Fully correct | 2/5, 3/6 | 3/5, 3/6 |
| Citation precision | 60% (25/42), 76% (37/49) | 63% (33/52), 76% (34/45) |
| Citation recall | 10/15, 10/15 | 12/15, 11/15 |
| Right behaviour | 8/9, 9/9 | 8/9, 9/9 |
| Input tokens / question | 26,600, 25,600 | 32,800, 32,400 |
| Model calls / question | 2.78, 2.67 | 3.22, 3.11 |
| Tool results cut to the cap | 0, 0 | 2, 1 |
| Tools called (both runs) | `search_code_graph` 26, `read_file_slice` 17, `search_code_symbols` 11 | `grep_files` 44, `read_file_slice` 28, `list_files` 5 |

S5 went unscored in the first run of both arms (the judge reply could not be parsed).

**Localization held-out corpus** (`localization-01-miniflux-heldout`, 24 items, one run):
`A3P` is the Analysis agent's pass `A3A` with the primitives added (`grep_files` and the
symbol filters), its citations scored alone, and is paired against `A3A` with
`--reference A3A`:

| | A3A | A3P | Δ (95% CI) |
|---|---:|---:|---:|
| Recall@5 | 0.68 | 0.70 | +0.015 [−0.14, +0.17] |
| Recall@10 | 0.70 | 0.75 | +0.043 [−0.12, +0.20] |
| Edit precision | 0.57 | 0.51 | −0.063 [−0.19, +0.05] |
| MRR | 0.77 | 0.80 | +0.028 [−0.16, +0.22] |
| Turns / tool calls per pass | 3.5 / 8.9 | 3.3 / 7.6 | |
| Cost per item | $0.0838 | $0.1168 | |

```bash
pnpm eval:ba-qa --arm tools-only --budget 3 --questions S1,S2,S3,S4,S5,S6,A3,U3,U4
pnpm eval:ba-qa --arm tools-primitives --budget 3 --questions S1,S2,S3,S4,S5,S6,A3,U3,U4
pnpm eval:materialize localization-01-miniflux-heldout
pnpm eval:localization --corpus localization-01-miniflux-heldout --arms A0,A3A,A3P --runs 1 --embed --items 0:4
pnpm eval:localization --merge <dir> --reference A3A --md
```

- **Off by default.** On the BA set the primitives cost about 25% more input tokens and 0.45
  more model calls per question; the facts and citation gains are within the run-to-run
  spread. On localization no metric moved measurably, edit precision fell by a point
  estimate of 0.06 and each item cost 39% more. Both are regressions the issue names.
- **Given `grep_files`, chat stopped using the graph and symbol tools.** In 18 sessions it
  never called `search_code_graph` or `search_code_symbols`, so the symbol filters were not
  exercised on this set and cannot be measured apart from `grep_files` here.
- **The cut results were not the new tools.** `grep_files` and `list_files` results on this
  clone measured 3,300 to 4,400 characters at their own caps, under the 6,000-character tool
  result cap; `read_file_slice` reads can exceed it.
- **Spend:** $1.318 on the BA set (one 1-question smoke run and four runs) and $4.814 on
  localization, answers and judge, $6.13 in all.
- On this machine the materialize step's worker-thread embedder aborted with
  `libc++abi: … Napi::Error` while embedding symbols (load average above 30);
  `EMBED_INPROCESS_RUNTIME=inline pnpm eval:materialize …` completed.

### Relevance floor (#2241)

`pnpm eval:ba-qa --floor-sweep` asks no model and spends $0. After the knowledge step, it runs
chat's knowledge search (k 8, as the eval user, flags off) for each question over each product
in its scope. It also runs six off-topic probes (`OFF_TOPIC_PROBES`: "What is the capital of
France?" and the like) over each product. For each candidate floor on the dense cosine it then
reports what the floor would empty or drop (`server/src/lib/eval/ba-qa/relevance-floor.ts`).
Run on 2026-11-11 with gte-modernbert-base, the default embedder:

| Floor | Off-topic probes emptied | Unanswerable emptied | Answerable emptied | Ambiguous emptied | Expected excerpts kept | Excerpts dropped |
|---:|---:|---:|---:|---:|---:|---:|
| 0.50 | 3/12 | 0/4 | 0/10 | 0/4 | 25/25 | 0/216 |
| 0.53 | 5/12 | 0/4 | 0/10 | 0/4 | 25/25 | 8/216 |
| **0.55** | **6/12** | **0/4** | **0/10** | **0/4** | **25/25** | **14/216** |
| 0.56 | 9/12 | 0/4 | 0/10 | 0/4 | 24/25 | 16/216 |
| 0.57 | 12/12 | 0/4 | 0/10 | 0/4 | 24/25 | 21/216 |
| 0.60 | 12/12 | 0/4 | 0/10 | 0/4 | 23/25 | 49/216 |
| 0.65 | 12/12 | 1/4 | 0/10 | 3/4 | 12/25 | 138/216 |
| 0.70 | 12/12 | 1/4 | 4/10 | 3/4 | 8/25 | 184/216 |

- **The default is 0.55.** It is the highest floor that loses no expected-source excerpt. The
  lowest such excerpt scored 0.560 (M2, the client's `miniflux.py`). At 0.57 every off-topic
  probe is emptied, but that excerpt is lost.
- **The floor does not catch an in-domain question the sources can't answer.** The top cosine of
  the unanswerable questions (0.64 to 0.79) overlaps the answerable ones' (0.68 to 0.84). A floor
  high enough to empty them empties answerable questions too. Off-topic questions top out
  at 0.46 to 0.57. So the floor keeps unrelated text out of the prompt, and abstention on an
  in-domain question rests on the answering policy (`ANSWER_POLICY_SENTENCES`).
- **Retrieval misses the rule for most server questions.** S1, S3 and S4 had none of their
  expected files in the top 8. That is a reach problem (#2243), not a floor problem.

### With the floor and the answering policy (#2241), 2026-11-11

One run per arm (Sonnet 5.5 answers and judge), compared with run 2 above:

| | off, before | off, #2241 | on, before | on, #2241 |
|---|---:|---:|---:|---:|
| Correctness: mean facts stated | 29% | 22% | 49% | 48% |
| Fully correct answers | 0/10 | 0/10 | 2/10 | 2/10 |
| Citation precision | 30% (6/20) | 21% (4/19) | 83% (34/41) | 89% (50/56) |
| Abstention on unanswerable | 4/4 | 4/4 | 4/4 | 4/4 |
| Follow-up on ambiguous | 3/4 | **4/4** | 3/4 | **4/4** |
| False abstention on answerable | 5/10 | 7/10 | 4/10 | 4/10 |
| Right behaviour, single-product | 5/6 | 3/6 | 6/6 | 6/6 |
| Spend (answers + judge) | $0.309360 | $0.295650 | $0.488667 | $0.477220 |

- **A3 is now asked about in both arms.** Before, it was answered on an assumption.
- **With the flags off, chat now abstains where retrieval missed the rule.** S1, S3 and S4 said
  the sources don't show the answer. Their top 8 excerpts held none of the expected files. In run 2
  before #2241, S1 and S3 were answered from those same excerpts. With the code-search tools on,
  all six single-product questions were answered, and the only false abstentions are the four
  multi-product questions, which chat still runs unscoped (#2238).
- The #2241 runs spent $0.772870 across both arms. These are single runs, so a difference of one
  question is within run-to-run noise (compare runs 1 and 2 above).

### Routing multi-product chat (#2336), 2026-11-12: measured, not needed

Multi-product chat (#2238) searches every project in scope on every turn. #2336 asked whether
chat should first pick the likely projects and search only those, and asked for the
measurement first. `routing.json` beside `questions.json` is the routing set. It holds a pool
of nine products: the two Acme Reader products, then seven distractors from other eval corpora.
The distractors are the three fixture-portfolio repositories (`localization-02`: orders,
billing, notify) and the four synthetic requirement documents (`docunderstanding-01` to `-04`),
each its own project. Each product carries the one-line description, tags and names a project
admin would curate. It has 20 questions: the 10 answerable questions `questions.json` had then (S1 to S6, M1 to M4), whose
answer products are the products their expected sources name; 8 questions answered by one
product, 6 of them by a distractor; and 2 no product answers (a gibberish string, and "What is
the capital of France?"). Scopes are the first 2, 5 and 9 products of the pool.

```bash
pnpm eval:materialize baqa-01-acme-reader
pnpm eval:materialize localization-02-fixture-portfolio
pnpm eval:ba-qa --routing-sweep                                # $0: no model is called
pnpm eval:ba-qa --arm default --budget 1 --routing-scope 9 --route all   # all | routed | oracle
```

`--routing-sweep` gives the distractors their knowledge (the repositories' source chunks, and
an upload per document), then, for every question and scope, runs the offline router and
retrieves the way chat would (the federated search and the multi-product block) in four ways.
`all` is today's search-all. `routed` is the router's choice. `oracle` is exactly the answer's
products. `ranked` is every project's probe hits merged on cosine alone: a ranking
counterfactual, not a proposal (ranking is #2264's). `--routing-scope n --route r` asks the 10
answerable questions in a chat scoped to the first `n` products, retrieving `r`'s way, and
scores the answers as the other arms are. A session scoped to several products binds no single
project, so it gets no code-search tools: these answers rest on the 8 retrieved excerpts.

The router (`server/src/lib/eval/ba-qa/routing.ts`, offline only) ranks the projects on two
signals. The profile signal is the share of the question's words that a project's names,
description and tags hold. The evidence signal comes from a probe search per project and counts
only hits the keyword retriever matched, each question word weighted by how few projects hold
it. A dense search returns neighbours for any text, so a floor on vector scores never trips. A
product the question names is always chosen. The router falls back to every project when no
project has keyword evidence, when the best score is below 0.25, or when the two signals point
at different projects.

**Is the right project in the router's top k** (answerable questions in scope; top k counts only
the questions answered in at most k products, #2397):

| Scope | Top 1 | Top 2 | Top 3 | Top 1 / 2 / 3, product names ignored | Routed choice holds the answer | Projects searched (mean) |
|---:|---:|---:|---:|---|---:|---:|
| 2 | 8/8 | 12/12 | 12/12 | 5/8, 12/12, 12/12 | 12/12 | 2.0 |
| 5 | 11/11 | 15/15 | 15/15 | 8/11, 15/15, 15/15 | 15/15 | 2.5 |
| 9 | 14/14 | 17/18 | 18/18 | 11/14, 17/18, 18/18 | 17/17 (1 fell back) | 2.9 |

M1 to M4 are answered in both Acme Reader products, so no ranking can put them in the top 1.
The table first printed top 1 over every answerable question (8/12, 11/15, 14/18), which read
as 4 misses that were never possible hits; the counts are unchanged, only their denominator.
`--routing-sweep` prints the top 1 this way from #2397 on.

The gibberish question fell back at every scope. The France question was routed to the
Miniflux server, whose test data and code comments hold "France" and "capital".

**What reaches the prompt** (offline, the same questions; time is warm, in-process):

| Scope | Way | Projects searched | Excerpts from an answer product | Expected files retrieved | Mean ms |
|---:|---|---:|---:|---:|---:|
| 2 | all | 2.0 | 67% (64/96) | 9/32 | 151 |
| 2 | oracle | 1.3 | 100% (96/96) | 11/32 | 109 |
| 5 | all | 5.0 | 43% (51/120) | 8/32 | 251 |
| 5 | ranked | 5.0 | 63% (76/120) | 8/32 | 247 |
| 5 | routed | 2.5 | 58% (70/120) | 9/32 | 411 |
| 9 | all | 9.0 | **31% (44/144)** | **4/32** | 181 |
| 9 | ranked | 9.0 | 68% (98/144) | 8/32 | 199 |
| 9 | routed | 2.9 | 61% (88/144) | 8/32 | 296 |
| 9 | oracle | 1.2 | 100% (141/141) | 11/32 | 64 |

The multi-product block held 11,300 to 12,200 characters in every row: it carries 8 excerpts,
whatever the number of projects. `routed` time includes the probe.

**Answers** (Sonnet 5.5 answers and judge, the 10 answerable questions, one run per column,
two for routed):

| | 2, all | 5, all | 9, all | 9, routed | 9, oracle |
|---|---:|---:|---:|---:|---:|
| Correctness: mean facts stated | 33% | 30% | **17%** | 42%, 35% | 44% |
| Citation precision | 40% (10/25) | 42% (8/19) | 29% (5/17) | 36% (9/25), 39% (9/23) | 39% (12/31) |
| Citation recall | 10/32 | 8/32 | 5/32 | 9/32, 9/32 | 12/32 |
| False abstention on answerable | 4/10 | 5/10 | 6/10 | 4/10, 4/10 | 2/10 |
| Input tokens per question | 4,950 | 4,788 | 4,489 | 4,882, 4,882 | 5,414 |
| Seconds per question (judge included) | 10.4 | 10.8 | 10.2 | 11.1, 10.4 | 10.9 |
| Retrieval ms per question | 1,165 | 1,202 | 1,505 | 1,008 (probe included) | 1,124 |

Seconds per question timed the whole question, the judge's Sonnet call included; from #2397
the report gives seconds per answer, with the judge left out. The first routed run timed
retrieval without its probe, so only the second run's time is given. The runs cost **$1.566**
(answers and judge), including a scope-5 run whose results were lost to a bad `--include` path
and run again.

**Retrieval time: two measurements that disagree (#2397).** At nine products the offline sweep
read 181 ms for search-all against 296 ms routed, probe included. The paid runs read the
opposite, 1,505 ms against 1,008 ms, and three to eight times slower. Both time the same calls:
the federated search for search-all, and the probe plus the federated search of the chosen
projects for routed. Why the paid runs were slower and reversed is not established. Each column
is one run of 10 questions, its per-question timings were not kept, and its search ran in its
own process after 10 s of model calls, where the sweep runs the probe and the three searches
back to back. The later paid runs on the #2264 corpus below kept their per-question timings
(`readings/ba-qa/2264-scope9-*.json`). They read 96 and 107 ms for search-all against 181 ms
routed, the sweep's order, and every routed question took longer than both search-all runs of
the same question (153 to 214 ms against 78 to 135 ms). Those runs also embed each query once
per call (#2279), where the 2026-11-12 runs embedded it once per project, so the absolute
times are not comparable across the two dates; the order is. The 1,008 ms is one cold sample,
and it did not reproduce.

**Decision: no-go. #2336 is closed as measured-not-needed, and the accuracy loss goes to #2264.**

- **Cost does not call for routing.** Input tokens and latency stay flat from 2 to 9 projects:
  the block holds 8 excerpts whatever the scope, the parallel per-project search takes 0.2 s
  warm, and a question takes 10 s, the judge's call included. Routing did not improve either.
  Routed input tokens read 4,882 against search-all's 4,489. Routed retrieval read faster in one
  paid run (1,008 against 1,505 ms) and slower in the sweep and in every later paid run (see
  "Retrieval time" above), because its probe is a search of every project in scope, made
  before the search it narrows. Part B's own bar for turning it on ("tokens or latency
  improve") could not be met.
- **Search-all does lose accuracy as projects are added, but routing is not the fix.** From 2
  to 9 projects, the share of excerpts from an answer product falls from 67% to 31%, the
  expected files retrieved from 9 to 4 of 32, and the facts stated from 33% to 17%. The cause
  is the merge: `fuseByRelevance` keeps every project within 0.75 of the best project's
  relevance and hands each one an equal turn at the 8 slots. Merging the same per-project hits
  on cosine alone (`ranked`) keeps as many expected files as the router (8/32) and more
  excerpts from the answer's products (68% against 61%), with no extra search and no new
  per-project data to curate. That is #2264's change (sort kept projects by relevance), with
  #2294's absolute floor beside it. Routing would add a probe, a confidence floor, a
  description and tags to keep current on every project, and a silent-narrowing risk, to get
  what ranking gets alone.
- **The product mention does most of the router's work.** Most questions in the set name
  their product the way an analyst does ("the Acme Reader server"). With the names ignored,
  top 1 drops to 11 of 14 at nine projects (the 14 answered in one product). The keyword
  evidence alone separates the two Acme Reader products poorly: both hold most words of a
  question about either.
- These are single runs of 10 questions. The two routed runs, with identical retrieval,
  differ by 7 points of facts stated, so differences under about 10 points are noise. The
  fall at 9 projects (33% to 17%) and the recovery (35–44%) are larger than that, and the
  retrieval counts, which carry no model noise, show the same thing.

**After #2264 (2026-11-13, `--routing-sweep`, $0).** #2264 replaced the equal turns with a
merge on relevance (`fuseByRelevance`, `share: "relevance"`). The same sweep, on the branch,
on a freshly materialized corpus. The `ranked` counterfactual reads exactly as before (68%,
8/32 at 9), so the corpus and probes match the run above:

| Scope | Way | Excerpts from an answer product, before → after | Expected files retrieved, before → after |
|---:|---|---:|---:|
| 2 | all | 67% → 73% (70/96) | 9/32 → 9/32 |
| 5 | all | 43% → 67% (80/120) | 8/32 → 9/32 |
| 9 | all | **31% → 70% (101/144)** | **4/32 → 9/32** |
| 9 | routed | 61% → 77% (111/144) | 8/32 → 9/32 |
| 9 | oracle | 100% → 100% (138/138) | 11/32 → 12/32 |

Search-all at nine products now retrieves as many expected files as routing (9/32), and more
than the cosine-only counterfactual, so the retrieval loss #2336 measured is recovered.

**After #2264's review fixes (2026-11-13, answers paid).** Re-measured at the PR's final
merge rule (on the cosine scale a project's slots follow each hit's own cosine, and the project
fills them in its own order) on a newly materialized corpus. The `--routing-sweep` ($0, at
`e6676d50`) reads 69% (100/144) and 8/32 for `all` at nine products, against 74% (107/144) and
8/32 for `routed`. `ranked` reads 7/32 here, against 8/32 above, so this corpus is not the
earlier one. That is why the answers were measured again for both ways on it, at `e8ce629b`
(Sonnet 5.5 answers and judge, the 10 answerable questions; readings in `readings/ba-qa/`):

| | 9, all (before #2264) | 9, all | 9, all (again) | 9, routed |
|---|---:|---:|---:|---:|
| Correctness: mean facts stated | 17% | 23% | 23% | 28% |
| Citation precision | 29% (5/17) | 37% (10/27) | 38% (10/26) | 35% (9/26) |
| Citation recall | 5/32 | 10/32 | 10/32 | 9/32 |
| False abstention on answerable | 6/10 | 5/10 | 5/10 | 6/10 |
| Input tokens per question | 4,489 | 5,832 | 5,832 | 5,535 |
| Spend (answers + judge) | | $0.275918 | $0.135486 | $0.271591 |

On the same corpus, search-all is within 5 points of routed on facts stated, which is under the
roughly 10 points two identical runs differed by above. It cites more expected files than
routed and abstains no more often. Both sit below the 2026-11-12 routed figures (35–42%), but
routed itself reads 28% on this corpus, so that difference is the corpus and the run, not the
merge. Search-all is within reach of routed, so #2336 stays closed. The three runs cost $0.682995 (the repeat run read prompt-cache
hits, hence its lower cost).

### Secret redaction in repository source (#2333), 2026-11-12

#2333 redacts secrets in repository files before they are indexed, stored in the code graph or
read by `read_file_slice`. Both evals were run before it (on `main` at `0dac6304`) and after it
(on the PR branch), each on a freshly materialized corpus, on `claude-sonnet-5-5` for answers and
judge. One run per arm.

**What redaction changed in the corpora.** In the BA-QA knowledge step, 7 Miniflux source files
were redacted and none of the python-client's: the `.devcontainer` and three `contrib`
docker-compose files (`ADMIN_PASSWORD=test123` and a `postgres://…:…@` URL),
`contrib/thunder_client/collection.json` (a `"password": "test123"`), `client/client_test.go`
(`Token: "token2"`) and `internal/config/options_parsing_test.go` (three database URLs).
`questions.json` cites none of them as an expected source. In the localization corpora's
3,573 committed symbol texts, one is redacted (`miniflux#00023`, the same `client_test.go`
literal); A0 reads the committed rows and is not affected.

| BA-QA | off, before | off, after | on, before | on, after |
|---|---:|---:|---:|---:|
| Correctness: mean facts stated | 27% | 27% | 45% | 45% |
| Fully correct answers | 0/10 | 0/10 | 1/10 | 2/10 |
| Citation precision | 31% (5/16) | 33% (5/15) | 89% (47/53) | 90% (37/41) |
| Citation recall | 16% (5/32) | 16% (5/32) | 25% (8/32) | 28% (9/32) |
| Abstention on unanswerable | 4/4 | 4/4 | 4/4 | 4/4 |
| Follow-up on ambiguous | 4/4 | 4/4 | 4/4 | 4/4 |
| False abstention on answerable | 6/10 | 6/10 | 4/10 | 4/10 |
| Right behaviour, single-product | 4/6 | 4/6 | 6/6 | 6/6 |
| Spend (answers + judge) | $0.296865 | $0.298324 | $0.522035 | $0.475595 |

- **No regression.** Every question got the same behaviour (answer, abstain, follow-up) in both
  arms before and after. With the flags off every question stated the same number of facts. With
  them on, S3 stated one fact fewer and S5 one more, and S2 cited one more expected file: the
  run-to-run spread of the baseline runs above. No `[REDACTED:` marker appears in any answer.
- **Localization A0** (`--arms A0 --runs 1`, $0): Miniflux R@5 0.52, R@10 0.60, edit precision
  0.17, MRR 0.55; fixture portfolio R@5 0.54, R@10 1.00, edit precision 0.21, MRR 0.54, before
  and after. The per-corpus and pooled reports are identical apart from run ids and times.
- **The `--floor-sweep` retrieval ($0)** kept every expected-source excerpt at the default 0.55
  floor before and after (27/27), and every question's count of expected files in its top 8 was
  the same. The rest of the top 8 moved: 24 of 39 question-product lists differ in membership or
  order. That is index-rebuild noise, not redaction. A second baseline, re-materialized and
  re-ingested from scratch on the same `main` code, differs from the first in 25 of 39 lists and
  from the branch in 22. No redacted file appears in any list that changed.
- **Spend:** $1.592819 in all, the four BA-QA runs above. Localization A0 calls no model.

### Index status (#2326), 2026-11-12

`--index-fault failed|partial` records every product's last indexing run as failed (an embedding
timeout) or partial (200 of 500 eligible files, 300 past the file limit) for one run, and
restores the record afterwards. The indexed content is left as it is, so the arms differ only in
what the model is told. `CHAT_INDEX_STATUS` controls that: when the index is unhealthy, a status
line leads the retrieved-knowledge block, and `get_index_status` is offered. The scorer
(`server/src/lib/eval/ba-qa/index-fault.ts`, `mentionsIndexProblem`) counts the answers that say
the index failed, is partial or is incomplete. These were Sonnet 5.5 runs on the `tools-only`
arm, using the nine single-product questions:

```bash
CHAT_INDEX_STATUS=0 pnpm eval:ba-qa --arm tools-only --budget 2 --index-fault failed --questions S1,S2,S3,S4,S5,S6,A3,U3,U4
CHAT_INDEX_STATUS=1 pnpm eval:ba-qa --arm tools-only --budget 2 --index-fault failed --questions S1,S2,S3,S4,S5,S6,A3,U3,U4
```

| | failed, before | failed, after | partial, before | partial, after |
|---|---:|---:|---:|---:|
| Answers that state the index problem | 0/9 | **7/9** | 0/9 | **8/9** |
| Abstentions that assert absence without it | 2/2 | 2/2 | 2/2 | **0/2** |
| Correctness: mean facts stated | 86% | 80% | 84% | 76% |
| Citation precision | 84% (38/45) | 81% (29/36) | 88% (36/41) | 82% (31/38) |
| Abstention on unanswerable / false abstention | 2/2, 0/6 | 2/2, 0/6 | 2/2, 0/6 | 2/2, 0/6 |
| Input tokens / question | 31,300 | 25,500 | 26,900 | 26,100 |

- **Without the status, no answer mentioned the index.** That held in both faults, because the
  model had no way to know about it. With the status on, 7 and 8 of 9 answers said the index was
  failed or partial. In the partial run, both abstentions on unanswerable questions (U3 uptime
  promise, U4 download counts) named the partial index instead of only asserting absence. In the
  failed run they did not. The answer to both of those questions really is outside the code, so
  asserting absence there is not wrong.
- **Facts stated and precision fell by 3 to 8 points with the status on.** That is within the
  run-to-run spread on this set: two runs of the same arm differed by 7 points in #2324's
  measurement. The status line is only added when the index is unhealthy, so a healthy project's
  prompt is unchanged. `CHAT_INDEX_STATUS` is **on by default**.
- The status line costs about 80 tokens per turn when it is shown. The four runs spent $1.445313,
  answers and judge.

### Multi-turn questions (#2269)

`questions.json` also holds 8 multi-turn questions, `F1` to `F8`, which measure #2240's
conversation-aware retrieval. Each one carries `before`, the analyst's earlier turn. That turn
is asked and answered live in the same session, and recorded in the transcript the way the chat
routes record it, including the excerpts the answer cited. Only the last turn is graded, and the
judge is shown the earlier turn.

`refersBack` labels each graded turn. Six turns lean on the earlier one: "I meant the login
sessions.", "How often does that run?", "And when a user changes them later?", "Can I change its
request timeout?", "How many feeds does it refresh at a time?" and "Which exception do I get when
its API key is wrong?". Two are self-contained controls asked mid-conversation. F6 is S2's
question after S1. F7 is a "there" question that names its own subject. All 8 are
single-product, so retrieval runs.

```bash
pnpm eval:ba-qa --arm off --budget 2 --multi-turn                            # production (#2240)
pnpm eval:ba-qa --arm off --budget 2 --multi-turn --retrieval last-message \
  --include eval-results/ba-qa/<conversation run>.json                       # the new message alone
```

`--multi-turn` selects the set. Without it a run asks the 18 one-turn questions, as before.
`--retrieval last-message` searches only the new message, as chat did before #2240. The report
labels that arm `off+last-message`. In either mode, the graded turn is also searched the other
way, locally and at no model cost. The **Multi-turn retrieval** table therefore shows, for both
modes, how many expected source files the excerpts held. It also shows how many labelled
follow-ups the planner caught, how many controls it misread, and how many cited excerpts were
carried forward.

#### Measured 2026-11-11 (Sonnet 5.5 answers and judge, 8 questions per arm)

| | off | off+last-message | on | on+last-message |
|---|---:|---:|---:|---:|
| Correctness: mean facts stated | 55% | 55% | 98% | 98% |
| Fully correct answers | 4/8 | 4/8 | 7/8 | 7/8 |
| Citation recall | 7/20 | 7/20 | 14/20 | 13/20 |
| Expected files in the excerpts: conversation-aware | 7/20 | 8/20 | 7/20 | 6/20 |
| … new message alone | 7/20 | 7/20 | 5/20 | 5/20 |
| Follow-ups the planner caught | 4/6 | 4/6 | 4/6 | 4/6 |
| Controls read as follow-ups | 0/2 | 0/2 | 0/2 | 0/2 |
| Spend (answers + judge) | $0.500310 | $0.341409 | $0.917685 | $0.717946 |

The `off` and `on` columns were run after the tuning below. The `+last-message` columns were run
before it, and the tuning does not change their retrieval.

- **Retrieval reading the conversation finds slightly more, and answers are no better on this
  set.** In the two runs after the tuning (`off`, `on`), the conversation-aware excerpts held 14
  expected files and the new message alone held 12. The two runs before it (`+last-message`)
  gave the same 14 and 12. The tuning changes only which excerpts are carried forward, so it can
  move the conversation-aware count and not the other. A total over all four runs (28 and 24)
  mixes measurements from before and after the tuning (#2316). F1 ("I meant the login
  sessions.") gained `internal/ui/auth.go` from the conversational search. F7 gained a file
  through carry-forward. F2 ("How often does that run?") lost `internal/cli/scheduler.go`, which
  was the user's own 8th hit, to two hits found only by the conversational search. Since #2316
  such hits are added among the user's own 8, at most 3 and only where they rank above its 8th,
  rather than swapped in for its last ones, so the user's 8 always stay (a test pins F2's
  shape). This has not been re-measured with a model. Correctness was the same in both modes.
  With the flags on, the code-search tools find what retrieval missed either way.
- **The follow-up heuristic is unchanged.** It read no control as a follow-up, F7's "there"
  question included. It missed F5 and F8, which name four content words each. Searching those
  two as follow-ups was measured to find no expected file that their own words missed. Raising
  the content-word cap to four would catch them, but it would also re-admit "Are there any GDPR
  requirements in the onboarding spec?". A test pins this: every labelled turn in the set is
  read as measured.
- **Carry-forward read the wrong excerpts, and was tuned.** With the flags off, the answers named
  excerpts as "`file` (chunk #N)". 13 of the 16 earlier answers that cited anything did so, and
  none used `[n]`. Only the file name matched, so the 4-excerpt cap filled with the file's first
  excerpts in block order. `citedExcerptIds` now reads "`file` (chunk #N)", "chunks #A, #B and
  #C" and "chunks #A-#B" as locators. It fills the cap with numbered and located excerpts before
  whole-file matches, and it no longer reads `file#1` inside `file#18`. Replayed on the recorded
  first answers, the excerpts the answers pointed at rose from 27 to 31 of the 33 that fit the
  cap.
- **Spend varies from run to run.** The same question's answer cost $0.022 in one run and
  $0.054 in the next (F2, `off`). So the spend gap between the modes is within run-to-run noise.

Spend for #2269: **$3.830035** over seven runs. That is a one-question smoke run ($0.055899),
the four runs before tuning ($0.458762, $0.341409, $0.838024 and $0.717946), and the two
conversation-aware runs after tuning ($0.500310 and $0.917685).

### Search guidance (#2324), 2026-11-12

`CHAT_SEARCH_GUIDANCE` adds three things: a prompt block on how to search, sharper descriptions
on the four grounding tools, and a fixed instruction after each grounding result. It was
measured on the `tools-only` arm, which is how chat ships. The runs used the nine
single-product questions (S1 to S6, A3, U3, U4), with Sonnet 5.5 answers and judge, in two
paired runs. Each pair ran without the guidance first, then with it:

```bash
CHAT_SEARCH_GUIDANCE=0 pnpm eval:ba-qa --arm tools-only --budget 2 --questions S1,S2,S3,S4,S5,S6,A3,U3,U4
CHAT_SEARCH_GUIDANCE=1 pnpm eval:ba-qa --arm tools-only --budget 2 --questions S1,S2,S3,S4,S5,S6,A3,U3,U4
```

| | without, run 1 | with, run 1 | without, run 2 | with, run 2 |
|---|---:|---:|---:|---:|
| Correctness: mean facts stated | 83% | 83% | 76% | 76% |
| Fully correct answers | 2/6 | 3/6 | 1/6 | 1/5 |
| Citation precision | 88% (36/41) | 80% (33/41) | 84% (38/45) | 81% (30/37) |
| Citation recall (expected files cited) | 10/15 | 10/15 | 10/15 | 8/13 |
| Right behaviour, single-product | 6/6 | 6/6 | 6/6 | 5/5 |
| Input tokens / question | 28,100 | 37,500 | 21,700 | 30,900 |
| Model calls / question | 2.89 | 3.44 | 2.56 | 3.11 |

- **Facts stated did not move, and citation precision fell in both pairs**, by 8 and 3 points.
  Between the two runs without the guidance, precision varied by 4 points. The issue lets the
  guidance ship on only if facts stated or citation precision improves and neither gets worse,
  so `CHAT_SEARCH_GUIDANCE` is **off by default**.
- **It costs about 9,000 more input tokens and 0.55 more model calls per question.** The prompt
  block and the four descriptions add about 570 tokens to the cached lead. The rest comes from
  the extra searches the model runs: 36 tool calls in the first run with the guidance, against
  32 without.
- In the second run with the guidance, the judge's reply for S5 could not be read, so that run
  is scored on five answerable questions.
- Dollar spend is not compared, for the reason given in the #2243 section: each run reads the
  prompt cache of the run before it. The four runs spent $1.452168 in total, answers and judge.

### Search guidance re-measured after the not-a-miss fix (#2390), 2026-11-12

#2390 gives a `search_code_graph` result that counts 0 but is not a miss its own instruction:
a name that matches several symbols, probable call sites only, or a found symbol with no call
edges. Before the fix, all three got "nothing was found; search again". The measurement was
re-run with the same commands, questions, arm and model (Sonnet 5.5 answers and judge), in two
paired runs on a fresh materialization. Each pair ran without the guidance first, then with it.
Since #2325, the report splits citation precision into citations with line spans (judged on
the span) and files named without lines (judged by file), so both are shown, with their sum.

| | without, run 1 | with, run 1 | without, run 2 | with, run 2 |
|---|---:|---:|---:|---:|
| Correctness: mean facts stated | 81% | 76% | 80% | 80% |
| Fully correct answers | 2/5 | 1/5 | 2/6 | 2/6 |
| Citation precision, line spans | 100% (42/42) | 100% (36/36) | 98% (39/40) | 100% (42/42) |
| Citation precision, files without lines | 17% (1/6) | 0% (0/3) | 22% (2/9) | 0% (0/9) |
| Citation precision, both | 90% (43/48) | 92% (36/39) | 84% (41/49) | 82% (42/51) |
| Citation recall (expected files cited) | 8/13 | 6/11 | 10/15 | 9/15 |
| Right behaviour, single-product | 5/5 | 5/5 | 6/6 | 6/6 |
| Input tokens / question | 40,900 | 35,800 | 37,800 | 38,900 |
| Model calls / question | 3.22 | 3.11 | 3.11 | 3.44 |
| Tool calls, all nine questions | 44 | 35 | 39 | 38 |

- **Facts stated did not move.** Each question that both runs of a pair scored got the same
  count of facts in both. Run 1's means differ only because the judge's reply could not be
  read for a different question in each arm (S5 without the guidance, S3 with it).
- **Citation precision did not improve.** Precision on cited line spans was 100% in three runs
  and 98% in the fourth, so it has no room to rise. Over all citations, the guidance was 2
  points better in one pair and 2 points worse in the other, inside the 4-point spread between
  the two runs without it. Recall was 1 or 2 files lower with the guidance in both pairs.
- **So `CHAT_SEARCH_GUIDANCE` stays off by default**, by the issue's rule: turn it on only if
  facts stated or citation precision improves and neither gets worse.
- Unlike #2324's runs, the guidance added no input tokens on average: 5,100 fewer per question
  in one pair and 1,100 more in the other. These runs do not record the text of tool results, so
  they cannot show how many results got the new instructions.
- The four runs spent $1.662181 in total, answers and judge.

### Citation contract (#2325) and facts stated, re-measured (#2403), 2026-11-13

#2325's PR (#2400) puts a version line, and on a read a stale or paging line, at the top of
every chat code and knowledge tool result. Its two paired runs on all 23 questions read facts
stated at 55% and 63% before and 54% and 51% after (means 59% and 52.5%), and tool results cut
by the model cap (`CHAT_TOOL_RESULT_MAX_TOKENS`, default 2,000 tokens) rose from 1.5 to 4.5 per
run. #2403 ran three more pairs to settle whether facts stated dropped.

The code measured is pinned, not `main`: **before** is `9f911c5` (`main` just before #2400
merged; the PR's own "before" was `0cd9b02`, and the one commit between them changes UI copy
and a connector status string), **after** is `6dcf577` (#2400's merge commit). #2401
(`search_code_context`) is not in either: it is off by default and the `tools-only` arm does not
turn it on, so it cannot move this arm. One materialization served all six runs (#2400 has no
migration). The worktree was switched between the commits, with `@metis/shared` rebuilt each
time, and the runs alternated before, after, before, after, before, after:

```bash
pnpm eval:ba-qa --arm tools-only --budget 2      # 23 questions, Sonnet 5.5 answers and judge
```

| | before 3 | before 4 | before 5 | after 3 | after 4 | after 5 |
|---|---:|---:|---:|---:|---:|---:|
| Correctness: mean facts stated | 53% | 56% | 57% | 52% | 57% | 56% |
| Fully correct answers | 2/15 | 5/15 | 6/15 | 3/15 | 4/15 | 4/15 |
| Citation precision, line spans | 100% (80/80) | 100% (78/78) | 100% (79/79) | 100% (78/78) | 99% (78/79) | 100% (91/91) |
| Citation precision, files without lines | 38% (5/13) | 25% (2/8) | 44% (4/9) | 22% (2/9) | 25% (3/12) | 25% (3/12) |
| Citation recall (expected files cited) | 19/47 | 18/47 | 19/47 | 20/47 | 20/47 | 18/47 |
| False abstention on answerable | 4/15 | 3/15 | 4/15 | 4/15 | 4/15 | 4/15 |
| Tool calls, all 23 questions | 74 | 79 | 85 | 71 | 80 | 71 |
| Tool results cut by the model cap | 4 in 3 sessions | 2 in 2 | 0 | 2 in 2 | 3 in 2 | 5 in 4 |
| Spend | $0.768911 | $0.634932 | $0.656414 | $0.622608 | $0.720870 | $0.639871 |

With #2400's two pairs, five runs a side:

| | before (5 runs) | after (5 runs) |
|---|---:|---:|
| Mean facts stated, each run | 55, 63, 53, 56, 57 | 54, 51, 52, 57, 56 |
| Mean of the runs | 56.8% | 54.0% |
| Citation precision, line spans, pooled | 99.0% (389/393) | 99.1% (424/428) |
| Tool results cut by the model cap, each run | 2, 1, 4, 2, 0 (1.8 a run) | 5, 4, 2, 3, 5 (3.8 a run) |

**No drop in facts stated was detected.** Per question, over the three new pairs (each question's mean
over its three runs, after minus before):

| Question | Facts | Before, each run | After, each run | After − before |
|---|---:|---|---|---:|
| S1 | 6 | 4, 3, 3 | 3, 4, 3 | 0 |
| S2 | 5 | 4, 5, 5 | 5, 5, 4 | 0 |
| S3 | 4 | 4, 4, 4 | 3, 4, 4 | −8 pts |
| S4, S6, S9 | 3, 4, 3 | the same in all six runs | | 0 |
| S5 | 4 | 3, 3, 4 | 3, 3, 3 | −8 pts |
| S7 | 3 | 2, 3, 3 | 2, 3, 3 | 0 |
| S8 | 3 | 2, 3, 3 | 3, 2, 3 | 0 |
| S10 | 3 | 1, 0, 1 | 1, 2, 1 | +22 pts |
| S11 | 3 | 2, 2, 1 | 1, 1, 2 | −11 pts |
| M1 to M4 | 7, 2, 3, 2 | 0 in all six runs: chat asks or abstains, unscoped | | 0 |

- M1 to M4 are structural zeros: chat abstains on all four in every run, so they score 0 on
  both sides and could not have moved. Of the 11 questions chat actually answered (S1 to S11),
  7 held, 3 fell by one fact in one run of three (S3, S5, S11), and 1 (S10) rose. Over those
  11 the mean per-question difference is **−0.5 points** (sd 8.7, t −0.2). Counting the four
  zeros too (n 15) it is **−0.4 points** (after minus before; sd 7.3, t −0.2), pulled toward 0
  by them. An exact sign-flip test on the four questions that moved gives p = 1.0.
- Over five runs a side, the run means differ by 2.8 points (56.8% against 54.0%). That is
  less than the 10-point spread among the five "before" runs, and nearly all of it comes from
  the first pair's 63%. Welch's t on the run means is about 1.4 (p about 0.2).
- Not significant means no drop was detected, not that there was none. A 95% interval on the
  run-mean difference (before minus after, Welch) runs from about −1.9 to +7.5 points, so a
  drop of several points is not ruled out; the per-question interval is about ±4 points at n 15 and about ±5.8 at n 11.
- Citation precision on line spans held: 99.0% before and 99.1% after, pooled.

**The cap cuts are real, and there is no sign that they cost facts.** Cuts about doubled (1.8
to 3.8 a run over five runs a side), consistent with the headers taking room at the top of a
result. They fall on the questions that make the model read deeply (S1, S4, S7, S8, S10). On the
same question, a session with a cut scored no worse than one without on four of the five
questions that had one: S4 all 3/3 either way; S8 the same mean; S1 and S10 higher with a cut
(S10 42% against 17%); S7 one fact lower in one cut session. This comparison is weak: each
question has only one to four cut sessions, and it is confounded with the arm (3 of the 4 cut
S10 sessions are after-runs, and the after side scored higher on S10), so the S10 gain cannot be
credited to the cut. So the headers were not trimmed and the default cap was not raised: the
issue asked for either only if facts stated dropped.

The per-question scores of the six runs (no transcripts) are in
`readings/ba-qa/2403-citation-contract-paired.json`. #2400's two pairs recorded no per-question
file, so the per-question view covers the three new pairs only. Spend for #2403: **$4.389305**,
the six runs ($4.043606) and one six-question smoke run before them ($0.345699); the knowledge
ingest went through `--floor-sweep`, which asks no model.
