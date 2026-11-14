---
issue: 2311
section: Fixed
---

- When the governing check could not decide any requirement, the Governing rules panel no longer
  lists edited requirements as "not yet checked" under its "Governing rules were not checked"
  message. The BRD no longer drops the start of a re-checked requirement's wording when the
  requirement was renamed to a shorter title: "Login flow" renamed to "Login" printed "flow …".
  The title is left out only when it is the wording's whole first line. Closing the page right
  after asking for **Re-check this requirement** now cancels it before any model call. An answer
  to a clarifying question about a requirement deleted since it was re-checked no longer settles
  that requirement's rules or re-runs its findings.
