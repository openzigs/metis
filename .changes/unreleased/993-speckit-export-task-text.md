---
issue: 993
section: Fixed
---

- Spec Kit issue export keeps each task's full text. Issue titles are no longer cut at the first
  `(`, so a title that names a `file:line` span or a function call comes through whole; only the
  trailing `depends-on`, `satisfies`, `[P]` and `files:` metadata is left out. Each issue body now
  carries the task as written in `tasks.md`, with any indented lines beneath it, and the spec
  criteria it satisfies. After a dry run you can choose which tasks to export, so a large feature
  can be published in parts, and after publishing the toast and the result card link the issues
  that were created.
