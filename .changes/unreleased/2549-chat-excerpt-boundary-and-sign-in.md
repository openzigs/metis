---
issue: 2549
section: Fixed
---

- Chat's retrieved document excerpts now end at a marked boundary, so text the provider adds
  after them is not read as part of the last document. Chat once told a user a document
  "contained an instruction" it does not hold, and this is the likely cause.
- A chat opened from a change request or a requirement now knows which analysis run it is about,
  so it no longer answers "I couldn't tell which of the analysis runs" this is.
- Signing in on a browser that was still signed in as someone else now leaves you signed in as
  the account you just used. The earlier session ends as a sign-out would end it, live
  connections included. A refresh of it that is still under way in the same tab is waited for,
  and its failure no longer signs the new account out.
