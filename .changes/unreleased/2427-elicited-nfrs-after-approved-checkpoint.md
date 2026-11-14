---
issue: 2427
section: Fixed
---

- A run whose checkpoint you had already approved no longer saves draft requirements the
  checkpoint never showed. This happened when you approved the checkpoint before the run
  finished, or reran an approved analysis. The non-functional requirements the analysis
  elicited were saved as drafts beside the approved set, and one you had rejected at the
  checkpoint could come back. They now reopen the checkpoint, marked **Found by the analysis ·
  Non-functional**. Only the ones you approve there are saved, and one you rejected stays out.
- A rerun replaces the elicited requirements an earlier run listed that you have not decided
  yet, instead of adding more, and the checkpoint's "awaiting approval" count now counts only
  the requirements still undecided.
