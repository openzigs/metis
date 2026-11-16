# Portfolio gap-verdict eval — `localization-02-fixture-portfolio`

Items: **15** · Repos: `orders@4d8bb2ba`, `billing@1f24ead4`, `notify@5d092497` · Runs requested: **3** · Budget: **$5** · Spent: **$2.6694** · 2026-11-16T12:33:06.807Z

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
| P0 · anthropic/claude-sonnet-5-5 | 0.60 [0.40, 0.80] (n=15) | 0.60 [0.40, 0.80] (n=15) | 0.60 [0.38, 0.81] (n=14) | 0.78 [0.52, 1.00] (n=9) | 0 | 69/69 | $0.0301 | 11.8 |
| P0′ · anthropic/claude-sonnet-5-5 | 0.60 [0.40, 0.80] (n=15) | 0.60 [0.40, 0.80] (n=15) | 0.62 [0.40, 0.83] (n=14) | 0.81 [0.59, 1.00] (n=9) | 0 | 80/80 | $0.0292 | 11.3 |

Product accuracy reads the one product's coverage; with every repository in one product it equals the portfolio verdict. Expected-repo recall is over `implemented` and `partial` answers: the share of answer repositories found implementing a criterion. A citation is valid when its file exists in that repository at the pinned commit and its lines fall inside the file.

### Accuracy by answer repository and by expected verdict

| Arm | billing | multi-repo | notify | orders | expected implemented | expected partial | expected gap |
|---|---|---|---|---|---|---|---|
| P0 · anthropic/claude-sonnet-5-5 | 0.58 [0.17, 1.00] (n=4) | 1.00 [1.00, 1.00] (n=1) | 0.56 [0.00, 1.00] (n=3) | 0.57 [0.33, 0.81] (n=7) | 0.67 [0.25, 1.00] (n=4) | 0.60 [0.27, 0.93] (n=5) | 0.56 [0.28, 0.83] (n=6) |
| P0′ · anthropic/claude-sonnet-5-5 | 0.50 [0.00, 1.00] (n=4) | 1.00 [1.00, 1.00] (n=1) | 0.44 [0.00, 1.00] (n=3) | 0.67 [0.43, 0.86] (n=7) | 0.67 [0.25, 1.00] (n=4) | 0.67 [0.33, 0.93] (n=5) | 0.50 [0.17, 0.83] (n=6) |

### Confusion matrices (expected rows × predicted columns, every run)

**P0 · anthropic/claude-sonnet-5-5**

| expected \ predicted | implemented | partial | gap | could-not-verify |
|---|---|---|---|---|
| implemented | 8 | 4 | 0 | 0 |
| partial | 0 | 9 | 5 | 1 |
| gap | 0 | 7 | 10 | 1 |

**P0′ · anthropic/claude-sonnet-5-5**

| expected \ predicted | implemented | partial | gap | could-not-verify |
|---|---|---|---|---|
| implemented | 8 | 4 | 0 | 0 |
| partial | 0 | 10 | 5 | 0 |
| gap | 0 | 7 | 9 | 2 |

## Paired comparison

> At 15 items and a hit rate near 0.5 the standard error is about 12.9 points per arm, so a gap needs roughly 26 to 36 points to be significant. A smaller difference is reported as "no measurable difference", not as a win.

| Arm vs baseline | Δ accuracy [95% CI] | bootstrap p | McNemar (arm only / baseline only) | McNemar p | Reading |
|---|---|---|---|---|---|
| P0′ vs P0 | +0.00 [-0.09, 0.09] | 1.000 | 2 / 1 | 1.000 | no measurable difference |

## Per requirement

Predictions per run: I implemented, P partial, G gap, ? could not verify.

| Item | Expected | P0 · anthropic/claude-sonnet-5-5 | P0′ · anthropic/claude-sonnet-5-5 |
|---|---|---|---|
| FX-01 | partial | PPP | PPP |
| FX-02 | partial | GPG | GPP |
| FX-03 | implemented | PII | IIP |
| FX-04 | implemented | III | III |
| FX-05 | implemented | III | III |
| FX-06 | gap | GGG | GGG |
| FX-07 | gap | PGP | PPP |
| FX-08 | partial | PPP | PPP |
| FX-09 | gap | GGG | GGG |
| FX-10 | partial | ?GG | GGG |
| FX-11 | gap | PGP | PGG |
| FX-12 | partial | PPG | PPG |
| FX-13 | gap | PPP | PPP |
| FX-14 | gap | ?GG | ?G? |
| FX-15 | implemented | PPP | PPP |
