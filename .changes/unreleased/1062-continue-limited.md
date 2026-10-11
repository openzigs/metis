---
issue: 1062
section: Fixed
---

- When "Continue with a larger budget" is also cut short, the analysis banner now says so:
  "The rerun was also cut short: X of Y requirements unreached."
- Continue can be used once per code pass; regenerating the code agent makes it available
  again. Past the limit the banner shows why it is no longer offered, and the server refuses
  another continuation with `409 CODE_INVESTIGATION_CONTINUE_LIMIT`.
