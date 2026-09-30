---
issue: 474
section: Fixed
---

- The Workbench Documents panel files each document by the source that wrote it, not by its
  filename: an upload named like `jira:ABC-1` now stays under Uploaded, and a Jira or repository
  sync no longer overwrites an upload that happens to share its filename. Confluence pages are
  listed by their page title instead of "Page <id>" (existing pages pick up the title on their
  next sync). When two repositories are unnamed, an attached-document chip now shows the same
  "Unnamed repository 2" as the panel group its file sits in.
