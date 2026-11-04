# Localization eval — `localization-00-miniflux-run7-insample`

> **IN-SAMPLE.** The `change-seeds.ts` cut sizes were tuned on these requirements. This corpus is a sanity check only and is never used to claim a gain.

Items: **6** · Repos: `miniflux@c4d54f87` · Runs requested: **3** · Budget: **$35** · Spent: **$0.0000**

## Arms

### A0 — shipped seeding (resolveChangeSeeds over HybridCodeSearch), no model

Complete runs: 3

| Setting | Value |
|---|---|
| stage | resolveChangeSeeds (impact-analysis/change-seeds.ts) |
| extractor | shapeAwareChangeExtractor |
| searcher | HybridCodeSearch (BM25 + symbol vectors, RRF) |
| bm25Weight | 0.05 |
| vectorWeight | 0.95 |
| embeddingModel | Alibaba-NLP/gte-modernbert-base |
| symbols | d847ad3c5175 |
| SEED_POOL_PER_QUERY | 120 |
| EDIT_POOL | 60 |
| MAX_EDIT_FILES | 5 |
| MIN_FILE_SHARE | 0.5 |
| FILE_HIT_DECAY | 0.5 |
| MAX_SYMBOLS_PER_EDIT_FILE | 4 |
| llm | false |

## Results (mean over items; 95% bootstrap interval)

| Arm | Recall@5 | Recall@10 | Edit precision | MRR | Graph resolution | Table precision | No edit candidate | Edit files / req | $ / req | s / req |
|---|---|---|---|---|---|---|---|---|---|---|
| A0 | 0.62 [0.29, 0.90] | 0.71 [0.39, 0.94] | 0.29 [0.17, 0.39] | 0.57 [0.30, 0.83] | n/a (no model-named files) | not measured | 0 | 4.67 | $0.0000 | 0.06 |

- A0 table precision: not requested (pass --table-guard)

## Paired comparison with A0

> At 6 items and a hit rate near 0.5 the standard error is about 20.4 points per arm, so a gap needs roughly 41 to 57 points to be significant. A smaller difference is reported as "no measurable difference", not as a win.

No other arm was run: this report is A0's baseline.

## Per requirement

| Item | A0 R@5 / R@10 / EditP / RR |
|---|---|
| R7-4478 | 1.00 / 1.00 / 0.40 / 0.50 |
| R7-4511 | 0.33 / 0.67 / 0.40 / 0.33 |
| R7-4336 | 0.40 / 0.60 / 0.40 / 1.00 |
| R7-4479 | 1.00 / 1.00 / 0.33 / 0.50 |
| R7-4386 | 0.00 / 0.00 / 0.00 / 0.06 |
| R7-4456 | 1.00 / 1.00 / 0.20 / 1.00 |
