---
issue: 2451
section: Fixed
---

- Answering a clarifying question now counts. When a requirement had several
  open questions about the same part of it, an answer was credited to none of
  them, so the count of open questions never fell, the next round asked the
  answered questions again, and the checkpoint card still listed them as open.
  Each answer now closes the one question it was about.
- The Clarifying Questions panel, the Summary, the step chip and the tab show
  the same number of open questions. Before, the panel counted the questions on
  screen (13) and everything else counted the open questions (12).
- A change request's settings line says "Clarifying questions: on" from the
  moment the run starts. Until part-way through the run it said "off".
