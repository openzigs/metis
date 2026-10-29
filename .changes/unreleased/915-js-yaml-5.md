---
issue: 915
section: Changed
---

- The server's YAML parsing moves to js-yaml 5. PR-review config, library frontmatter, locale files and spec-kit OpenAPI contracts parse the same as before: an empty file is still "no document", schemas stay safe (no JS types), and `<<` merge keys still work in contracts. A date-looking value in a generated contract now stays text instead of becoming a timestamp.
