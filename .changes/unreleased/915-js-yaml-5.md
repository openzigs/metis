---
issue: 915
section: Changed
---

- The server's YAML parsing moves to js-yaml 5 and keeps js-yaml 4's behaviour where it matters: an empty file is still "no document", a blank `model:` or `version:` in skill or agent frontmatter is still rejected, and `<<` merge keys still work in spec-kit contracts. A date-looking value in a generated contract now stays text, and a parsed YAML document may use at most 64 aliases (`*ref`).
