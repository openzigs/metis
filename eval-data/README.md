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
| `A3N` (A3-nograph) | `list_files`, `read_file_slice` and the eval-only `grep_files`; no seeded blocks | the cited files alone |

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
  5,000 files. The file cap counts only files inside the `pathContains` scope, and it never
  descends into a symlinked directory. A search the cap cut short says so.
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

Three synthetic Word business documents, each larger than the 10 chunks (about 20 KB)
today's document agent reads, with every requirement and every ambiguity a business
analyst would want raised labelled against a source span. They are the Phase 0
baseline of epic #2227: do not change a reader's default until this corpus shows the
change is a gain.

| Corpus | Kind | Word file | Converted text | Sections | Requirements | Ambiguities |
|---|---|---|---|---|---|---|
| `docunderstanding-01-clinic-booking` | FRD | 18 KB | 22,129 chars | 26 | 46 | 11 |
| `docunderstanding-02-freight-claims` | BRD | 18 KB | 23,478 chars | 36 | 58 | 12 |
| `docunderstanding-03-community-grants` | FRD | 22 KB | 35,075 chars | 53 | 102 | 14 |

Each item holds `frd.src.md` (the authored document, labels marked inline as
`[[R12 ...]]` and `[[A3 ...]]` with an ambiguity trailer; see
`server/src/lib/eval/doc-understanding/corpus-source.ts`), `source.docx` (built from
it: what every arm reads, through production's `parseDocument`) and `labels.json`
(built from it). The ambiguities are of six kinds: vague terms, undefined terms,
escape clauses, contradictions (several of them between distant sections, and one
between a summary table and the body), gaps the document is silent on, and decisions
it leaves open.

**Labels are author-labelled and not yet reviewed by a second person**
(`labelStatus` in each `labels.json`): the same author wrote the document and its
labels. A reviewer who disagrees with a label edits `frd.src.md` and rebuilds.

```bash
pnpm --filter server eval:doc-understanding:build            # after editing a frd.src.md; commit all three files
pnpm --filter server eval:doc-understanding:build --check    # labels.json up to date?
pnpm --filter server eval:doc-understanding                  # arms A,B,C over all three, 1 run, $10 cap
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
1.1.6, MIT). `questions.json` holds 18 questions in four categories, and the category fixes
what a good reply does:

| Category | Questions | A good reply |
|---|---:|---|
| `single-product`: "how does rule X work in product Y" | 6 | answers; carries facts and expected code and doc sources |
| `multi-product`: "what does FRD-12 change in A and B" | 4 | answers from both products and `frd-12.md`; carries facts, expected requirements and the files an impact analysis should name |
| `ambiguous` | 4 | asks a follow-up question |
| `unanswerable` | 4 | says the sources don't show this |

Every fact and line range was read from the pinned commits by the agent that wrote the
set. No person has reviewed them yet (`authoredBy`). `frd-12.md` is a synthetic CC0
FRD with two requirements, uploaded to both products.

```bash
pnpm eval:materialize baqa-01-acme-reader     # clones, projects, code graph, symbol vectors ($0)
pnpm eval:ba-qa --arm off --budget 5          # today's chat: the three flags unset
pnpm eval:ba-qa --arm on --budget 5 --include eval-results/ba-qa/<off run>.json
```

Before its first question, `eval:ba-qa` gives each product what an analyst's project holds.
It runs the connector's README and manifest ingest and its repository-source ingest, then
uploads the corpus documents (the man page and FRD-12) and approves them out of quarantine.
The step can be re-run: an unchanged, indexed file is skipped. The first run embeds about
2,800 chunks on the local embedder, which takes several minutes on an idle machine.

Each question is its own one-turn chat session, run through production's chat pieces as in
`eval:chat-cache`. A question scoped to both products is asked the way chat takes it today,
as an unscoped session with no retrieval (`chatSessionScope`, mirroring
`server/src/routes/ai.ts`). The `off` arm unsets `CHAT_CODE_SEARCH_TOOLS`,
`CHAT_FUSED_CODE_RETRIEVAL` and `RAG_RERANK` even when the shell or `.env` sets them. The `on`
arm sets all three, and runs the embedder inline so the reranker can share the main thread
(#222). On macOS the `on` arm can abort with `libc++abi: … mutex lock failed` as it exits.
That is onnxruntime-node shutting down after the results are written, and the files are
complete.

One judge call per answer returns verdicts only. It gives the reply's behaviour, whether each
fact is stated, contradicted or missing, and whether each cited span supports its claim.
Every number below is computed from those verdicts in code (`server/src/lib/eval/ba-qa/`):

- **Correctness**: the mean share of facts stated, and "fully correct" when every fact is
  stated and none is contradicted.
- **Citation precision**: supporting citations over all citations. A citation with lines is
  judged against that span's text. One without lines is counted as supporting only when its
  file is an expected source. Lines that are not in the file support nothing.
- **Citation recall**: the expected source files an answer cites.
- **Abstention, follow-up and confident-guess rates**, plus false abstention and unneeded
  follow-ups on answerable questions.
- **Spend**: the answers and the judge, apart, priced by the ledger.

A judge reply that cannot be parsed leaves the question unscored, never scored as zero.

### Baseline, 2026-11-10 (Sonnet 5.5 answers and judge, 18 questions per arm)

| | off (today) | on (three flags) |
|---|---:|---:|
| Sessions chat left unscoped (no retrieval) | 9/18 | 9/18 |
| Correctness: mean facts stated | 27% | 48% |
| Fully correct answers | 0/10 | 2/10 |
| Citation precision | 33% (6/18) | 89% (42/47) |
| … checked against the span | 0/18 | 44/47 |
| Citation recall | 19% (6/32) | 28% (9/32) |
| Abstention on unanswerable | 4/4 | 4/4 |
| Follow-up on ambiguous | 3/4 | 3/4 |
| False abstention on answerable | 6/10 | 4/10 |
| Right behaviour, single-product | 4/6 | 6/6 |
| Right behaviour, multi-product | 0/4 | 0/4 |
| Spend (answers + judge) | $0.303841 | $0.492134 |

- **Every multi-product question abstained in both arms.** Chat drops a two-product scope to
  an unscoped session, so it retrieved nothing and offered no project tools. M1 to M4 scored
  0 facts.
- **The `off` arm never cites a line.** The auto-RAG excerpts carry no line numbers, so the
  model cites files by name only, and no citation could be checked against a span. With
  fused code retrieval on, 44 of 47 citations carried lines that could be checked, and 42
  supported their claim.
- **Two single-product rule questions abstained with the flags off** (S3, S4): the 8 chunks
  retrieved held no default value or validation rule. With the code-search tools on, both
  were answered in full.
- **Several follow-ups and abstentions came from having nothing.** Three of the four
  follow-ups, and two of the four abstentions on unanswerable questions, came in unscoped
  sessions with no retrieval. A3, the one ambiguous question with retrieval, was answered on
  a stated assumption in both arms instead of asked about.
