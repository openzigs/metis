# Portfolio gap-verdict eval — `localization-02-fixture-portfolio`

Items: **15** · Repos: `orders@4d8bb2ba`, `billing@1f24ead4`, `notify@5d092497` · Runs requested: **3** · Budget: **$10** · Spent: **$2.5162** · 2026-11-16T00:03:34.170Z

Setup: one product, "Commerce services", holding the three repositories (each in its own project, source files ingested as knowledge documents); each item checked as one requirement (title and text as the statement, criteria decomposed by the engine), the product in scope.

## Arms

### P0 · anthropic/claude-sonnet-5-5 — shipped engine: one shared federated search per product

Complete runs: 3 · outcomes: 45

| Setting | Value |
|---|---|
| runCostCapUsd | 2 |
| productCostCapUsd | 0.5 |
| concurrency | 4 |
| hitsPerProduct | 24 |
| hitsPerRepo | 12 |
| perRepoSearch | false |
| maxCriteria | 8 |
| maxModelCalls | 250 |
| model | anthropic/claude-sonnet-5-5 |

### P0′ · anthropic/claude-sonnet-5-5 — #1763 per-repo search: each project searched with a per-repo hit quota

Complete runs: 3 · outcomes: 45

| Setting | Value |
|---|---|
| runCostCapUsd | 2 |
| productCostCapUsd | 0.5 |
| concurrency | 4 |
| hitsPerProduct | 24 |
| hitsPerRepo | 12 |
| perRepoSearch | true |
| maxCriteria | 8 |
| maxModelCalls | 250 |
| model | anthropic/claude-sonnet-5-5 |

Not run:

- P1 (#1764, the per-repo agentic evidence pass): not landed yet.

## Results (mean over items of each item's mean over its runs; 95% bootstrap interval)

| Arm | Verdict accuracy | Product accuracy | Answer repo's own verdict | Expected-repo recall | Uncited `implemented` | Valid citations | $ / req | s / req |
|---|---|---|---|---|---|---|---|---|
| P0 · anthropic/claude-sonnet-5-5 | 0.51 [0.27, 0.76] (n=15) | 0.51 [0.27, 0.76] (n=15) | 0.48 [0.24, 0.71] (n=14) | 0.67 [0.33, 1.00] (n=9) | 0 | 70/70 | $0.0278 | 11.2 |
| P0′ · anthropic/claude-sonnet-5-5 | 0.47 [0.24, 0.69] (n=15) | 0.47 [0.24, 0.69] (n=15) | 0.45 [0.21, 0.69] (n=14) | 0.70 [0.41, 1.00] (n=9) | 0 | 76/76 | $0.0282 | 13.5 |

Product accuracy reads the one product's coverage; with every repository in one product it equals the portfolio verdict. Expected-repo recall is over `implemented` and `partial` answers: the share of answer repositories found implementing a criterion. A citation is valid when its file exists in that repository at the pinned commit and its lines fall inside the file.

### Accuracy by answer repository and by expected verdict

| Arm | billing | multi-repo | notify | orders | expected implemented | expected partial | expected gap |
|---|---|---|---|---|---|---|---|
| P0 · anthropic/claude-sonnet-5-5 | 0.50 [0.00, 1.00] (n=4) | 1.00 [1.00, 1.00] (n=1) | 0.67 [0.00, 1.00] (n=3) | 0.38 [0.10, 0.71] (n=7) | 0.58 [0.17, 1.00] (n=4) | 0.40 [0.00, 0.80] (n=5) | 0.56 [0.17, 0.89] (n=6) |
| P0′ · anthropic/claude-sonnet-5-5 | 0.50 [0.00, 1.00] (n=4) | 1.00 [1.00, 1.00] (n=1) | 0.44 [0.00, 0.67] (n=3) | 0.38 [0.10, 0.71] (n=7) | 0.42 [0.00, 0.83] (n=4) | 0.47 [0.07, 0.87] (n=5) | 0.50 [0.17, 0.83] (n=6) |

### Confusion matrices (expected rows × predicted columns, every run)

**P0 · anthropic/claude-sonnet-5-5**

| expected \ predicted | implemented | partial | gap | could-not-verify |
|---|---|---|---|---|
| implemented | 7 | 5 | 0 | 0 |
| partial | 0 | 6 | 8 | 1 |
| gap | 0 | 8 | 10 | 0 |

**P0′ · anthropic/claude-sonnet-5-5**

| expected \ predicted | implemented | partial | gap | could-not-verify |
|---|---|---|---|---|
| implemented | 5 | 7 | 0 | 0 |
| partial | 0 | 7 | 8 | 0 |
| gap | 0 | 8 | 9 | 1 |

## Paired comparison

> At 15 items and a hit rate near 0.5 the standard error is about 12.9 points per arm, so a gap needs roughly 26 to 36 points to be significant. A smaller difference is reported as "no measurable difference", not as a win.

| Arm vs baseline | Δ accuracy [95% CI] | bootstrap p | McNemar (arm only / baseline only) | McNemar p | Reading |
|---|---|---|---|---|---|
| P0′ vs P0 | -0.04 [-0.13, 0.04] | 0.248 | 0 / 0 | 1.000 | no measurable difference |

## Per requirement

Predictions per run: I implemented, P partial, G gap, ? could not verify.

| Item | Expected | P0 · anthropic/claude-sonnet-5-5 | P0′ · anthropic/claude-sonnet-5-5 |
|---|---|---|---|
| FX-01 | partial | PPP | PPP |
| FX-02 | partial | GGG | GGG |
| FX-03 | implemented | IPP | PPP |
| FX-04 | implemented | III | III |
| FX-05 | implemented | III | PII |
| FX-06 | gap | GGG | GGG |
| FX-07 | gap | PPP | PPP |
| FX-08 | partial | PPP | PPP |
| FX-09 | gap | GGG | GGG |
| FX-10 | partial | GG? | GGG |
| FX-11 | gap | GPP | PPG |
| FX-12 | partial | GGG | GPG |
| FX-13 | gap | PPP | PPP |
| FX-14 | gap | GGG | GG? |
| FX-15 | implemented | PPP | PPP |
