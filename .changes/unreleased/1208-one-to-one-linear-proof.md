---
issue: 1208
section: Changed
---

- Performance: matching requirements one-to-one (promotion's title fallback and clarification attribution) now proves which pairs are forced in near-linear time instead of re-matching once per pair. A large set of equally close titles is resolved in milliseconds instead of seconds (300 × 300 went from 7.3 s to about 12 ms), with identical results, so the 2,500-candidate limit on clarification attribution is removed.
