---
issue: 778
section: Fixed
---

- Docs generation: a section whose module facts exceed the facts cap now reads every module. The top-ranked modules stay in full and the rest are sent as condensed digests within the same cap, so no extra tokens are spent. Previously all but 3–14 of 103 modules were dropped to a name-only list. `facts-truncated` is now raised only when even a minimal digest does not fit.
