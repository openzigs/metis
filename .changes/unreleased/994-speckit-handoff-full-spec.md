---
issue: 994
section: Fixed
---

- Starting an analysis from a Spec Kit feature no longer sends only the first 4 KB of `spec.md`,
  cut mid-sentence. It now sends the spec's acceptance criteria, each with its Given/When/Then,
  and its non-functional requirements, one per paragraph, so each becomes one requirement of the
  analysis. A requirement that does not fit is left out whole, and the analysis page itself names
  the requirements sent and any left out, and lists the other artifacts (plan.md, tasks.md,
  constitution.md) as not sent, while the run is going and afterwards. The analysis Outcome card now states how many requirements were stored for the run,
  and corrects a summary that counted them differently, except while approval withholds them.
