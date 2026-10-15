---
issue: 1098
section: Fixed
---

- An analysis started from imported items now gives the code agent those items, each once and
  first. A document requirement that restates an imported item is merged into it, even when the
  imported item is only a short tracker title. Document requirements that restate no imported item
  are no longer investigated by the code agent on such a run (run an ordinary analysis for them), so
  the imported items no longer lose the code agent's budget to unrelated features. Regenerating the
  code agent and resuming skipped repositories use the same set.
