# Localization eval — `localization-01-miniflux-heldout`

Items: **24** · Repos: `miniflux@c4d54f87` · Runs requested: **3** · Budget: **$35** · Spent: **$0.0000**

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
| A0 | 0.52 [0.38, 0.66] | 0.60 [0.46, 0.74] | 0.17 [0.12, 0.22] | 0.55 [0.40, 0.70] | n/a (no model-named files) | not measured | 0 | 7.21 | $0.0000 | 0.03 |

- A0 table precision: not requested (pass --table-guard)

## Paired comparison with A0

> At 24 items and a hit rate near 0.5 the standard error is about 10.2 points per arm, so a gap needs roughly 20 to 28 points to be significant. A smaller difference is reported as "no measurable difference", not as a win.

No other arm was run: this report is A0's baseline.

## Per requirement

| Item | A0 R@5 / R@10 / EditP / RR |
|---|---|
| MF-4483 | 1.00 / 1.00 / 0.20 / 0.50 |
| MF-4495 | 1.00 / 1.00 / 0.17 / 0.33 |
| MF-4500 | 0.00 / 0.00 / 0.00 / 0.03 |
| MF-4510 | 0.50 / 0.50 / 0.33 / 1.00 |
| MF-4516 | 0.60 / 0.80 / 0.50 / 1.00 |
| MF-4520 | 1.00 / 1.00 / 0.13 / 1.00 |
| MF-4525 | 0.50 / 0.50 / 0.33 / 1.00 |
| MF-4526 | 0.33 / 0.33 / 0.14 / 0.20 |
| MF-4554 | 0.00 / 0.00 / 0.00 / 0.02 |
| MF-4556 | 1.00 / 1.00 / 0.33 / 1.00 |
| MF-4557 | 0.00 / 0.33 / 0.13 / 0.14 |
| MF-4563 | 0.50 / 0.50 / 0.13 / 0.50 |
| MF-4566 | 0.00 / 0.00 / 0.00 / 0.06 |
| MF-4567 | 0.50 / 0.50 / 0.11 / 0.33 |
| MF-4572 | 0.40 / 0.80 / 0.29 / 1.00 |
| MF-4575 | 1.00 / 1.00 / 0.10 / 1.00 |
| MF-4579 | 1.00 / 1.00 / 0.14 / 1.00 |
| MF-4592 | 0.17 / 0.17 / 0.14 / 0.25 |
| MF-4594 | 0.25 / 0.75 / 0.14 / 0.33 |
| MF-4599 | 0.50 / 1.00 / 0.13 / 0.20 |
| MF-4605 | 0.33 / 0.33 / 0.13 / 0.25 |
| MF-4606 | 0.50 / 0.50 / 0.13 / 0.50 |
| MF-4608 | 1.00 / 1.00 / 0.20 / 0.50 |
| MF-4610 | 0.50 / 0.50 / 0.11 / 1.00 |
