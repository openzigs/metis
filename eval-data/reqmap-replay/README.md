# Requirement→code link replay (#1097)

`miniflux-run7.json` holds the requirements of two #706 run-7 projects on Miniflux v2.3.3 and,
for each, the code symbols one annotator judged **right**: code a developer would read or change
for that requirement. Every other link is wrong.

| Set | Project | Requirements |
|---|---|---|
| `j1` | Miniflux feature requests (run 7 journey) | 5 imported feature requests |
| `main` | Miniflux v2.3.3 (run 7) | 8 acceptance criteria of one Spec Kit feature |

`server/scripts/eval-reqmap-replay.ts` maps every requirement through the analysis "affected
code" path (`mapAffectedCodeCandidates`, mapper + blast radius, 8 links each) and scores the
links shown against these labels. It needs what a walkthrough leaves behind and nothing commits:
a database with the two projects' code graphs and a vector store with their symbol embeddings.
It calls no model except the local embedder.

```bash
cd server
DATABASE_URL=file:/path/to/a/copy/of/dev.db LANCEDB_PATH=/path/to/lancedb \
EMBED_BACKEND=xenova EMBED_MODEL=Alibaba-NLP/gte-modernbert-base \
TRANSFORMERS_CACHE=~/.cache/metis-transformers HF_HUB_OFFLINE=1 \
npx tsx scripts/eval-reqmap-replay.ts            # arms table
npx tsx scripts/eval-reqmap-replay.ts --detail   # every link, + right / - wrong
npx tsx scripts/eval-reqmap-replay.ts --fit      # re-fit the confidence model
npx tsx scripts/eval-reqmap-replay.ts --probes   # the PR #1095 review probes, both rankings
```

## Results (2026-10-21)

| Arm | Ranking | Links | Right | Precision | Requirements with a right link | No link |
|---|---|---|---|---|---|---|
| Before #1097 (`origin/main` at `ec9f2f63`) | BM25 | 58 | 17 | 0.29 | 9 / 13 | 3 |
| BM25 fallback, production link rules | BM25 | 60 | 17 | 0.28 | 9 / 13 | 3 |
| **Hybrid, production link rules** | hybrid | **98** | **30** | **0.31** | **10 / 13** | **0** |
| Hybrid, the BM25 link rules (two shared terms) | hybrid | 49 | 16 | 0.33 | 6 / 13 | 3 |
| Hybrid, subject + tests | hybrid | 104 | 30 | 0.29 | 10 / 13 | 0 |
| Hybrid, subject + tests + conf ≥ 0.05 | hybrid | 104 | 32 | 0.31 | 10 / 13 | 0 |
| Hybrid, subject + tests + conf ≥ 0.10 | hybrid | 85 | 27 | 0.32 | 8 / 13 | 1 |
| Hybrid, subject + tests + conf ≥ 0.15 | hybrid | 63 | 22 | 0.35 | 6 / 13 | 1 |

The code agent's seed list (no link rules, 104 links): 14 right before #1097, 30 right with the
hybrid ranking.

The Affected code panel lists a hybrid link at confidence 0.15 or more and folds the rest under
"N weaker matches": on the production hybrid arm the 53 listed links are 34% right (18) and the 45
folded ones 27% (12); 6 of 13 requirements have a right link among the listed ones, and one lists
none (its links are all folded).

Since the review of PR #1325: a hit only the keyword channel returned is scored at the vector
channel's lowest returned cosine (it was not among the nearest), an uncalibrated embedding model is
gated by the keyword rules, and blast-radius callers are scaled by the seed they were reached
through. The table above is re-measured with all three.

#1330 replaced the first of those: a hit the vector channel did not return reaches the 60-hit pool
only when the channel returned everything it holds for the project, so it has no vector at all, and
the lowest returned cosine does not bound it. Such an answer (and an uncalibrated model's) is now
gated by the keyword rules.

`--fit` reproduces the coefficients of `linkConfidence`
(`server/src/lib/traceability/requirement-code-mapping.ts`) from the vector channel's top 40
symbols for each requirement (520 links, 45 right).

## Read with care

- One repository, one annotator, 13 requirements. The labels were written for this work and the
  link floor (0.08) was chosen on this sample and on `pnpm eval:reqmap`: both numbers are
  in-sample.
- The `main` set is eight acceptance criteria of a single feature, so its labels overlap.
- The labels differ from the ones behind the run-7 counts in #1097's description, which were not
  committed; compare arms within this table, not with those counts.
- The confidence model is fitted on the vector channel's top 40 links only, yet the lexical model is
  the sole scorer of the keyword fallback, a different population: that use is an extrapolation.
- `sharedNameTerms` is a raw count over the denoised query, not a share of it, so a long Spec Kit
  acceptance-criteria body shares more words by chance than a five-word title. The cap at three
  shared words limits this; "the same scale on every requirement" is approximate.
- A project part-way through embedding reads `hybrid` as soon as one vector hit returns; since
  #1330 a requirement whose hits include an unembedded symbol is gated by the keyword rules.
