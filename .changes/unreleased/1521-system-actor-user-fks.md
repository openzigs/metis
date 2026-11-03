---
issue: 1521
section: Fixed
---

- A scheduled repository or database refresh now creates the new connector documents it finds
  instead of reporting them as failures. They are attributed to the connector's creator, or the
  project's creator when the connector has none. Skills and agents found by library auto-discover
  at startup now import, with no creator recorded, instead of failing.
