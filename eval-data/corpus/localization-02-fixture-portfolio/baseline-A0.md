# Localization eval — `localization-02-fixture-portfolio`

Items: **15** · Repos: `orders@4d8bb2ba`, `billing@1f24ead4`, `notify@5d092497` · Runs requested: **3** · Budget: **$35** · Spent: **$0.0000**

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
| symbols | 105ac7e8ab9e |
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
| A0 | 0.54 [0.39, 0.68] | 1.00 [1.00, 1.00] | 0.21 [0.17, 0.26] | 0.54 [0.37, 0.72] | n/a (no model-named files) | not measured | 0 | 10.00 | $0.0000 | 0.00 |

- A0 table precision: not requested (pass --table-guard)

## Paired comparison with A0

> At 15 items and a hit rate near 0.5 the standard error is about 12.9 points per arm, so a gap needs roughly 26 to 36 points to be significant. A smaller difference is reported as "no measurable difference", not as a win.

No other arm was run: this report is A0's baseline.

## Per requirement

| Item | A0 R@5 / R@10 / EditP / RR |
|---|---|
| FX-01 | 0.50 / 1.00 / 0.20 / 1.00 |
| FX-02 | 0.50 / 1.00 / 0.20 / 1.00 |
| FX-03 | 0.00 / 1.00 / 0.20 / 0.14 |
| FX-04 | 0.50 / 1.00 / 0.20 / 0.33 |
| FX-05 | 0.50 / 1.00 / 0.20 / 0.20 |
| FX-06 | 1.00 / 1.00 / 0.20 / 1.00 |
| FX-07 | 0.67 / 1.00 / 0.30 / 0.50 |
| FX-08 | 0.50 / 1.00 / 0.20 / 0.50 |
| FX-09 | 0.40 / 1.00 / 0.50 / 0.25 |
| FX-10 | 1.00 / 1.00 / 0.10 / 0.33 |
| FX-11 | 0.00 / 1.00 / 0.10 / 0.13 |
| FX-12 | 0.50 / 1.00 / 0.20 / 1.00 |
| FX-13 | 0.50 / 1.00 / 0.20 / 0.50 |
| FX-14 | 1.00 / 1.00 / 0.10 / 0.25 |
| FX-15 | 0.50 / 1.00 / 0.20 / 1.00 |
