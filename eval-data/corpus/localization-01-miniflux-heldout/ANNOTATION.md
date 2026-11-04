# How the held-out Miniflux set was written (#1753)

## Who rewrote the text, and what they had seen

**The requirement text was rewritten by an AI coding agent (`claude-opus-5-5`)
dispatched on issue #1753, not by a person.** The issue asks for "someone who has
not seen the diff". The agent had not: the steps ran in this order, in one session
on 2026-11-04.

1. Listed the PRs merged into `miniflux/v2` after `v2.3.3` (2026-07-24) that change
   behaviour, and fetched each one's **title and description only** (`gh pr view
   --json title,body`).
2. Wrote all 31 rewrites and saved them. The save finished at `2026-11-04T11:01:06Z`
   (`annotation.rewrittenAt` in `manifest.json`).
3. Only then fetched each PR's **file list** (`gh api …/pulls/<n>/files`). No diff
   was read at any point, before or after.

Two limits to state plainly:

- **Several PR descriptions name files or functions** (#4483, #4519, #4556, #4557,
  #4563, #4567, #4575, #4579). The rewrites name none: they describe the behaviour a
  reader or an operator sees. The loader enforces the surface of this rule: a
  held-out item whose wording carries a file name, a path, a call, a backtick, or a
  camelCase / PascalCase / snake_case token fails to load (`codeShapedTokens`,
  `server/src/lib/eval/localization/corpus.ts`). The one exception is the product
  name "YouTube", listed in `allowedTerms`. A paraphrase can still lean on the
  description's vocabulary in ways no regex sees.
- **Reviewed by the owner on 2026-11-04** (`annotation.reviewedBy`), who did not
  read the diffs. The main Claude session gave a second opinion on each item. Nine
  rewrites that borrowed developer vocabulary or described the fix were reworded
  in plain analyst language: MF-4495, 4563, 4567, 4572, 4575, 4579, 4599, 4605 and
  4608. MF-4571 was dropped as too thin to read as an analyst request. The A0
  baseline was re-run on the reviewed text.

## Which PRs, and why

- **Kept:** PRs whose change a business analyst could ask for: a feature, or a
  bug with a visible effect.
- **Left out before any file list was fetched** (a judgement made on the titles and
  descriptions alone): performance-only and refactoring PRs (#4401, #4427, #4484,
  #4487, #4506, #4508, #4593); translations (#4527, #4573, #4607, #4617);
  documentation, CI, dependency and Docker examples (#4564, #4598, #4602, #4603,
  #4614); a scraper-rule data change (#4560); internal plumbing with no behaviour
  an analyst would ask for (#4445, #4489, #4517, #4555, #4562, #4574, #4591, #4601,
  #4604); and follow-ups that repeat a kept or in-sample PR's area, so the set does
  not count one request twice (#4568 after #4513, #4569 after #4500, #4570 after
  #4554, #4588 after #4571).
- **Left out because they are not held out:** #4497, #4513 and #4519 fix three of
  the six run-7 issues the `change-seeds.ts` cut sizes were tuned on (#4479, #4456,
  #4386); #4453 is a walkthrough reference set (`docs/walkthroughs/TEST_PLAN.md`).
- **Dropped after the file lists were fetched,** by the corpus rule that an item
  needs at least one ground-truth file the code graph holds (no arm can find any
  other kind): #4496 (only templates and translations) and #4596 (every file it
  edits was created after `v2.3.3`). No item was dropped for any other reason, and
  none was dropped on an arm's result: A0 had not been run.

That left 25 items; the review dropped MF-4571, leaving 24.

## Ground truth

Each item's files are the merged PR's files, classified by
`server/scripts/build-localization-corpus.ts ground-truth` with the rules seeding
itself uses (`isTestFilePath`, `isDocumentationFilePath`). Every file the scorer
counts is a file of the **`v2.3.3` code graph** (`symbols.json.gz`, the real ingest
at `c4d54f87`). The rest are kept in `excludedFiles` with their reason:

| Reason | Meaning |
|---|---|
| `test` | A test file: never an edit candidate. |
| `documentation` | A documentation file (root `docs/` and similar). |
| `added-by-change` | The PR created it; the snapshot cannot hold it. |
| `not-in-code-graph` | Templates, translations, the man page, `go.mod`, a README, and files an earlier PR created after `v2.3.3`. |

The snapshot is `v2.3.3` for every item, the walkthrough's pinned base, which
predates all 24 PRs: no item's own change is in the code it is searched against.
Some PRs build on an earlier post-`v2.3.3` PR, so their files can differ from what
`v2.3.3` holds; those files are excluded, not guessed.
