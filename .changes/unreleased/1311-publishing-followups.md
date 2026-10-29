---
issue: 1311
section: Fixed
---

- If you change a draft's labels but not its text, publishing it again now
  updates its GitHub issue's labels. Before, the change showed as drift.
- A Jira-only publish batch with failed drafts is no longer marked completed
  without comment. It records its counts, and it fails when more than half of
  its drafts failed or when METIS could not record a Jira issue it created.
- An Additional label can no longer hold an invisible character.
