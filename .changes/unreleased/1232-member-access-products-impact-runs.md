---
issue: 1232
section: Fixed
---

- Workspace members now see and open the products, impact analyses, agent runs
  and cross-project impact of their workspace's projects, not only the ones they
  created. Edits still need the role permission, so a reader can look but not
  change anything.
- A disabled, deprovisioned or removed member no longer reaches a product by id
  with a token minted before the change; membership is read live.
