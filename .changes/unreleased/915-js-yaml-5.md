---
issue: 915
section: Changed
---

- The server's YAML parsing moves to js-yaml 5, with js-yaml 4's behaviour kept where it matters: an empty file is still "no document", a blank value such as `model:` or `version:` in skill or agent frontmatter is still rejected rather than saved as empty text, locale files resolve values as before, and `<<` merge keys still work in spec-kit contracts. Two things differ: a date-looking value in a generated contract stays text instead of becoming a timestamp, and a YAML document the server parses may now use at most 64 aliases (`*ref`).
