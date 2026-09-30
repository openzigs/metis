---
issue: 547
section: Fixed
---

- A file uploaded before connector-style names were refused, such as one named `jira:ABC-1` or
  `connector:repo:…`, is no longer treated as repository, database or generated evidence.
  Document generation, data-mapping suggestions, chat and Spec Kit context and the document lists now
  tell such an upload apart from a real connector document by where it came from rather than by
  its name. Operators can list any remaining uploads with such names by running
  `pnpm --filter @metis/server documents:reserved-uploads`, then re-upload them under new names.
- The reserved-upload report now also neutralises bidirectional-override and zero-width
  characters in filenames, so a name cannot reorder or hide part of a terminal line.
