---
issue: 1998
section: Fixed
---

- "Analyze remaining repositories" no longer counts a repository's code findings twice. When a
  regenerate had left out a repository that an earlier run analysed, resuming it added the new
  findings next to the old ones. Now the old ones are replaced once the resumed pass finishes,
  and a resume that fails keeps them.
