---
issue: 1063
section: Fixed
---

- The code agent's two recovery calls no longer spend their whole output limit
  reasoning and return nothing (new setting `ANALYSIS_RECOVERY_REASONING`,
  default `auto`); when nothing is recovered, the agent's notes now say why.
- Affected code: a symbol is shown as linked only when its name (not its file
  path) shares two of the requirement's terms, so "terminate all sessions" no
  longer maps to a Telegram button class. "No code matched" is shown instead of
  a weak guess. The code agent's own starting points are unchanged.
- Requirements from imported items show the imported title and a link back, or
  "Added by the analysis" (new nullable column `requirements.sourceCandidateIds`).
