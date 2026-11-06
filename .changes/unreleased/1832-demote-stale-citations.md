---
issue: 1832
section: Changed
---

- With `IMPACT_AGENT_SEEDS` on, impact analysis no longer puts a saved code link that has gone out of
  date at the top of the files to edit. Links checked against the current code come first, then
  links that moved, then links not checked yet. The run's summary says how many out-of-date links
  were set aside. A file the code search finds on its own is still listed where the search ranked
  it.
