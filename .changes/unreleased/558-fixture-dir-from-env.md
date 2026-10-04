---
issue: 558
section: Fixed
---

- A provider built from an explicit environment now reads its record/replay fixture directory
  (`AI_FIXTURE_DIR`) from that environment too, not from the server process's.
