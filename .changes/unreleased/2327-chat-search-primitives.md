---
issue: 2327
section: Added
---

- Chat can be given sharper code-search tools with `CHAT_CODE_SEARCH_PRIMITIVES=true` (off by
  default): `grep_files` finds an exact text in the project's repository files, `list_files`
  lists files matching a pattern, and a symbol search can be narrowed by path, kind and
  language. Every result is capped and says how many more there were. Paths cannot leave the
  repository, `.env`, `.git` and credential files are never read, and a file restricted to
  other people is never shown or counted. Measured against the code-search tools alone, they
  used about 25% more input tokens on the BA question set with no measurable gain, so they
  stay off.
- `pnpm eval:ba-qa` adds the arm `tools-primitives` and records the tools each session called;
  `pnpm eval:localization` adds the agent arm `A3P`.
