---
issue: 2209
section: Fixed
---

- A discussion's requirement search answers from the database in one query, so typing a rare word
  in a project with thousands of requirements no longer reads every one of them on each keystroke,
  and a `%` or `_` in the search box matches only itself.
- While the requirement search is still answering a new search term, it says "Searching…" rather
  than briefly claiming that no requirement title matches.
- The requirement search's suggestions can be moved through with the arrow keys and picked with
  Enter, and screen readers announce the highlighted suggestion and when the list is updating.
