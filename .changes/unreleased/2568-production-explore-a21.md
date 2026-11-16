---
issue: 2568
section: Added
---

- `pnpm eval:localization` adds the arm `A21`, production's explore-mode code pass at
  production's limits; a test proves it runs what the orchestrator runs. Agent arms' reports
  now count passes a limit cut short, budget share, cache reads and repeated tool calls.
- `pnpm eval:code-pass-live --mode explore|fast` times and prices one live five-requirement
  analysis. Measured on Miniflux, explore found more of the files a change edits (Recall@5
  +0.18) at $0.128 against $0.066 per requirement. The fixture portfolio was not measured
  within the $5 cap, so the default stays `fast` (`eval-data/README.md`).
