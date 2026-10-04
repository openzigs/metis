---
issue: 751
section: Fixed
---

- Requirement synthesis no longer loses requirement types and acceptance criteria when a reasoning model such as DeepSeek runs out of output room. METIS keeps every requirement the model finished, asks again only for the findings still uncovered (splitting the set if needed), and groups by keyword only the findings it could not reach.
