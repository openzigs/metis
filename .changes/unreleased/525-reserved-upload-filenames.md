---
issue: 525
section: Fixed
---

- Uploading a file whose name starts with a prefix that connector and generated documents use
  (`connector:`, `repo:`, `jira:`, `confluence:`, `generated-doc-` or `live-schema:`) is now
  refused with a clear message asking you to rename it, so an upload can no longer be mistaken
  for repository, database, Jira, Confluence, generated or live-schema evidence. A title that
  only resembles one in a different case, such as `Jira: sprint 12 retro.md`, is still accepted. Analyses and document generation now tell
  connector documents from uploads by where they came from rather than by their name, and a
  markdown upload that was named like a generated document is listed as an upload again.
