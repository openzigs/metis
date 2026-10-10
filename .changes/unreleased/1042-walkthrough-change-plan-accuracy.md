---
issue: 1042
section: Added
---

- The walkthrough now scores change plans on precision and recall. `TEST_PLAN.md` holds a
  reference change set for each of the three Miniflux developer issues (Miniflux 4511 from the two
  open upstream PRs, 4478 and 4336 curated), with the scoring rule and a worked example;
  waves E and F return a fixed precision/recall table; `run.json` accepts an optional
  `changePlanAccuracy` list of counts, and the run-report deck shows it as a
  "Change-plan accuracy" slide.
