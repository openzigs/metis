---
issue: 803
section: Removed
---

- The AI bug scanner (Bug Scans, Bug Rules, the per-repository scanner page) is
  removed. Use a dedicated SAST tool such as CodeQL or Semgrep. Deep Dive and
  the code agent still find code issues. Existing scan data is kept for now and
  removed in a later release.
