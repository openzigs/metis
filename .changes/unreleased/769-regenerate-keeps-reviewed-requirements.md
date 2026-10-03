---
issue: 769
section: Fixed
---

- Regenerating an agent no longer deletes your reviewed requirements. When a requirement has
  been approved, edited, linked, mapped to data, pinned in a baseline, put under review, commented
  on or assigned, a later re-synthesis keeps the set (and every baseline's pins) instead of
  replacing it. A degraded (keyword-fallback) synthesis no longer overwrites a successful one either.
  The analysis page now says when a re-synthesis was not applied, and why.
