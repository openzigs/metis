---
issue: 608
section: Fixed
---

- An mcp.json import entry whose server row was saved before a later step failed is now reported
  as created, with the landed server's id and the failure as a warning, instead of only as an
  error, and the import answers 207. Retrying it no longer hits `LABEL_TAKEN` with no sign the
  server exists.
