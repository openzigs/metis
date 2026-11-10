---
issue: 1891
section: Fixed
---

- When the same code is linked to a requirement twice, its traceability chain now keeps the
  link known to be current: a code-agent link found out of date no longer hides the automatic
  mapping's link to the same code, and two equally sure links always resolve the same way.
- The similar-requirements panel lists each file and symbol of a similar requirement's saved
  code links once, preferring a current link, so a repeat no longer takes one of its 20 places.
