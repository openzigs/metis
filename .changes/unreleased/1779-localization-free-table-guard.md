---
issue: 1779
section: Fixed
---

- `pnpm eval:localization --table-guard` with several arms, or over a second corpus near the
  dollar cap, no longer stops before a table-precision guard that costs nothing (A0's memoised
  reading, or an arm with no guard run). The pooled report now sizes its detectable gap on the
  paired items and says which corpus stopped early, and a bare `--runs` or `--budget` is refused
  instead of falling back to the default.
