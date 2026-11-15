---
issue: 2549
section: Fixed
---

- Chat no longer tells you a retrieved document "contained an instruction" it does not hold. The
  excerpts it is shown now end at a marked boundary, so the model's own tool-calling instructions,
  which the provider places straight after them, are never read as part of the last document.
- A chat opened from a change request or a requirement now knows which analysis run it is about,
  so it no longer answers "I couldn't tell which of the analysis runs" this is.
- Signing in on a browser that was still signed in as someone else now always leaves you signed in
  as the account you just used: the earlier session ends, and a session refresh that was already
  under way can no longer put it back.
