---
issue: 2568
section: Added
---

- `pnpm eval:localization` adds the agent arm `A21`, the analysis code pass that production runs
  in explore mode, with production's turn cap, token budget, transcript limit and dollar ceiling.
  A test checks that it hands the agent loop the same prompt, tools and limits as the
  orchestrator, so the eval and the product cannot drift apart. Each agent arm's report now
  counts the passes a limit cut short, the tokens used against the budget, the share of cache
  reads and repeated identical tool calls.
- `pnpm eval:code-pass-live --mode explore|fast` runs one live analysis with five requirements
  in one code pass on the Miniflux sample project and prints its time, turns and cost.
- Measured on Miniflux (19 requirements, one run, `claude-sonnet-5-5`), explore mode found more
  of the files a change edits than today's pass: Recall@5 +0.18 [0.04, 0.34]. It cost $0.128
  against $0.066 per requirement. The fixture portfolio was not measured within the $5 spend
  cap, so the default stays `fast`. Impact analysis is unchanged
  (`eval-data/README.md`, "Production explore (A21)").
