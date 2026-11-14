---
issue: 2509
section: Fixed
---

- Opening the Questions tab of an analysis no longer runs the model. The tab lists the gaps the run
  found and offers **Ask these questions**; the clarifying questions are prepared, and charged to
  the run, only when you press it. Before, opening the tab of a finished run raised its cost.
- The portfolio check now shows the model each retrieved code excerpt whole. It was shown the first
  1,500 characters of each 2,048-character excerpt, so a field near the end of one (such as
  `reading_time` in Miniflux's entry model) was never seen and a product that has it read
  "Not checked: the evidence could not be verified".
- A requirement is no longer linked to code that a finding cited while saying it could not verify
  the requirement (for example the Go client cited for a Python client requirement). The Approvals
  tab's "no code evidence" mark follows the same rule.
- The workspace traceability column "Spec coverage" is now "In a generated spec", and the note under
  it says a Spec Kit feature is not counted, so 0% no longer reads as "nothing specified".
- A spec started from requirements says its acceptance criteria ids are its own, not the labels the
  original request used.
- "Start Spec Kit feature" says when it could not check whether Spec Kit is on, instead of looking
  as if it were on.
