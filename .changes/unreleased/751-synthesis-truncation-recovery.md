---
issue: 751
section: Fixed
---

- Requirement synthesis no longer loses requirement types and acceptance criteria when a reasoning model such as DeepSeek runs out of output room. METIS keeps every requirement the model finished, asks again only for the findings still uncovered (splitting the set if needed), and groups by keyword only the findings it could not reach.
- When only some findings had to be grouped by keyword, the **Requirement synthesis was degraded** notice now says how many requirements the model wrote and how many were grouped, instead of saying every requirement is untyped.
- Data-mapping suggestions send an explicit output limit (at least 8192 and never below the provider's own default; `DATA_MAPPING_SUGGEST_MAX_OUTPUT_TOKENS` overrides it) and retry a cut-off batch as two smaller ones instead of skipping it.
