---
issue: 1250
section: Security
---

- Attaching a repository connection to a product now requires access to the
  connection's own project. A connection from another workspace is refused as
  if it did not exist, and the refusal is audited.
- Starting or re-running an impact analysis from a document now requires
  access to the document's project. Another workspace's document, a deleted
  one and a nonexistent one all get the same "not found".
