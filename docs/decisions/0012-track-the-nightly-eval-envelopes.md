# 0012 — The nightly eval envelopes are tracked history; the ad-hoc run artifacts are not

- **Status**: Superseded in part by
  [ADR 0015](0015-untrack-eval-output-and-move-the-nightly-to-a-branch.md) (2026-09-21).
  Everything below about WHY the envelopes must live in git — drift history must not
  expire, `--porcelain` emptiness is the wrong question, an empty result set is a failure
  — still holds and is still enforced. What changed is WHERE: #1308's "eval output does
  not ship" decision was implemented by #1382, so `eval-results/` is untracked on `main`
  and the nightly publishes to the dedicated `eval-results` branch instead. The
  "Alternatives considered" section below anticipated exactly that migration.
- **Date**: 2026-08-29
- **Issue**: [#1333](https://github.com/openzigs/metis-private/issues/1333)
- **Relates to**: [#983](https://github.com/openzigs/metis-private/issues/983) (the ignore rule),
  [#1319](https://github.com/openzigs/metis-private/issues/1319) (the answer-correctness envelope),
  [#1300](https://github.com/openzigs/metis-private/issues/1300) (whether eval data ships publicly at all)

## Context

`eval-results/` went into `.gitignore` on 2026-07-21 (#983, `2730bbe5`), with the
comment "Impact-recall eval run artifacts (scripts write timestamped JSON here);
these are local run outputs, not tracked corpus data." #983's CHANGELOG entry
says the same thing and adds "no existing files were committed": it was a
`git status` hygiene fix aimed at the impact-recall harness, not a publication
policy.

The rule was written as a whole-directory ignore, and the directory holds two
different kinds of file:

| Written by | Shape | Purpose |
|---|---|---|
| `eval-domain-nightly.yml` (nightly, CI) | `eval-results/<runId>.json` | **Accumulated history.** `loadAllRuns` reads every one of them; `selectBaseline` picks the week-old one; `drift-alert` compares against it. |
| #1319's nightly step | `eval-results/answer-correctness/*.json` | Same: the nightly's answer-correctness envelope. |
| `eval:impact-recall`, `eval:embed-retrieval`, `eval:doc-retrieval`, `eval:hybrid-ab`, `eval:reqmap`, `eval:verification`, `eval:harvest-feedback` | `<harness>-<stamp>.{json,md}` | **Local run outputs.** Force-added by hand (`git add -f`) on the rare occasion a decision needs to cite one. |

The nightly's commit-back step guarded itself with:

```bash
if [ -z "$(git status --porcelain eval-results)" ]; then
  echo "No new domain eval results to commit."
  exit 0
fi
git add eval-results
```

`git status --porcelain` does not list ignored files. From 2026-07-21 a freshly
written `eval-results/<runId>.json` produced an empty string; the guard printed
"No new domain eval results to commit" and exited 0. **The job was green every
night for five weeks and committed nothing.** The 66 envelopes still in the tree
predate the rule — an ignore line does not untrack — which is why the directory
looked healthy from a listing.

The damage is not only the missing files. `selectBaseline` kept returning the
2026-07-21 run, so every nightly in the window compared today's F1 against the
same five-week-old number and reported `WITHIN_THRESHOLD`. The drift gate ran,
stayed green, and measured nothing new.

## Decision

**Narrow the ignore rule so the nightly-committed envelopes are tracked, keep
the ad-hoc harness outputs ignored, and replace the commit guard with one that
cannot report absence as success.**

```gitignore
eval-results/*
!eval-results/[0-9]*.json
!eval-results/answer-correctness/
```

A domain `runId` is an ISO-ish UTC timestamp, so it always begins with a digit;
every ad-hoc harness prefixes its output with its own name. The negation is
therefore structural rather than a list of harness names that would rot. Git
cannot re-include a path whose parent directory is excluded, which is why the
rule is `eval-results/*` (one level) rather than `eval-results/`.

Three things follow, and all three are load-bearing:

1. **The commit guard asks a question that includes ignored paths.**
   `scripts/eval-results-commit-guard.mjs` walks the writer's output directory
   on disk and reconciles it with
   `git status --porcelain --ignored=matching --untracked-files=all`. It fails —
   loudly, naming the path — in three distinct cases: the output was written but
   is ignored; the output is missing entirely; only unchanged tracked envelopes
   from earlier runs are present. **An empty result set is a failure, never a
   no-op.** That is the whole defect: absence reading as success, the same shape
   as #1324's permanently-red gate and #1288's misread flake.
2. **The `git status --porcelain` emptiness test is banned for this path.** It
   is not a bug in that command; it is the wrong question for a directory that
   may be ignored. `--ignored`, or a direct check of the writer's output path,
   is the right one.
3. **Every drift verdict states the age of the baseline it used.**
   `DomainDrift` gained `baselineRunId`, `baselineAgeDays` and `staleBaseline`,
   and `describeBaselineStaleness` renders one sentence that the CLI, the Slack
   alert, the nightly job summary and the Domain Eval tab all print. A verdict
   measured against 39-day-old history is not a week-over-week verdict and must
   not read as one — the five-week gap will therefore announce itself on the
   first nightly after this lands, without anyone having to remember it.

## Alternatives considered

**Keep `eval-results/` ignored and publish the envelopes another way** — a
workflow artifact, a release asset, or a dedicated `eval-results` branch — then
point `drift-alert` at that. Rejected:

- It is strictly more machinery for the same outcome. `drift-alert` is a
  committed consumer reading a committed directory through `loadAllRuns`; the
  read API (`GET /api/eval/domain/runs`) streams the same files. Moving the
  store means a fetch step, a retention policy, and a second failure mode where
  the fetch is what silently returns nothing.
- Workflow artifacts expire. Drift history that evaporates after 90 days is not
  history.
- It **defers** the underlying question onto #1300 (whether `eval-data/` and
  eval output ship publicly at all) rather than answering it. If #1300 concludes
  that eval output must not be public, that decision applies to the 66 envelopes
  already on `main` too and is a separate, deliberate migration — not something
  to arrive at by accident through an ignore rule nobody re-read.

**Un-ignore `eval-results/` entirely.** Rejected: #983's stated intent is
correct for the harness outputs it named, and reverting it wholesale would put
every local exploratory run back into `git status`, which is what #983 fixed.

**Enumerate the ad-hoc harness prefixes as the ignore list**, so anything new
defaults to tracked. Rejected as brittle: the list would rot as harnesses are
added or renamed, and the guard already converts the "silently ignored" failure
mode into a loud one, which was the only reason to prefer that default.

## Consequences

- `eval-results/online/` (#1321's online-eval windows) stays ignored and
  uncommitted, unchanged by this ADR. Nothing commits it today; if the online
  eval ever grows a nightly, it gets a negation and a required-output entry in
  `NIGHTLY_REQUIRED_OUTPUTS`, and the guard will say so if it does not.
- The historical force-added artifacts (`embed-retrieval-*`,
  `doc-retrieval-*`) stay tracked — an ignore rule does not untrack — and stay
  citable. New ones still need `git add -f`.
- `eval-results/` is added to `.prettierignore`, so lint-staged never reflows a
  machine-written envelope.
- The tracked envelope count grows by roughly one per night, at a few tens of
  kilobytes each. If that ever matters it is a retention decision (prune runs
  older than N months), not a reason to stop recording history.
- `scripts/lib/eval-results-commit-guard-runner.test.mjs` runs the real guard
  against the repository's own `.gitignore` in a throwaway git repo, so
  re-broadening the rule back to `eval-results/` turns that suite red instead of
  producing another five silent weeks.
