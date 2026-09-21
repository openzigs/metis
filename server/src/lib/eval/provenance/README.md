# Provenance artefacts — committed eval runs that tests read

Two recorded eval runs live here, and they are **test fixtures, not eval output**.

| File | Read by | Proves |
|---|---|---|
| `doc-retrieval-chunk-sweep-2026-07-31T20-37-55-374Z.json` | `../doc-retrieval/power-sizing.test.ts` | `PRIOR_RUN_SIZING`'s eighteen intervals were genuinely copied from the #1183 run its docstring names |
| `answer-correctness-2026-08-30T14-57-51-691Z.json` | `../answer-correctness/reporting.test.ts` | #1342's before/after is re-derived from the recorded run, not from numbers retyped into a fixture |

## Why they are here and not in `eval-results/`

They used to be, force-added with `git add -f`. #1382 untracked `eval-results/`
outright — #1308 decided eval output does not ship, and the argument was **unbounded
growth**: `eval-domain-nightly.yml` appends an envelope every night, ~365 files a year,
forever. That argument does not reach these two. They are static, bounded, cited by
[ADR 0013](../../../../../docs/decisions/0013-answer-correctness-reports-precision-and-recall.md)
and by #1184, and a test reads each one on every run.

Keeping them through a `.gitignore` negation would have meant two levels of negation
under an ignored parent — the exact shape git refuses to honour and that #1333 already
lost five weeks to. Moving them says what is true instead: `eval-results/` is nightly
output and nothing in it is tracked, and a file a test reads is a fixture.

`reporting.test.ts` used to warn that its envelope was "one retention policy away from
disappearing". It no longer is.

## What must not happen to them

**Do not regenerate, reformat, prune or "tidy" these files.** Each exists so an
assertion can compare code against a recorded run rather than against a transcription of
it — the first version of `PRIOR_RUN_SIZING` was hand-transcribed and all eighteen
values were wrong at ~5e-5, invisible to every other test in the suite. A file rewritten
to match the constants would readmit exactly that error while looking like a pass.

One deliberate edit was made, once. `doc-retrieval-chunk-sweep-…` embeds the corpus
document text it retrieved over, snapshotted before #1373's company-identifier sweep, so
six occurrences of an old `github.com/<org>/metis` URL inside that **prose** were
replaced with the published owner. No number changed: the fields the test reads
(`comparisons[].armId`, `comparisons[].all.paired`, and the `overlapComparisons`
equivalents) are the recorded bytes. #1382 is the record of that edit.
