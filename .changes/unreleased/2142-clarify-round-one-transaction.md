---
issue: 2142
section: Fixed
---

- Submitting clarification answers now saves the answers and the refined requirements together,
  or neither. Before, a failure between the two writes could use up the round without updating
  the requirements, and the round could not be answered again.
- Opening the Questions tab while the same dialog is being changed somewhere else no longer
  overwrites that change. The panel shows the round that was actually saved.
- When a CSV import is refused because the round was already answered, the message now matches
  the one shown for a refused submit: "This round was already answered. Showing the current
  questions."
