---
issue: 1311
section: Fixed
---

- If you change a draft's labels but not its text, publishing it again now
  updates the labels on its GitHub issue. Before, the change showed up as
  drift. METIS records the labels it sends each issue. Issues published before
  this change get that record at their next publish.
- The user guide now says that when METIS updates an issue's labels it sends
  the whole set, so labels added by hand on GitHub are removed.
- A Jira-only publish batch is no longer marked completed when its drafts
  failed. It records how many drafts were published and how many failed. It
  is marked failed when more than half failed, or when METIS could not record
  an issue Jira had just created. In that case the batch stops at that draft
  and names the issue. The Jira batch audit entry is now written in that case
  too.
- An Additional label can no longer contain an invisible character such as a
  zero-width space, so two labels that look identical cannot differ.
