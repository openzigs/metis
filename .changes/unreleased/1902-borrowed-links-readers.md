---
issue: 1902
section: Fixed
---

- A code link borrowed from a similar requirement no longer counts as the requirement's own
  code anywhere it cannot be shown as borrowed. "Tested by", the untested-requirements list and
  the workspace traceability summary leave it out, so a borrowed link no longer makes a
  requirement look mapped or tested. The requirement's own code links still show it, labelled,
  but list no test reached through it. On the similar-requirements panel, a similar
  requirement's borrowed links are counted apart ("4 code links: 2 fresh, 1 stale, 1
  borrowed"), and the duplicate warning counts only the files it links of its own.
- When "Start from these citations" collides with another copy into the same requirement every
  time it tries, it now says nothing was copied and to try again, instead of a generic error.
