---
issue: 1869
section: Added
---

- Workspace admins can upload a governing document (a company policy, a
  customer's copy of SOC 2 criteria) once for the whole workspace, add new
  revisions of it and withdraw it; every workspace member can list and read
  them. Each revision is indexed for search in the workspace's own index,
  separate from every project's documents, and only the current revision is
  searched by default. Behind the `GOVERNING_DOCS_ENABLED` setting, which is
  still off by default; nothing in analysis reads these documents yet.
