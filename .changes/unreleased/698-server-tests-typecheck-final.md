---
issue: 698
section: Changed
---

- Every server test now type-checks cleanly against the measurement config. `ChunkSweepOptions` accepts
  the arm collaborators the sweep already passed through, and `ReqMapThresholds` accepts any numeric
  floors. Emitted JavaScript is unchanged.
