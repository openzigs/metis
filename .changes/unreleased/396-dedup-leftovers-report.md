---
issue: 396
section: Added
---

- A read-only report, `pnpm --filter @metis/server publishing:dedup-leftovers`, lists what the
  issue-draft duplicate cleanup left for you to decide: duplicate drafts it retired that had
  already been published (with the GitHub or Jira issue to close if you do not want it), and
  drafts whose parent epic was retired. It changes nothing; add `-- --json` for machine-readable
  output. Retired drafts keep their link to the issue they published, so that issue is still
  attributed to the text it was created from.
