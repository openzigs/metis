# 0015 — Eval output leaves `main`; the nightly envelopes move to a branch

- **Status**: Accepted
- **Date**: 2026-09-21
- **Issue**: [#1382](https://github.com/openzigs/metis-private/issues/1382)
- **Supersedes**: [ADR 0012](0012-track-the-nightly-eval-envelopes.md) — on WHERE the
  envelopes live. Its reasoning about WHY they must live in git is carried forward intact.
- **Relates to**: [#1308](https://github.com/openzigs/metis-private/issues/1308) (the "does not
  ship" decision), [#1373](https://github.com/openzigs/metis-private/issues/1373) (the
  company-identifier gate), [#1300](https://github.com/openzigs/metis-private/issues/1300) (the
  `reference.json` licence), [#1295](https://github.com/openzigs/metis-private/issues/1295) (the
  public repository)

## Context

#1308 decided `eval-data/` and `eval-results/` do not ship, and left the implementation
open. Nothing implemented it, so on `main` @ `0da7be5e` both directories were still
tracked: 177 + 91 files, twelve of which carried the company identifier that #1373 exists
to keep out of the published tree. The gate was silent about them **because** of that
decision — `UNPUBLISHED_PREFIXES` skipped both directories — so the guarantee "no company
identifier in the publishable tree" rested on a decision nobody had carried out.

The owner answered the open question on 2026-09-21: **untracked and gitignored.** Not a
separate repository, not deferred to #1295's squash.

A first pass at implementing it proposed untracking both directories whole, on the premise
that `eval-data/` was reproducible from its two generator scripts. That premise was wrong,
and measurably so:

```
$ grep -oE "(docretrieval|docsgen)-[0-9]+" eval-data/build-fixtures.mjs
(no matches)
```

`build-fixtures.mjs` generates the twelve `prd-*`/`brd-*` corpora and `codegraph-01`;
`build-impact-recall-fixture.mjs` generates two more. Six of the twenty corpora are
hand-authored. Untracking `eval-data/` would have destroyed 48 span-anchored questions,
three sets of human-written gold answers (#1319 — whose entire premise is that a
model-written gold answer makes the metric measure the judge against itself), two authoring
guides and three snapshot manifests. None of it is regenerable.

## Decision

**Untrack precisely the part of the eval tree that is derived, and keep the part that is
authored.**

| Path | Action | Files |
|---|---|---:|
| `eval-results/` | untrack + gitignore | 91 |
| `eval-data/corpus/*/docs/` | untrack + gitignore | 38 |
| `eval-data/` everything else | **stays tracked** | 139 |

Two of those 91 files are not nightly output and do not leave the repository: they are
**test fixtures** that `power-sizing.test.ts` and `reporting.test.ts` read on every run,
to prove that constants in the code were copied from a recorded run rather than
transcribed. They move to `server/src/lib/eval/provenance/` — see the README there. The
#1308 argument against `eval-results/` was unbounded growth (~365 files a year, forever);
two static files cited by ADR 0013 and #1184 are not that case, and keeping them through
a `.gitignore` negation would have needed two levels of negation under an ignored parent,
which is the shape git refuses to honour.

Swept out of `eval-results/` and `eval-data/corpus/*/docs/`: **129** paths. Of those, 127
leave the repository (they stay on disk; `git rm --cached` only removes them from the
index) and 2 are the provenance fixtures, which move rather than leave. With the 11 files
this change adds — the restore script and its core, three test files, ADR 0015, the
fragment, the provenance README and the two moved fixtures' new paths — the tree goes
from **4,417 tracked files to 4,301**.

Four things follow, and each is load-bearing.

### 1. The untracked doc snapshots are REBUILDABLE, exactly

`eval-data/corpus/<id>/docs/` is 38 markdown files that are byte-identical copies of this
repository's own `docs/*.md` at `snapshotCommit` `953bfe70`. Each corpus's committed
`snapshot-manifest.json` records every file's `source` path and its sha256 at that commit,
so `git show 953bfe70:<source>` reproduces the bytes and the recorded hash proves it.
Verified for all 38 before the untrack: 38 identical, 0 drifted.

`pnpm eval:restore-corpus` does exactly that, and **the SERVER package's `test` script**
runs it first — because `server/src/lib/eval/doc-retrieval/` reads that directory and 34
tests would otherwise fail on a fresh clone.

The first attempt wired it into the ROOT `pnpm test`, which looked like one place and was
not: `ci.yml`'s `postgres-adapter` job runs `pnpm test` with `working-directory: server`,
resolving to the server package's own script. Measured on this branch's first CI run —
`api` (root) failed 2 test files, `postgres-adapter` (server) failed 4, the two extra
being the unrestored doc-retrieval suites. The wiring belongs to the package that READS
the corpus, not to a convenient entry point, and
`scripts/lib/corpus-restore-wiring.test.mjs` now asserts that. The nightly needs it too:
`pnpm eval:answer-correctness` loads the doc-retrieval corpus unconditionally, so
`eval-domain-nightly.yml` runs the restore before either eval.

The restore is a no-op when the files are present and hash correctly (38 reads, no git,
no network), which is every run after the first, since the output is gitignored rather
than cleaned. This is the `graphify-out/` pattern from ADR 0007: untracked, rebuilt on
demand by a committed script, never committed.

Absence and drift are deliberately different answers. A missing file is restored; a file
that is present but hashes differently has been edited, and overwriting it would erase the
evidence — so it is reported and left alone unless `--resync` is passed.

### 2. The nightly publishes to the `eval-results` branch, not to `main`

ADR 0012 rejected moving the envelopes off `main` for reasons that still hold: workflow
artifacts expire, and drift history that evaporates after 90 days is not history;
`drift-alert` is a committed consumer reading a committed directory through `loadAllRuns`.
It also anticipated exactly this change — *"If #1300 concludes that eval output must not be
public, that decision applies to the 66 envelopes already on `main` too and is a separate,
deliberate migration."* This is that migration.

The envelopes move to a dedicated `eval-results` branch — the pattern `cla.yml` already
uses for `cla-signatures`, for the same reason: recording an append never touches the
branch that gets published. The branch keeps every property ADR 0012 wanted (it does not
expire, it accumulates, it is a git object the harness can read) and drops the one #1308
objected to (~365 files a year on `main`).

The branch is **mounted as `eval-results/`**, a git worktree rather than a copy, and that
choice is what makes the change small:

- `drift-alert` needs no new code. `loadAllRuns` reads `<cwd>/eval-results`, which now
  holds the branch's accumulated history exactly as it held `main`'s.
- #1333's commit guard needs no new arms. Asked about the worktree, its three failure modes
  keep their exact meanings — `ignored`, `unchanged`, `missing` — instead of being replaced
  by a weaker question. `ignored` additionally now catches the workflow having skipped the
  checkout step, which would otherwise be the new way to commit nothing quietly.

The branch was seeded from `main`'s `eval-results` tree at `0da7be5e`, so all 91 envelopes
of drift history survive the move byte-for-byte. Nothing on that branch is ever merged into
`main`.

### 3. The identifier gate loses its exclusion list entirely

`UNPUBLISHED_PREFIXES` was correct while #1308 was unimplemented and became a fail-open the
moment it was implemented: `eval-results/` and the doc snapshots left the index, so there
was nothing under them for an exclusion to exclude, while 139 `eval-data/` files stayed
tracked and started shipping. Two of them carried the identifier and the prefix list was
the only reason the gate did not say so. Measured — with the list restored, a violation
planted in a tracked `eval-data/` file reads `no company identifiers` and exits 0 over
4,131 of 4,284 files.

The list is gone rather than narrowed. The scan is now 100% of tracked text files, which is
what the module header already claimed, and an untracked file cannot carry an identifier
into a publication that ships only what git tracks. The two offenders were scrubbed:

- Two `queries.json` quotes were **shortened**, not reworded — a quote must stay a verbatim,
  unique substring of its snapshot or `resolveSpan` rejects it. Both now stop before the
  old repository URL. All 198 corpus-02 and 48 corpus-01 queries still resolve.
- One `embedretrieval-02` snapshot file had the identifier replaced with the same neutral
  placeholder #1373 used in the real source file. That breaks its byte-identity with
  `snapshotCommit`, so its manifest entry drops to `source: null` — "hashed from the
  committed file, drift still caught, no provenance claim" — and `REDACTED_SNAPSHOT_FILES`
  records why, so regenerating the manifest cannot silently restore a claim the bytes no
  longer support.

### 4. `reference.json`'s licence is CC0-1.0

`eval-data/corpus/docretrieval-01-metis-docs/reference.json` carried `"license": "PENDING"`
(#1300, E4 of #1322) because the corpus is derived from METIS's own documentation rather
than invented for the repository. That made it the owner's own authored content, and the
owner has confirmed it: CC0-1.0, matching the other two `reference.json` files and the rest
of the corpus. An unlicensed file cannot ship, and this file now does.

## Alternatives considered

**Untrack `eval-data/` as well, keeping only the two generator scripts.** Rejected on
measurement — see Context. The generators produce 14 of 20 corpora and none of the
hand-authored ones.

**Keep the doc snapshots tracked and scrub them.** Rejected: they are frozen at
`snapshotCommit` and a scrub breaks the provenance the corpus exists to assert, for 38
files rather than one. Untracking preserves the frozen bytes in history and rebuilds them
verbatim.

**Skip the 34 tests that read the doc snapshots when the directory is absent.** Rejected.
A conditionally-skipped suite in CI is a hole exactly where the corpus contract lives, and
this repository has shipped that shape enough times to know how it ends. Restoring is
cheap, exact, and verifiable.

**Workflow artifact for the nightly envelopes.** Rejected again, for ADR 0012's reasons
unchanged: it expires, and it adds a fetch step whose own failure mode is silently
returning nothing.

**A narrow, justified exclusion in the identifier gate instead of scrubbing.** Rejected:
the guarantee the gate makes is about the published tree, and 139 `eval-data/` files are
now in it. An exempt path is a hole exactly where the next paste lands.

## Consequences

- A fresh clone has no `eval-data/corpus/*/docs/`. Any script that starts vitest over
  `server/` restores it first, including `pnpm --filter @metis/server test` and
  `test:coverage`; a bare `npx vitest run` inside `server/` does not, and
  `loadDocRetrievalCorpus` then throws an error naming `pnpm eval:restore-corpus` rather
  than a bare `ENOENT` on `scandir`.
- The restore reaches the network once, on a fresh shallow clone, to fetch the snapshot
  commit by sha. It is silent and offline thereafter.
- `eval-results/` is ignored as a whole directory again. The negations ADR 0012 added are
  gone because nothing under it is tracked, so there is no negation left to get wrong.
  `scripts/lib/eval-results-commit-guard-runner.test.mjs` asserts the new shape against
  real git, including an arm that removes the branch worktree and requires the guard to
  fail rather than read a blanket-ignored directory as "nothing to do".
- `pnpm worktrees:prune` and `git worktree list` will show an `eval-results` worktree on
  the nightly runner between the checkout and publish steps. It is inside the workspace
  `actions/checkout` cleans, and `eval-results-branch.mjs checkout` prunes and clears the
  path before mounting, so a stale registration from a previous run cannot block it.
- The four `eval-results` envelopes that contain the company identifier are on the
  `eval-results` branch and in `main`'s history. Neither reaches the public repository:
  #1295 creates it from a squashed commit of `main`'s tree, which no longer contains them.
- **#1295 has to materialise the doc snapshots before it squashes, and this is the one
  place that says so.** The restore reads `git show <snapshotCommit>:<source>`, and a
  repository created from a single squashed commit has no `953bfe70` and cannot fetch one
  from its own origin. `ensureCommit` returns false, the runner exits 1, and because
  `server`'s `test` script `&&`-chains it, vitest never starts — so the public repository
  would ship an eval harness that cannot run, which is the opposite of what keeping
  `eval-data/` tracked was for. Two ways out, both cheap, neither automatic: force-add
  the 38 restored files into the squashed commit (`git add -f eval-data/corpus/*/docs`,
  1.1 MB, and the files are already scrubbed of the identifier since they are rebuilt
  from a commit that predates the sweep — check before committing), or re-cut the corpus
  against a commit the public history contains. Raised by this PR's adversarial panel;
  it is a #1295 decision, not one this PR can make.
