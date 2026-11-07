---
issue: 1868
section: Added
---

- The database can now hold a workspace's governing documents (company policies,
  a customer's copy of SOC 2 criteria), their revisions, the rules extracted from
  each revision and every rule's edit history, behind a new
  `GOVERNING_DOCS_ENABLED` setting that is off by default. Nothing reads or
  writes these tables yet: upload, rule extraction and the checks against
  requirements follow in later releases.
