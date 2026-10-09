---
issue: 953
section: Added
---

- Spec Kit can now publish a feature's tasks as real GitHub issues. Pick the GitHub token
  from the vault, run the dry run, and **Publish** creates exactly the issues it listed.
- Publishing goes only to the project's configured target, never the analysed repository
  or its upstream, and is refused if `tasks.md` changed since the dry run.
- One export creates at most `SPECKIT_EXPORT_MAX_ISSUES` issues (default 50). Exports are
  rate-limited and audited. A second concurrent export of the same feature is refused
  rather than filing duplicate issues.
