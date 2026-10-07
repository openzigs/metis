---
issue: 750
section: Changed
---

- `safeFetch` now builds its DNS-pinned connection through the same `makePinnedLookup` as every
  other pinned transport (moved to `server/src/lib/net/pinned-lookup.ts`), so a fix to one can no
  longer miss the other; a test fails if a second pinned-lookup implementation reappears.
