---
issue: 1352
section: Fixed
---

- A planned BRD reserves room for the footnotes it will cite (pinned lines,
  canonical facts, excerpts), so a model writing to its plan is not cut at
  section ends: on the 2026-10-21 DeepSeek run the plan is 234,031 for a
  234,277 body (was 244,231); 32 minor topics are planned out instead of 8.
- When the document budget binds, single-call sections are told their planned
  length, corrected by the model's overrun. Upgrading rewrites a planned BRD's
  sections once (about $1 on DeepSeek); with the topic plan off, unchanged.
