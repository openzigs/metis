---
issue: 1871
section: Added
---

- A **Governing documents** tab on a workspace lists the workspace's policies and control
  frameworks: each one's current revision, effective date, whether its rules have been
  extracted (and why not, if extraction failed), how many rules it has, and how many were
  dropped because their quoted clause was not in the document. Select a document to see its
  rules; expand a rule to read the exact clause it comes from. A workspace owner or admin can
  upload a document or a new revision, retry a failed extraction, and edit or remove a rule;
  every other member can read everything. The tab appears only when the
  `GOVERNING_DOCS_ENABLED` setting is on, which it is not by default.
