---
issue: 1240
section: Fixed
---

- When chat withholds a tool that needs approval, the model can no longer reach
  a different tool by spelling the withheld one with `-` instead of `_` (or the
  reverse). A refused call to a withheld tool is audited under the tool's own
  name, not the model's spelling of it.
