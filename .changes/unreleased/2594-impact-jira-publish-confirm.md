---
issue: 2594
section: Changed
---

- "Publish to Jira" on an impact analysis now asks before it sends anything. A
  confirmation names the Jira project and site, the METIS project the issue is
  created through, how many issues will be created and the issue title. Nothing
  reaches Jira until you click the confirm button. When no project in the run
  has Jira set up, the confirmation says so and offers nothing to confirm.
- A run published before says so in the confirmation and links the issue.
  Publishing it again creates no new Jira issue: it returns the existing one.
