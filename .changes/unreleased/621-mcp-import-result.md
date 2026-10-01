---
issue: 621
section: Fixed
---

- Settings → MCP → Import / Export now shows what an import did: the servers it registered, any
  saved with a warning (with the warning's message and code), and the entries that failed (with
  their message and code). An import where some entries failed or warned reads as a partial
  success, and one where every entry failed reads as a failure, rather than all looking alike.
