---
issue: 577
section: Security
---

- Creating, editing, re-binding or importing an MCP server now binds each `${vault:...}` reference
  to exactly the secret the ownership check approved, resolved once. Previously the binding looked
  the label up again after the check, so a secret deleted and re-created by another user under the
  same label in between could be bound without being checked. The write no longer looks a label up
  at all: a reference the check did not approve is refused.
- In an `mcp.json` import, an entry whose reference is unresolved or ambiguous still fails alone
  (207); its `errors` entry now carries the `code` (`VAULT_REF_UNRESOLVED` / `VAULT_REF_AMBIGUOUS`).
