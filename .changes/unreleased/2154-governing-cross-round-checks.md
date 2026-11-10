---
issue: 2154
section: Fixed
---

- `eval:governing` corpus checks: a labelling round's consistency pass may only change or keep
  a label on its own items, so an entry that names an item of another round now fails the check
  instead of going unread; `governing-03`'s notes name the right follow-up issue.
